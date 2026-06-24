/**
 * TradeIntentService — HITL paper trade-execution layer.
 *
 * The LLM emits a decision (plugin decision.emit_trade_intent). This service:
 *   1. Persists it as a TradeIntent (status=pending).
 *   2. Waits for human approval or rejection.
 *   3. On approval, executes in PAPER mode against a virtual portfolio stored
 *      in the Portfolio table under name="paper".
 *   4. Records fill_price, quantity, realized_pnl, and result_json.
 *
 * REAL-MONEY EXECUTION IS HARD-DISABLED.
 * Any intent with mode != "paper" will throw before touching the portfolio.
 * This is intentional and must not be removed without a security review.
 *
 * Paper portfolio storage: Portfolio model, name="paper", data=JSON PaperState.
 * This reuses the existing Portfolio table (keyed by name) and avoids a new table.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderGatewayService } from '../providers/provider-gateway.service';

// ── Types ─────────────────────────────────────────────────────────────────────

const VALID_ACTIONS = ['long', 'short', 'exit', 'hold'] as const;
type TradeAction = (typeof VALID_ACTIONS)[number];

export interface PaperPosition {
  symbol: string;
  quantity: number;
  avg_price: number;
}

export interface PaperState {
  equity: number;
  cash: number;
  positions: PaperPosition[];
}

/** Default capital for the shared paper portfolio if it doesn't exist yet. */
const PAPER_PORTFOLIO_INITIAL_CAPITAL = 10_000;
const PAPER_PORTFOLIO_NAME = 'paper';

