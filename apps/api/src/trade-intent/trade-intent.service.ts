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
import { Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderGatewayService, Portfolio } from '../providers/provider-gateway.service';
import { KvService } from '../common/kv.service';
import { kvBool, kvNum, kvStr } from '../common/kv.util';
import { AuditService } from '../audit/audit.service';

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
  /** High-water-mark equity — the highest equity ever recorded for this paper portfolio. */
  hwm?: number;
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

/**
 * Walk-forward gate (measurable-veto-shield): freshness window for a passing verdict.
 * Real-money execution requires the CURRENTLY-APPLIED strategy to carry a ROBUSTO
 * walk-forward verdict recorded within this many days. Configurable via KV
 * `execution.walk_forward_max_age_days`; clamped to [1, 3650].
 */
const DEFAULT_WALK_FORWARD_MAX_AGE_DAYS = 30;
const WALK_FORWARD_MAX_AGE_DAYS_MIN = 1;
const WALK_FORWARD_MAX_AGE_DAYS_MAX = 3650;
const REQUIRED_WALK_FORWARD_VERDICT = 'ROBUSTO';

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
    // AuditService @Optional() — records real→paper demotions from the walk-forward gate
    // so the operator understands WHY a real order didn't execute. Absent → WARN log only.
    @Optional() private readonly audit?: AuditService,
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
    // action must be known BEFORE resolving mode so it can skip the walk-forward gate
    // for exit/hold (closing reduces risk; holding touches nothing — see method doc), and
    // so exit routing can be decided by WHERE the position actually lives (see
    // _resolveExitRouting doc comment — stranded real-position bug).
    const action = intent.action as TradeAction;
    const modeResult = await this._resolveMode(policy, id, intent.symbol, action, 'autonomous');
    if (modeResult.mode === 'failed') return modeResult.failedUpdate;
    const effectiveMode = modeResult.mode;

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
    // action must be known BEFORE resolving mode so it can skip the walk-forward gate
    // for exit/hold (closing reduces risk; holding touches nothing — see method doc), and
    // so exit routing can be decided by WHERE the position actually lives (see
    // _resolveExitRouting doc comment — stranded real-position bug).
    const action = intent.action as TradeAction;
    const modeResult = await this._resolveMode(policy, id, intent.symbol, action, decided_by);
    if (modeResult.mode === 'failed') return modeResult.failedUpdate;
    const effectiveMode = modeResult.mode;

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

    // Kernel risk gate — SAME gate as autoProcess(), applied on the human-approval
    // path too. Human approval must not bypass the drawdown halt / max-open-positions
    // floor. "exit"/"hold" always pass — closing a position must remain possible
    // even during an active halt.
    if (action === 'long' || action === 'short') {
      const { pass, reason } = this._passesAutoRisk(state, policy);
      if (!pass) {
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
    }

    if (effectiveMode === 'real') {
      return this._executeReal(id, intent, policy, state, decided_by, SIZING_PCT);
    }
    return this._runPaperExecution(
      id,
      intent.symbol,
      action,
      state,
      decided_by,
      SIZING_PCT,
      policy.max_position_pct,
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
   * Derives the execution mode from policy. This is the SINGLE source of truth for
   * real-vs-paper; intent.mode (stored in DB) is irrelevant at execution time.
   *
   * Returns 'real' ONLY when ALL of these hold:
   *   1. policy.real === true  (operator explicitly set execution.real=true)
   *   2. policy.broker_plugin_id is non-empty  (a broker is configured)
   *   3. for "long"/"short" ONLY: the walk-forward GATE passes — the CURRENTLY-APPLIED
   *      strategy carries a recent ROBUSTO walk-forward verdict (measurable-veto-shield).
   *
   * "exit" and "hold" SKIP the walk-forward gate entirely (no demotion, no audit call):
   * walk-forward validates OPENING new risk, and must never gate CLOSING an existing
   * position — a stale/missing verdict must never turn a real "exit" into a silent
   * no-op on an unrelated paper portfolio (see class-level incident notes). "hold" never
   * touches broker/paper state either way, so it has nothing for the gate to protect.
   *
   * Any long/short gate failure → 'paper'. The gate ONLY ever downgrades real→paper: it
   * never throws, never blocks the intent, and never touches the paper path. A demotion
   * is logged at WARN and audited so the operator understands why real didn't execute.
   */
  private async _effectiveMode(
    policy: ExecutionPolicy,
    contextId: string,
    action: TradeAction,
  ): Promise<'paper' | 'real'> {
    if (!(policy.real === true && policy.broker_plugin_id.length > 0)) {
      return 'paper';
    }

    // Closing (exit) reduces risk and must always be reachable; holding touches nothing.
    // Neither depends on walk-forward freshness — only opening new risk does.
    if (action === 'exit' || action === 'hold') {
      return 'real';
    }

    const gate = await this._checkWalkForwardGate();
    if (!gate.pass) {
      this.log.warn(
        `REAL DEMOTED TO PAPER [${contextId}]: walk-forward gate failed — ${gate.reason}`,
      );
      await this._auditDemotion(contextId, gate.reason ?? 'walk-forward gate failed');
      return 'paper';
    }
    return 'real';
  }

  // ── _resolveExitRouting ───────────────────────────────────────────────────────

  /**
   * Determines where an `exit` must actually route, INDEPENDENT of policy.real.
   *
   * Rationale (money-critical stranding-bug fix): a real position can be opened while
   * execution.real=true + broker_plugin_id set. If the operator later flips
   * execution.real=false (or clears broker_plugin_id) while that real position is STILL
   * OPEN at the broker, _effectiveMode alone would route the next exit to paper —
   * _executePaper finds no matching paper position (it was never paper) and reports a
   * FALSE "closed" (quantity:0, status:'executed') while the real position remains open.
   * An exit must always close the position WHERE IT ACTUALLY LIVES. Routing a sell to the
   * real broker whenever a real position exists is ALWAYS SAFE — it only ever reduces
   * risk, never increases it — regardless of what policy.real currently says.
   *
   * Contract:
   *   - broker HOLDS a position for the symbol → route 'real' (close it for real).
   *   - broker HOLDS NO position for the symbol → route 'paper' (legitimate — nothing
   *     real to close; fall through to the normal paper exit path).
   *   - broker query FAILS/throws → route 'failed' with a failedUpdate promise. Position
   *     existence cannot be determined — fail safe: NEVER place a sell order and NEVER
   *     report a false paper 'executed'.
   *
   * Only called when policy.broker_plugin_id is non-empty; a pure paper-only account
   * (never had a broker) skips this entirely and keeps the unchanged paper exit path.
   */
  private async _resolveExitRouting(
    id: string,
    symbol: string,
    brokerPluginId: string,
    decided_by: string,
  ): Promise<
    | { route: 'real' }
    | { route: 'paper' }
    | { route: 'failed'; failedUpdate: ReturnType<PrismaService['tradeIntent']['update']> }
  > {
    let brokerPortfolio: Portfolio;
    try {
      brokerPortfolio = await this.gateway.getPortfolio(brokerPluginId);
    } catch (err) {
      this.log.warn(
        `EXIT ROUTING FAILED [${id}]: getPortfolio error for ${symbol} — ${String(err)}`,
      );
      return {
        route: 'failed',
        failedUpdate: this.db.tradeIntent.update({
          where: { id },
          data: {
            status: 'failed',
            decided_at: new Date(),
            decided_by,
            result_json: JSON.stringify({
              error: 'broker position unavailable — refusing to guess exit routing',
              detail: String(err),
            }),
          },
        }),
      };
    }

    const brokerPos = brokerPortfolio.positions.find((p) => p.symbol === symbol);
    if (brokerPos && Math.abs(brokerPos.qty) > 0) {
      return { route: 'real' };
    }
    return { route: 'paper' };
  }

  /**
   * Resolves the execution mode for a TradeIntent, honoring the exit-routing fix above.
   *
   * For "exit" with a configured broker: mode is decided by WHERE the position actually
   * lives (see _resolveExitRouting), never by policy.real alone. For everything else
   * (long/short/hold, or exit with no broker ever configured): unchanged, delegates to
   * _effectiveMode.
   */
  private async _resolveMode(
    policy: ExecutionPolicy,
    id: string,
    symbol: string,
    action: TradeAction,
    decided_by: string,
  ): Promise<
    | { mode: 'paper' | 'real' }
    | { mode: 'failed'; failedUpdate: ReturnType<PrismaService['tradeIntent']['update']> }
  > {
    if (action === 'exit' && policy.broker_plugin_id) {
      const routing = await this._resolveExitRouting(
        id,
        symbol,
        policy.broker_plugin_id,
        decided_by,
      );
      if (routing.route === 'failed') {
        return { mode: 'failed', failedUpdate: routing.failedUpdate };
      }
      return { mode: routing.route };
    }
    return { mode: await this._effectiveMode(policy, id, action) };
  }

  // ── walk-forward gate ─────────────────────────────────────────────────────────

  /**
   * Walk-forward gate before live trading: real money is only allowed when the
   * CURRENTLY-APPLIED strategy (KV `strategy.applied`, same key SnapshotService reads)
   * has a ROBUSTO walk-forward verdict recorded within the freshness window.
   *
   * Fail-soft and fail-closed: any missing/stale/failed condition returns { pass:false }
   * (→ demote to paper). Never throws — every DB/KV read is guarded.
   */
  private async _checkWalkForwardGate(): Promise<{ pass: boolean; reason?: string }> {
    let strategyId: string | null;
    try {
      strategyId = kvStr(await this.kv.get('strategy.applied'));
    } catch {
      strategyId = null;
    }
    if (!strategyId) {
      return { pass: false, reason: 'no applied strategy (KV strategy.applied unset)' };
    }

    let row: { walk_forward_verdict: string | null; walk_forward_checked_at: Date | null } | null;
    try {
      row = await this.db.strategy.findUnique({
        where: { id: strategyId },
        select: { walk_forward_verdict: true, walk_forward_checked_at: true },
      });
    } catch {
      return { pass: false, reason: `strategy lookup failed for '${strategyId}'` };
    }
    if (!row) {
      return { pass: false, reason: `applied strategy '${strategyId}' has no matching row` };
    }

    if (row.walk_forward_verdict !== REQUIRED_WALK_FORWARD_VERDICT) {
      return {
        pass: false,
        reason: `walk-forward verdict is ${row.walk_forward_verdict ?? 'null'} (need ${REQUIRED_WALK_FORWARD_VERDICT})`,
      };
    }
    if (!row.walk_forward_checked_at) {
      return { pass: false, reason: 'walk-forward verdict has no checked_at timestamp' };
    }

    const maxAgeDays = await this._readWalkForwardMaxAgeDays();
    const ageMs = Date.now() - new Date(row.walk_forward_checked_at).getTime();
    if (ageMs > maxAgeDays * 86_400_000) {
      const ageDays = Math.floor(ageMs / 86_400_000);
      return {
        pass: false,
        reason: `walk-forward verdict is stale (${ageDays}d old > ${maxAgeDays}d window)`,
      };
    }

    return { pass: true };
  }

  /** Freshness window (days) for the walk-forward gate. Clamped to sane bounds. */
  private async _readWalkForwardMaxAgeDays(): Promise<number> {
    let raw: string | null;
    try {
      raw = await this.kv.get('execution.walk_forward_max_age_days');
    } catch {
      raw = null;
    }
    let days = kvNum(raw, DEFAULT_WALK_FORWARD_MAX_AGE_DAYS);
    if (!Number.isFinite(days) || days < WALK_FORWARD_MAX_AGE_DAYS_MIN) {
      days = WALK_FORWARD_MAX_AGE_DAYS_MIN;
    }
    if (days > WALK_FORWARD_MAX_AGE_DAYS_MAX) days = WALK_FORWARD_MAX_AGE_DAYS_MAX;
    return days;
  }

  /** Best-effort audit of a real→paper demotion. Never breaks execution. */
  private async _auditDemotion(intentId: string, reason: string): Promise<void> {
    if (!this.audit) return;
    try {
      await this.audit.log({
        event_type: 'walk_forward_gate_demotion',
        meta: { intent_id: intentId, reason },
      });
    } catch {
      // audit is best-effort — a logging failure must never affect execution.
    }
  }

  // ── _executeReal ──────────────────────────────────────────────────────────────

  /**
   * Real-money execution path.
   *
   * Pre-checks (any failure → status=failed, NEVER place order):
   *   - broker_plugin_id must be set (defensive; _effectiveMode already guards this)
   *   - qty computed from fresh getQuote; must be > 0
   *   - notional (qty * price) must be <= policy.max_order_notional — EXEMPT for "exit"
   *     (closing a position must never be blocked by the ceiling; mirrors the qty-clamp
   *     and paper path, which already exempt exits from sizing limits)
   *
   * Side mapping:
   *   long  → 'buy'
   *   exit  → 'sell' (qty = |held position qty| from the broker's live portfolio, never
   *           the paper portfolio — see fail-safe behavior below)
   *   short → 'sell'
   *   hold  → no-op (executed, qty=0) — caller should have short-circuited before here
   *
   * On broker success: status=executed, fill_price/quantity/result_json from response.
   * On broker throw: status=failed, reason logged, NO retry, NO throw to caller.
   * Paper portfolio is NEVER mutated in real mode.
   *
   * Every real order attempt emits a WARN-level audit log line.
   */
  /**
   * Resolves the sell quantity for a REAL `exit`, sourced from the broker's live portfolio
   * — never the paper portfolio, which is unmutated/stale in real mode. Fail-safe: any
   * broker error or missing/zero position returns a `failedUpdate` promise (the caller
   * must return it directly) instead of guessing a quantity or placing a wrong-sized sell.
   *
   * Extracted from `_executeReal` to keep its cognitive complexity within the sonarjs limit.
   */
  private async _resolveRealExitQty(
    id: string,
    symbol: string,
    brokerPluginId: string,
    decided_by: string,
  ): Promise<
    { qty: number } | { failedUpdate: ReturnType<PrismaService['tradeIntent']['update']> }
  > {
    let brokerPortfolio: Portfolio;
    try {
      brokerPortfolio = await this.gateway.getPortfolio(brokerPluginId);
    } catch (err) {
      this.log.warn(`REAL ORDER FAILED [${id}]: getPortfolio error for ${symbol} — ${String(err)}`);
      return {
        failedUpdate: this.db.tradeIntent.update({
          where: { id },
          data: {
            status: 'failed',
            decided_at: new Date(),
            decided_by,
            result_json: JSON.stringify({
              error: 'broker position unavailable — refusing to guess exit qty',
              detail: String(err),
            }),
          },
        }),
      };
    }

    const brokerPos = brokerPortfolio.positions.find((p) => p.symbol === symbol);
    if (!brokerPos || Math.abs(brokerPos.qty) <= 0) {
      this.log.warn(
        `REAL ORDER REJECTED [${id}]: no open broker position for ${symbol} — not placing`,
      );
      return {
        failedUpdate: this.db.tradeIntent.update({
          where: { id },
          data: {
            status: 'failed',
            decided_at: new Date(),
            decided_by,
            result_json: JSON.stringify({ error: `no open broker position for ${symbol}` }),
          },
        }),
      };
    }

    return { qty: Math.abs(brokerPos.qty) };
  }

  /**
   * Belt-and-suspenders preconditions for `_executeReal`, re-checked defensively even
   * though `_effectiveMode` already gates real execution — so no future caller can reach
   * a real order without a configured broker and (for long/short only) a fresh ROBUSTO
   * walk-forward verdict.
   *
   * "exit"/"hold" are EXEMPT from the walk-forward re-check: closing a position reduces
   * risk and must never be blocked by a stale/missing verdict — mirrors the exemption in
   * `_effectiveMode`. The broker check still applies to every action.
   *
   * Extracted from `_executeReal` to keep its cognitive complexity within the sonarjs limit.
   */
  private async _checkExecuteRealPreconditions(
    id: string,
    policy: ExecutionPolicy,
    action: TradeAction,
    decided_by: string,
  ): Promise<{ failedUpdate: ReturnType<PrismaService['tradeIntent']['update']> } | { ok: true }> {
    // Defensive: broker must be set (belt-and-suspenders beyond _effectiveMode).
    if (!policy.broker_plugin_id) {
      this.log.warn(`REAL ORDER REJECTED [${id}]: broker_plugin_id is empty — safety guard`);
      return {
        failedUpdate: this.db.tradeIntent.update({
          where: { id },
          data: {
            status: 'failed',
            decided_at: new Date(),
            decided_by,
            result_json: JSON.stringify({ error: 'broker_plugin_id not configured' }),
          },
        }),
      };
    }

    // Defensive walk-forward gate re-check (belt-and-suspenders beyond _effectiveMode) so
    // no future caller can reach real execution without a recent ROBUSTO verdict on the
    // applied strategy. In the normal flow _effectiveMode already demoted to paper, so this
    // never fires; if it ever does, fail safe like the broker guard — no real order.
    if (action !== 'exit' && action !== 'hold') {
      const gate = await this._checkWalkForwardGate();
      if (!gate.pass) {
        this.log.warn(
          `REAL ORDER REJECTED [${id}]: walk-forward gate failed — ${gate.reason} — safety guard`,
        );
        return {
          failedUpdate: this.db.tradeIntent.update({
            where: { id },
            data: {
              status: 'failed',
              decided_at: new Date(),
              decided_by,
              result_json: JSON.stringify({ error: `walk-forward gate: ${gate.reason}` }),
            },
          }),
        };
      }
    }

    return { ok: true };
  }

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

    // Broker + walk-forward re-check (exit/hold exempt from the walk-forward part — see
    // _checkExecuteRealPreconditions doc comment). Extracted to keep this function's
    // cognitive complexity within the sonarjs limit.
    const preconditions = await this._checkExecuteRealPreconditions(id, policy, action, decided_by);
    if ('failedUpdate' in preconditions) return preconditions.failedUpdate;

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
      qty = this._clampToPositionCeiling(
        Math.floor((paperState.equity * sizingPct) / price),
        paperState.equity,
        price,
        policy.max_position_pct,
        id,
        'real long',
      );
    } else if (action === 'exit') {
      side = 'sell';
      // Real exits must source qty from the BROKER's live position — the paper portfolio
      // is never mutated in real mode (see method doc comment above) and is therefore
      // stale/irrelevant here. Fail safe if the broker is unreachable or reports no open
      // position: never guess a quantity, never place a wrong-sized sell.
      // No ceiling clamp on exits — closing an existing position reduces risk.
      const exitQty = await this._resolveRealExitQty(
        id,
        symbol,
        policy.broker_plugin_id,
        decided_by,
      );
      if ('failedUpdate' in exitQty) return exitQty.failedUpdate;
      qty = exitQty.qty;
    } else if (action === 'short') {
      side = 'sell';
      qty = this._clampToPositionCeiling(
        Math.floor((paperState.equity * sizingPct) / price),
        paperState.equity,
        price,
        policy.max_position_pct,
        id,
        'real short',
      );
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

    // Notional ceiling check — exits are EXEMPT (closing a position reduces risk and must
    // never be blocked, mirroring the qty-clamp and the paper path, which already exempt
    // exits). A real position whose notional exceeds the ceiling must still be closeable;
    // otherwise the ceiling would trap the user in a position they can't exit.
    const notional = qty * price;
    if (action !== 'exit' && notional > policy.max_order_notional) {
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
      // client_order_id gives the broker an idempotency key so a retried submission
      // never double-fills. Generated inline for now — this will move to a dedicated
      // order-tracking service once the real-money accounting ledger lands.
      const clientOrderId = `nt-${randomUUID()}`;
      orderResponse = await this.gateway.placeOrder(policy.broker_plugin_id, {
        symbol,
        qty,
        side,
        type: 'market',
        clientOrderId,
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

  // ── _computeDrawdownPct ───────────────────────────────────────────────────────

  /**
   * Real drawdown from the true high-water-mark (hwm), read from the PAPER PORTFOLIO
   * itself — the same state the kernel actually sizes/gates against. NOT from an
   * external-provider-sourced snapshot history, which is disconnected from the paper
   * portfolio and stays empty (hence a permanently-0 drawdown) whenever no broker
   * credentials are configured — the common self-hosted case.
   *
   * hwm defaults to the current equity when unset (fresh portfolio, no trades yet),
   * so a brand-new account is NEVER false-halted on its very first trade.
   */
  private _computeDrawdownPct(state: PaperState): number {
    const hwm = state.hwm ?? state.equity;
    return hwm > 0 ? Math.max(0, ((hwm - state.equity) / hwm) * 100) : 0;
  }

  // ── _passesAutoRisk ───────────────────────────────────────────────────────────

  /**
   * Kernel risk gate for NEW ENTRIES (long/short). Called from BOTH autoProcess()
   * and approve() — the human-approval path must not bypass these checks.
   * "exit"/"hold" are never gated here (callers must keep letting position-closing
   * actions through even during an active halt).
   */
  private _passesAutoRisk(
    state: PaperState,
    policy: ExecutionPolicy,
  ): { pass: boolean; reason?: string } {
    const drawdown = this._computeDrawdownPct(state);
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

  // ── _clampToPositionCeiling ───────────────────────────────────────────────────

  /**
   * Hard, non-bypassable ceiling on entry sizing: qty can never exceed what
   * policy.max_position_pct allows for the current equity, regardless of what
   * sizingPct was used to compute the intended qty (e.g. approve()'s conservative
   * hardcoded SIZING_PCT). Tightening max_position_pct always reduces what actually
   * executes, even if the caller's intended sizing was larger.
   */
  private _clampToPositionCeiling(
    qty: number,
    equity: number,
    price: number,
    maxPositionPct: number,
    id: string,
    context: string,
  ): number {
    if (qty <= 0) return qty;
    const maxQty = Math.floor((equity * maxPositionPct) / price);
    if (qty > maxQty) {
      this.log.warn(
        `POSITION SIZE CLAMPED [${id}] (${context}): qty ${qty} → ${maxQty} ` +
          `(ceiling: equity=${equity} * max_position_pct=${maxPositionPct} / price=${price})`,
      );
      return maxQty;
    }
    return qty;
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
    maxPositionPct: number,
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
      id,
      action,
      symbol,
      fillPrice,
      state,
      sizingPct,
      maxPositionPct,
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
   * "long"  → buy floor(cash * sizingPct / fill_price) shares, hard-clamped to the
   *           policy.max_position_pct ceiling; avg_price cost-basis.
   * "exit"  → close entire existing position; realized_pnl = (fill - avg) * qty.
   * "short" → not really executable in simple paper mode; records qty=0, no state change.
   * "hold"  → no trade; qty=0.
   *
   * hwm (high-water-mark) is recomputed on every return path as max(previous hwm,
   * new equity) — this is the source the drawdown risk gate reads (_computeDrawdownPct).
   */
  private _executePaper(
    id: string,
    action: TradeAction,
    symbol: string,
    fillPrice: number,
    state: PaperState,
    sizingPct = SIZING_PCT,
    maxPositionPct = DEFAULT_EXECUTION_POLICY.max_position_pct,
  ): { quantity: number; realized_pnl: number | null; newState: PaperState } {
    // Deep-copy positions so we don't mutate the original.
    const newState: PaperState = {
      equity: state.equity,
      cash: state.cash,
      positions: state.positions.map((p) => ({ ...p })),
      hwm: state.hwm,
    };
    const baseHwm = state.hwm ?? state.equity;

    if (action === 'long') {
      const budget = newState.cash * sizingPct;
      const quantity = this._clampToPositionCeiling(
        Math.floor(budget / fillPrice),
        state.equity,
        fillPrice,
        maxPositionPct,
        id,
        'paper long',
      );
      if (quantity <= 0) {
        newState.hwm = Math.max(baseHwm, newState.equity);
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
      newState.hwm = Math.max(baseHwm, newState.equity);
      return { quantity, realized_pnl: null, newState };
    }

    if (action === 'exit') {
      const posIdx = newState.positions.findIndex((p) => p.symbol === symbol);
      if (posIdx < 0) {
        // No open position to exit — still executed, just qty=0
        newState.hwm = Math.max(baseHwm, newState.equity);
        return { quantity: 0, realized_pnl: null, newState };
      }
      const pos = newState.positions[posIdx];
      const quantity = pos.quantity;
      const proceeds = fillPrice * quantity;
      const realized_pnl = (fillPrice - pos.avg_price) * quantity;
      newState.cash += proceeds;
      newState.positions.splice(posIdx, 1);
      newState.equity = newState.cash + this._positionsValue(newState.positions, fillPrice, symbol);
      newState.hwm = Math.max(baseHwm, newState.equity);
      return { quantity, realized_pnl, newState };
    }

    // "short" and "hold": no portfolio mutation in simple paper mode.
    newState.hwm = Math.max(baseHwm, newState.equity);
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
