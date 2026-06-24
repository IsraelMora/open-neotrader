/**
 * TradeIntentService — paper trade-execution layer.
 *
 * The LLM emits a decision (plugin decision.emit_trade_intent). This service:
 *   1. Persists it as a TradeIntent (status=pending).
 *   2. If autonomous mode is enabled (KV execution.autonomous != 'false'), immediately
 *      runs through risk gates and executes autonomously.
 *   3. Otherwise waits for human approval or rejection (HITL path).
 *   4. On execution, runs in PAPER mode against a virtual portfolio stored
 *      in the Portfolio table under name="paper".
 *   5. Records fill_price, quantity, realized_pnl, and result_json.
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
import { KvService } from '../common/kv.service';

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
  max_drawdown_pct?: number;
}

export interface ExecutionPolicy {
  autonomous: boolean;
  max_position_pct: number;
  max_open_positions: number;
  max_drawdown_halt_pct: number;
}

/** Default capital for the shared paper portfolio if it doesn't exist yet. */
const PAPER_PORTFOLIO_INITIAL_CAPITAL = 10_000;
const PAPER_PORTFOLIO_NAME = 'paper';

/** Fraction of available cash used per long entry (human-approved path). */
const SIZING_PCT = 0.05;

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class TradeIntentService {
  private readonly log = new Logger(TradeIntentService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly gateway: ProviderGatewayService,
    private readonly kv: KvService,
  ) {}

  // ── recordIntent ─────────────────────────────────────────────────────────────

  /**
   * Persists a new TradeIntent in status=pending.
   * Validates action (must be long|short|exit|hold) and confidence ([0,1]).
   * If execution policy has autonomous=true, immediately calls autoProcess().
   * Otherwise returns the pending intent as-is (HITL path).
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

    const created = await this.db.tradeIntent.create({
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

    const policy = await this._readExecutionPolicy();

    if (policy.autonomous) {
      return this.autoProcess(created.id);
    }

    return created;
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

  // ── autoProcess ───────────────────────────────────────────────────────────────

  /**
   * Autonomous execution path — governed by risk gates from ExecutionPolicy.
   *
   * Hard guards (throw before any portfolio mutation):
   *   - mode != "paper"  → Error("real-money execution is disabled...")
   *   - status != "pending" → Error("TradeIntent ti_xxx is not pending …")
   *
   * Risk gates for opening trades (long/short):
   *   - drawdown >= max_drawdown_halt_pct → circuit breaker, reject
   *   - positions.length >= max_open_positions → max positions reached, reject
   *
   * "exit" always passes risk gates (closing reduces risk).
   * "hold" marks as executed with quantity=0, no quote fetch, no portfolio mutation.
   *
   * Fail-soft on getQuote failure: sets status=failed, no throw.
   */
  async autoProcess(id: string) {
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
          `Only pending intents can be processed.`,
      );
    }

    const policy = await this._readExecutionPolicy();

    // Load the shared paper portfolio (create with defaults if missing).
    const portfolioRow = await this.db.portfolio.findUnique({
      where: { name: PAPER_PORTFOLIO_NAME },
    });
    const paperState: PaperState = portfolioRow
      ? (JSON.parse(portfolioRow.data) as PaperState)
      : {
          equity: PAPER_PORTFOLIO_INITIAL_CAPITAL,
          cash: PAPER_PORTFOLIO_INITIAL_CAPITAL,
          positions: [],
        };

    const action = intent.action as TradeAction;

    // "hold" → executed immediately as no-op, no quote fetch, no portfolio mutation.
    if (action === 'hold') {
      return this.db.tradeIntent.update({
        where: { id },
        data: {
          status: 'executed',
          quantity: 0,
          decided_at: new Date(),
          decided_by: 'autonomous',
          result_json: JSON.stringify({ quantity: 0, reason: 'hold — no position change' }),
        },
      });
    }

    // Risk gate — only for opening trades.
    if (action === 'long' || action === 'short') {
      const { pass, reason } = this._passesAutoRisk(paperState, policy);
      if (!pass) {
        return this.db.tradeIntent.update({
          where: { id },
          data: {
            status: 'rejected',
            decided_at: new Date(),
            decided_by: 'autonomous',
            reject_reason: reason,
          },
        });
      }
    }
    // "exit" always passes — closing a position reduces risk.

    return this._runPaperExecution(id, intent.symbol, action, paperState, 'autonomous', policy.max_position_pct);
  }

  // ── approve ───────────────────────────────────────────────────────────────────

  /**
   * Approves a pending TradeIntent and executes it in PAPER mode (human path).
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

    return this._runPaperExecution(id, intent.symbol, intent.action as TradeAction, state, decided_by, SIZING_PCT);
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

  // ── _readExecutionPolicy ──────────────────────────────────────────────────────

  private async _readExecutionPolicy(): Promise<ExecutionPolicy> {
    const parseNum = (raw: string | null, fallback: number): number => {
      if (raw === null) return fallback;
      const n = Number(raw);
      return isFinite(n) ? n : fallback;
    };

    const [rawAutonomous, rawMaxPosPct, rawMaxOpenPos, rawMaxDrawdown] = await Promise.all([
      this.kv.get('execution.autonomous'),
      this.kv.get('execution.max_position_pct'),
      this.kv.get('execution.max_open_positions'),
      this.kv.get('execution.max_drawdown_halt_pct'),
    ]);

    const autonomous = rawAutonomous !== 'false';

    let max_position_pct = parseNum(rawMaxPosPct, 0.1);
    if (max_position_pct <= 0 || max_position_pct > 1) max_position_pct = 0.1;

    let max_open_positions = Math.round(parseNum(rawMaxOpenPos, 10));
    if (max_open_positions < 1) max_open_positions = 1;

    let max_drawdown_halt_pct = parseNum(rawMaxDrawdown, 25);
    if (max_drawdown_halt_pct <= 0 || max_drawdown_halt_pct > 100) max_drawdown_halt_pct = 25;

    return { autonomous, max_position_pct, max_open_positions, max_drawdown_halt_pct };
  }

  // ── _passesAutoRisk ───────────────────────────────────────────────────────────

  private _passesAutoRisk(
    state: PaperState,
    policy: ExecutionPolicy,
  ): { pass: boolean; reason?: string } {
    const drawdown = state.max_drawdown_pct ?? 0;
    if (drawdown >= policy.max_drawdown_halt_pct) {
      return {
        pass: false,
        reason: `circuit breaker: drawdown ${drawdown}% >= ${policy.max_drawdown_halt_pct}%`,
      };
    }

    if (state.positions.length >= policy.max_open_positions) {
      return {
        pass: false,
        reason: `max open positions reached (${state.positions.length}/${policy.max_open_positions})`,
      };
    }

    return { pass: true };
  }

  // ── _runPaperExecution ────────────────────────────────────────────────────────

  /**
   * Shared paper execution logic used by both approve() and autoProcess().
   * Fetches quote (fail-soft), computes trade, upserts portfolio, updates intent.
   */
  private async _runPaperExecution(
    id: string,
    symbol: string,
    action: TradeAction,
    state: PaperState,
    decided_by: string,
    sizingPct: number,
  ) {
    // Fetch live quote (fail-soft on error).
    let fillPrice: number;
    try {
      const quote = await this.gateway.getQuote(null, symbol);
      fillPrice = quote.last;
    } catch (err) {
      this.log.warn(`autoProcess/approve ${id}: getQuote failed for ${symbol} — ${String(err)}`);
      return this.db.tradeIntent.update({
        where: { id },
        data: {
          status: 'failed',
          decided_at: new Date(),
          decided_by,
          result_json: JSON.stringify({ error: String(err) }),
        },
      });
    }

    if (!isFinite(fillPrice) || fillPrice <= 0) {
      return this.db.tradeIntent.update({
        where: { id },
        data: {
          status: 'failed',
          decided_at: new Date(),
          decided_by,
          result_json: JSON.stringify({ error: `Invalid fill price: ${fillPrice}` }),
        },
      });
    }

    // Execute the trade in-memory.
    const { quantity, realized_pnl, newState } = this._executePaper(
      action,
      symbol,
      fillPrice,
      state,
      sizingPct,
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
    return this.db.tradeIntent.update({
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
  }

  // ── Paper execution logic ─────────────────────────────────────────────────────

  /**
   * Applies a paper trade to the virtual portfolio state (pure function except for state mutation).
   * Returns the executed quantity, any realized_pnl (for exit), and the updated state.
   *
   * "long"  → buy floor(cash * sizingPct / fill_price) shares; avg_price cost-basis.
   * "exit"  → close entire existing position; realized_pnl = (fill - avg) * qty.
   * "short" → not really executable in simple paper mode; records qty=0, no state change.
   * "hold"  → no trade; qty=0.
   */
  private _executePaper(
    action: TradeAction,
    symbol: string,
    fillPrice: number,
    state: PaperState,
    sizingPct = SIZING_PCT,
  ): { quantity: number; realized_pnl: number | null; newState: PaperState } {
    // Deep-copy positions so we don't mutate the original.
    const newState: PaperState = {
      equity: state.equity,
      cash: state.cash,
      positions: state.positions.map((p) => ({ ...p })),
    };

    if (action === 'long') {
      const budget = newState.cash * sizingPct;
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