/** Fraction of available cash used per long entry. */
const SIZING_PCT = 0.05;

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class TradeIntentService {
  private readonly log = new Logger(TradeIntentService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly gateway: ProviderGatewayService,
  ) {}

  // ── recordIntent ─────────────────────────────────────────────────────────────

  /**
   * Persists a new TradeIntent in status=pending.
   * Validates action (must be long|short|exit|hold) and confidence ([0,1]).
   * Never touches the portfolio — that happens only on approve().
   */
  async recordIntent(dto: {
    cycle_id?: string;
    symbol: string;
    action: string;
    confidence: number;
    rationale: string;
    timeframe?: string;
  }) {
    if (!VALID_ACTIONS.includes(dto.action as TradeAction)) {
      throw new Error(
        `Invalid action "${dto.action}". Must be one of: ${VALID_ACTIONS.join(', ')}`,
      );
    }
    if (!isFinite(dto.confidence) || dto.confidence < 0 || dto.confidence > 1) {
      throw new Error(
        `Invalid confidence ${dto.confidence}. Must be a number in [0, 1].`,
      );
    }

    return this.db.tradeIntent.create({
      data: {
        cycle_id: dto.cycle_id ?? null,
        symbol: dto.symbol,
        action: dto.action,
        confidence: dto.confidence,
        rationale: dto.rationale,
        timeframe: dto.timeframe ?? '1d',
        mode: 'paper',
        status: 'pending',
      },
    });
  }

  // ── list / listPending ────────────────────────────────────────────────────────

  /** Lists all TradeIntents, optionally filtered by status, newest first. */
  async list(status?: string) {
    return this.db.tradeIntent.findMany({
      where: status ? { status } : undefined,
      orderBy: { created_at: 'desc' },
    });
  }

  /** Convenience: returns only pending intents. */
  async listPending() {
    return this.list('pending');
  }

  // ── approve ───────────────────────────────────────────────────────────────────

  /**
   * Approves a pending TradeIntent and executes it in PAPER mode.
   *
   * Hard guards (throw before any portfolio mutation):
   *   - mode != "paper"  → Error("real-money execution is disabled")
   *   - status != "pending" → Error("TradeIntent ti_xxx is not pending …")
   *
   * Fail-soft: if getQuote fails, sets status=failed with reason in result_json.
   * Never throws to the caller beyond the two hard-guard cases above.
   *
   * Paper execution:
   *   - "long"  → buy floor(cash * SIZING_PCT / fill_price) shares
   *   - "short" → no real short-selling in paper mode; recorded as executed with qty=0
   *   - "exit"  → close entire position; computes realized_pnl = (fill - avg) * qty
   *   - "hold"  → no position change; recorded as executed
   */
  async approve(id: string, decided_by: string) {
    const intent = await this.db.tradeIntent.findUnique({ where: { id } });
    if (!intent) throw new Error(`TradeIntent ${id} not found`);

    // HARD GUARD: real-money execution is intentionally not wired.
    if (intent.mode !== 'paper') {
      throw new Error(
        `real-money execution is disabled. Only mode="paper" is supported. ` +
          `Received mode="${intent.mode}" for intent ${id}.`,
      );
    }

    if (intent.status !== 'pending') {
      throw new Error(
        `TradeIntent ${id} is not pending (current status: ${intent.status}). ` +
          `Only pending intents can be approved.`,
      );
    }

    // Load the shared paper portfolio (create with defaults if missing).
    const portfolioRow = await this.db.portfolio.findUnique({
      where: { name: PAPER_PORTFOLIO_NAME },
    });
    const state: PaperState = portfolioRow
      ? (JSON.parse(portfolioRow.data) as PaperState)
      : {
          equity: PAPER_PORTFOLIO_INITIAL_CAPITAL,
          cash: PAPER_PORTFOLIO_INITIAL_CAPITAL,
          positions: [],
        };

    // Fetch live quote (fail-soft on error).
    let fillPrice: number;
    try {
      const quote = await this.gateway.getQuote(null, intent.symbol);
      fillPrice = quote.last;
    } catch (err) {
      this.log.warn(`approve ${id}: getQuote failed for ${intent.symbol} — ${String(err)}`);
      const updated = await this.db.tradeIntent.update({
        where: { id },
        data: {
          status: 'failed',
          decided_at: new Date(),
          decided_by,
          result_json: JSON.stringify({ error: String(err) }),
        },
      });
      return updated;
    }

    if (!isFinite(fillPrice) || fillPrice <= 0) {
      const updated = await this.db.tradeIntent.update({
        where: { id },
        data: {
          status: 'failed',
          decided_at: new Date(),
          decided_by,
          result_json: JSON.stringify({ error: `Invalid fill price: ${fillPrice}` }),
        },
      });
      return updated;
    }

    // Execute the trade in-memory.
    const { quantity, realized_pnl, newState } = this._executePaper(
      intent.action as TradeAction,
      intent.symbol,
      fillPrice,
      state,
    );

    // Persist updated portfolio state.
    await this.db.portfolio.upsert({
      where: { name: PAPER_PORTFOLIO_NAME },
      create: {
        name: PAPER_PORTFOLIO_NAME,
        data: JSON.stringify(newState),
      },
      update: {
        data: JSON.stringify(newState),
      },
    });

    // Persist result on the TradeIntent row.
    const updated = await this.db.tradeIntent.update({
      where: { id },
      data: {
        status: 'executed',
        fill_price: fillPrice,
        quantity,
        realized_pnl: realized_pnl ?? null,
        decided_at: new Date(),
        decided_by,
        result_json: JSON.stringify({
          fill_price: fillPrice,
          quantity,
          realized_pnl,
          portfolio_equity: newState.equity,
          portfolio_cash: newState.cash,
        }),
      },
    });

    return updated;
  }

  // ── reject ─────────────────────────────────────────────────────────────────────

  /**
   * Rejects a pending TradeIntent.
   * Throws if the intent is not in pending status.
   */
  async reject(id: string, decided_by: string, reason: string) {
    const intent = await this.db.tradeIntent.findUnique({ where: { id } });
    if (!intent) throw new Error(`TradeIntent ${id} not found`);

    if (intent.status !== 'pending') {
      throw new Error(
        `TradeIntent ${id} is not pending (current status: ${intent.status}). ` +
          `Only pending intents can be rejected.`,
      );
    }

    return this.db.tradeIntent.update({
      where: { id },
      data: {
        status: 'rejected',
        decided_at: new Date(),
        decided_by,
        reject_reason: reason,
      },
    });
  }

  // ── Paper execution logic ─────────────────────────────────────────────────────

  /**
   * Applies a paper trade to the virtual portfolio state (pure function except for state mutation).
   * Returns the executed quantity, any realized_pnl (for exit), and the updated state.
   *
   * "long"  → buy floor(cash * SIZING_PCT / fill_price) shares; avg_price cost-basis.
   * "exit"  → close entire existing position; realized_pnl = (fill - avg) * qty.
   * "short" → not really executable in simple paper mode; records qty=0, no state change.
   * "hold"  → no trade; qty=0.
   */
  private _executePaper(
    action: TradeAction,
    symbol: string,
    fillPrice: number,
    state: PaperState,
  ): { quantity: number; realized_pnl: number | null; newState: PaperState } {
    // Deep-copy positions so we don't mutate the original.
    const newState: PaperState = {
      equity: state.equity,
      cash: state.cash,
      positions: state.positions.map((p) => ({ ...p })),
    };

    if (action === 'long') {
      const budget = newState.cash * SIZING_PCT;
      const quantity = Math.floor(budget / fillPrice);
      if (quantity <= 0) {
        return { quantity: 0, realized_pnl: null, newState };
      }
      const cost = fillPrice * quantity;
      newState.cash -= cost;

      const existing = newState.positions.find((p) => p.symbol === symbol);
      if (existing) {
        const totalQty = existing.quantity + quantity;
        existing.avg_price =
          (existing.avg_price * existing.quantity + fillPrice * quantity) / totalQty;
        existing.quantity = totalQty;
      } else {
        newState.positions.push({ symbol, quantity, avg_price: fillPrice });
      }

      newState.equity = newState.cash + this._positionsValue(newState.positions, fillPrice, symbol);
      return { quantity, realized_pnl: null, newState };
    }

    if (action === 'exit') {
      const posIdx = newState.positions.findIndex((p) => p.symbol === symbol);
      if (posIdx < 0) {
        // No open position to exit — still executed, just qty=0
        return { quantity: 0, realized_pnl: null, newState };
      }
      const pos = newState.positions[posIdx];
      const quantity = pos.quantity;
      const proceeds = fillPrice * quantity;
      const realized_pnl = (fillPrice - pos.avg_price) * quantity;
      newState.cash += proceeds;
      newState.positions.splice(posIdx, 1);
      newState.equity = newState.cash + this._positionsValue(newState.positions, fillPrice, symbol);
      return { quantity, realized_pnl, newState };
    }

    // "short" and "hold": no portfolio mutation in simple paper mode.
    return { quantity: 0, realized_pnl: null, newState };
  }

  /** Computes total position value using fillPrice for the traded symbol, avg_price for others. */
  private _positionsValue(
    positions: PaperPosition[],
    fillPrice: number,
    tradedSymbol: string,
  ): number {
    return positions.reduce((sum, p) => {
      const price = p.symbol === tradedSymbol ? fillPrice : p.avg_price;
      return sum + price * p.quantity;
    }, 0);
  }
}
