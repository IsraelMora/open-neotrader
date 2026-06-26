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
 * REAL-MONEY EXECUTION IS OFF BY DEFAULT.
 * Effective mode is derived from ExecutionPolicy, not the stored intent.mode.
 * Real execution requires: execution.real=true AND execution.broker_plugin_id non-empty.
 * All real orders pass through the same risk gates and a per-order notional ceiling.
 * Every real order attempt is logged at WARN level.
 *
 * Paper portfolio storage: Portfolio model, name="paper", data=JSON PaperState.
 * This reuses the existing Portfolio table (keyed by name) and avoids a new table.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderGatewayService } from '../providers/provider-gateway.service';
import { KvService } from '../common/kv.service';
import { kvBool, kvNum, kvStr } from '../common/kv.util';

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
  /** Only literal 'true' (string) enables real execution. Default false. */
  real: boolean;
  /** Which provider plugin executes real orders. Empty string → paper fallback. */
  broker_plugin_id: string;
  /** Hard ceiling per real order in notional value (qty * price). Default 1000. */
  max_order_notional: number;
}

/**
 * Defaults de la política de ejecución (fallbacks cuando el KV no tiene la clave).
 * Todos son configurables vía KV (`execution.*`), a mano o por el LLM; estos literales
 * son solo el valor por defecto seguro.
 */
const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = {
  autonomous: true,
  max_position_pct: 0.1,
  max_open_positions: 10,
  max_drawdown_halt_pct: 25,
  real: false,
  broker_plugin_id: '',
  max_order_notional: 1_000,
};

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
      throw new Error(`Invalid confidence ${dto.confidence}. Must be a number in [0, 1].`);
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

    if (intent.status !== 'pending') {
      throw new Error(
        `TradeIntent ${id} is not pending (current status: ${intent.status}). ` +
          `Only pending intents can be processed.`,
      );
    }

    const policy = await this._readExecutionPolicy();
    const effectiveMode = this._effectiveMode(policy);

    // Load the shared paper portfolio (create with defaults if missing).
    // Also needed in real mode for exit qty lookup and risk gate state.
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

    if (effectiveMode === 'real') {
      return this._executeReal(
        id,
        intent,
        policy,
        paperState,
        'autonomous',
        policy.max_position_pct,
      );
    }
    return this._runPaperExecution(
      id,
      intent.symbol,
      action,
      paperState,
      'autonomous',
      policy.max_position_pct,
    );
  }

  // ── approve ───────────────────────────────────────────────────────────────────

  /**
   * Approves a pending TradeIntent and executes it (human/HITL path).
   *
   * Execution mode is decided by _effectiveMode(policy): PAPER by default; REAL only
   * under the triple condition (execution.real=true AND a broker_plugin_id is set).
   * So a human approving while real mode is configured WILL place a real order
   * (gated by the same risk checks + notional ceiling inside _executeReal).
   *
   * Hard guard: status != "pending" → throws.
   * Fail-soft: if getQuote/placeOrder fails, sets status=failed with reason in result_json.
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

    if (intent.status !== 'pending') {
      throw new Error(
        `TradeIntent ${id} is not pending (current status: ${intent.status}). ` +
          `Only pending intents can be approved.`,
      );
    }

    const policy = await this._readExecutionPolicy();
    const effectiveMode = this._effectiveMode(policy);

    // Load the shared paper portfolio (create with defaults if missing).
    // Also needed in real mode for exit qty lookup.
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

    if (effectiveMode === 'real') {
      return this._executeReal(id, intent, policy, state, decided_by, SIZING_PCT);
    }
    return this._runPaperExecution(
      id,
      intent.symbol,
      intent.action as TradeAction,
      state,
      decided_by,
      SIZING_PCT,
    );
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
    const [
      rawAutonomous,
      rawMaxPosPct,
      rawMaxOpenPos,
      rawMaxDrawdown,
      rawReal,
      rawBrokerId,
      rawMaxNotional,
    ] = await Promise.all([
      this.kv.get('execution.autonomous'),
      this.kv.get('execution.max_position_pct'),
      this.kv.get('execution.max_open_positions'),
      this.kv.get('execution.max_drawdown_halt_pct'),
      this.kv.get('execution.real'),
      this.kv.get('execution.broker_plugin_id'),
      this.kv.get('execution.max_order_notional'),
    ]);

    // autonomous: only an explicit false disables it (default on). kvBool tolera el
    // doble-encoding del KV ('false' crudo o '"false"' del panel).
    const autonomous = kvBool(rawAutonomous, DEFAULT_EXECUTION_POLICY.autonomous);

    let max_position_pct = kvNum(rawMaxPosPct, DEFAULT_EXECUTION_POLICY.max_position_pct);
    if (max_position_pct <= 0 || max_position_pct > 1)
      max_position_pct = DEFAULT_EXECUTION_POLICY.max_position_pct;

    let max_open_positions = Math.round(
      kvNum(rawMaxOpenPos, DEFAULT_EXECUTION_POLICY.max_open_positions),
    );
    if (max_open_positions < 1) max_open_positions = 1;

    let max_drawdown_halt_pct = kvNum(
      rawMaxDrawdown,
      DEFAULT_EXECUTION_POLICY.max_drawdown_halt_pct,
    );
    if (max_drawdown_halt_pct <= 0 || max_drawdown_halt_pct > 100)
      max_drawdown_halt_pct = DEFAULT_EXECUTION_POLICY.max_drawdown_halt_pct;

    // real: solo true explícito lo habilita (default false). kvBool tolera '"true"' del panel
    // — sin esto la ejecución real nunca se activaba aunque el panel la marcara.
    const real = kvBool(rawReal, DEFAULT_EXECUTION_POLICY.real);

    // broker_plugin_id: empty string is treated as "not set" → paper fallback.
    const broker_plugin_id = (kvStr(rawBrokerId) ?? '').trim();

    // max_order_notional: hard ceiling per order in notional value.
    let max_order_notional = kvNum(rawMaxNotional, DEFAULT_EXECUTION_POLICY.max_order_notional);
    if (max_order_notional <= 0) max_order_notional = DEFAULT_EXECUTION_POLICY.max_order_notional;

    return {
      autonomous,
      max_position_pct,
      max_open_positions,
      max_drawdown_halt_pct,
      real,
      broker_plugin_id,
      max_order_notional,
    };
  }

  /** Current execution policy (operator-facing). */
  async getPolicy(): Promise<ExecutionPolicy> {
    return this._readExecutionPolicy();
  }

  /**
   * Updates execution policy KV keys (operator config — "configure once").
   * Only provided fields are written. Returns the resulting (clamped) policy.
   * Safety stays enforced downstream by _effectiveMode (triple condition) and the
   * automated risk gates — this only persists the knobs.
   */
  async setPolicy(patch: Partial<ExecutionPolicy>): Promise<ExecutionPolicy> {
    if (patch.autonomous !== undefined)
      await this.kv.set('execution.autonomous', String(patch.autonomous));
    if (patch.real !== undefined) await this.kv.set('execution.real', String(patch.real));
    if (patch.broker_plugin_id !== undefined)
      await this.kv.set('execution.broker_plugin_id', patch.broker_plugin_id);
    if (patch.max_position_pct !== undefined)
      await this.kv.set('execution.max_position_pct', String(patch.max_position_pct));
    if (patch.max_open_positions !== undefined)
      await this.kv.set('execution.max_open_positions', String(patch.max_open_positions));
    if (patch.max_drawdown_halt_pct !== undefined)
      await this.kv.set('execution.max_drawdown_halt_pct', String(patch.max_drawdown_halt_pct));
    if (patch.max_order_notional !== undefined)
      await this.kv.set('execution.max_order_notional', String(patch.max_order_notional));
    return this._readExecutionPolicy();
  }

  // ── _effectiveMode ────────────────────────────────────────────────────────────

  /**
   * Derives the execution mode from policy.
   * Returns 'real' ONLY when BOTH conditions hold:
   *   1. policy.real === true  (operator explicitly set execution.real=true)
   *   2. policy.broker_plugin_id is non-empty  (a broker is configured)
   *
   * Any other combination → 'paper'. This is the SINGLE source of truth.
   * intent.mode (stored in DB) is irrelevant at execution time.
   */
  private _effectiveMode(policy: ExecutionPolicy): 'paper' | 'real' {
    if (policy.real === true && policy.broker_plugin_id.length > 0) {
      return 'real';
    }
    return 'paper';
  }

  // ── _executeReal ──────────────────────────────────────────────────────────────

  /**
   * Real-money execution path.
   *
   * Pre-checks (any failure → status=failed, NEVER place order):
   *   - broker_plugin_id must be set (defensive; _effectiveMode already guards this)
   *   - qty computed from fresh getQuote; must be > 0
   *   - notional (qty * price) must be <= policy.max_order_notional
   *
   * Side mapping:
   *   long  → 'buy'
   *   exit  → 'sell' (qty = held position qty from paper portfolio)
   *   short → 'sell'
   *   hold  → no-op (executed, qty=0) — caller should have short-circuited before here
   *
   * On broker success: status=executed, fill_price/quantity/result_json from response.
   * On broker throw: status=failed, reason logged, NO retry, NO throw to caller.
   * Paper portfolio is NEVER mutated in real mode.
   *
   * Every real order attempt emits a WARN-level audit log line.
   */
  private async _executeReal(
    id: string,
    intent: { symbol: string; action: string },
    policy: ExecutionPolicy,
    paperState: PaperState,
    decided_by: string,
    sizingPct: number,
  ) {
    const symbol = intent.symbol;
    const action = intent.action as TradeAction;

    // Defensive: broker must be set (belt-and-suspenders beyond _effectiveMode).
    if (!policy.broker_plugin_id) {
      this.log.warn(`REAL ORDER REJECTED [${id}]: broker_plugin_id is empty — safety guard`);
      return this.db.tradeIntent.update({
        where: { id },
        data: {
          status: 'failed',
          decided_at: new Date(),
          decided_by,
          result_json: JSON.stringify({ error: 'broker_plugin_id not configured' }),
        },
      });
    }

    // Fetch live quote for sizing.
    let price: number;
    try {
      const quote = await this.gateway.getQuote(null, symbol);
      price = quote.last;
    } catch (err) {
      this.log.warn(`REAL ORDER FAILED [${id}]: getQuote error for ${symbol} — ${String(err)}`);
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

    if (!isFinite(price) || price <= 0) {
      this.log.warn(`REAL ORDER FAILED [${id}]: invalid quote price ${price} for ${symbol}`);
      return this.db.tradeIntent.update({
        where: { id },
        data: {
          status: 'failed',
          decided_at: new Date(),
          decided_by,
          result_json: JSON.stringify({ error: `Invalid quote price: ${price}` }),
        },
      });
    }

    // Compute side and qty.
    let side: 'buy' | 'sell';
    let qty: number;

    if (action === 'long') {
      side = 'buy';
      qty = Math.floor((paperState.equity * sizingPct) / price);
    } else if (action === 'exit') {
      side = 'sell';
      // Use held position quantity from paper portfolio as the authoritative qty.
      const pos = paperState.positions.find((p) => p.symbol === symbol);
      qty = pos ? pos.quantity : 0;
    } else if (action === 'short') {
      side = 'sell';
      qty = Math.floor((paperState.equity * sizingPct) / price);
    } else {
      // 'hold' — should have been short-circuited before reaching here; defensive no-op.
      return this.db.tradeIntent.update({
        where: { id },
        data: {
          status: 'executed',
          quantity: 0,
          decided_at: new Date(),
          decided_by,
          result_json: JSON.stringify({ quantity: 0, reason: 'hold — no position change' }),
        },
      });
    }

    // Qty safety check.
    if (qty <= 0) {
      this.log.warn(`REAL ORDER REJECTED [${id}]: computed qty=${qty} for ${symbol} — not placing`);
      return this.db.tradeIntent.update({
        where: { id },
        data: {
          status: 'failed',
          decided_at: new Date(),
          decided_by,
          result_json: JSON.stringify({
            error: `Computed qty=${qty} — not enough equity or no position to exit`,
          }),
        },
      });
    }

    // Notional ceiling check.
    const notional = qty * price;
    if (notional > policy.max_order_notional) {
      this.log.warn(
        `REAL ORDER REJECTED [${id}]: notional=${notional} exceeds max_order_notional=${policy.max_order_notional} for ${symbol}`,
      );
      return this.db.tradeIntent.update({
        where: { id },
        data: {
          status: 'failed',
          decided_at: new Date(),
          decided_by,
          result_json: JSON.stringify({
            error: `Order notional ${notional} exceeds max_order_notional ${policy.max_order_notional}`,
            qty,
            price,
            notional,
            max_order_notional: policy.max_order_notional,
          }),
        },
      });
    }

    // LOUD audit log before every real order attempt.
    this.log.warn(
      `REAL ORDER ATTEMPT [${id}]: ${side.toUpperCase()} ${qty} ${symbol} @ ~${price} ` +
        `(notional=${notional}) via broker=${policy.broker_plugin_id} decided_by=${decided_by}`,
    );

    // Place the real order — fail-soft on broker error.
    let orderResponse: Record<string, unknown>;
    try {
      orderResponse = await this.gateway.placeOrder(policy.broker_plugin_id, {
        symbol,
        qty,
        side,
        type: 'market',
      });
    } catch (err) {
      this.log.warn(`REAL ORDER FAILED [${id}]: broker threw — ${String(err)}`);
      return this.db.tradeIntent.update({
        where: { id },
        data: {
          status: 'failed',
          decided_at: new Date(),
          decided_by,
          result_json: JSON.stringify({ error: String(err), qty, side, symbol }),
        },
      });
    }

    this.log.warn(
      `REAL ORDER EXECUTED [${id}]: ${side.toUpperCase()} ${qty} ${symbol} — broker response: ${JSON.stringify(orderResponse)}`,
    );

    return this.db.tradeIntent.update({
      where: { id },
      data: {
        status: 'executed',
        fill_price: price,
        quantity: qty,
        decided_at: new Date(),
        decided_by,
        result_json: JSON.stringify({
          fill_price: price,
          quantity: qty,
          side,
          broker: policy.broker_plugin_id,
          order: orderResponse,
        }),
      },
    });
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
