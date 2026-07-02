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
 * KERNEL GATES READ THE ACCOUNT THAT ACTUALLY HOLDS THE MONEY: in real mode, the drawdown
 * halt, max-open-positions gate, and entry sizing all read RealAccountState (RealNavSnapshot
 * + RealPosition — see getRealAccountState), never the paper portfolio. If no RealNavSnapshot
 * exists yet for the configured broker (a fresh, never-synced real account), a real long/short
 * FAILS CLOSED (status=failed) rather than falling back to paper numbers or a fabricated 0%
 * drawdown. "exit"/"hold" are exempt — closing/holding is always safe.
 *
 * Paper portfolio storage: Portfolio model, name="paper", data=JSON PaperState.
 * This reuses the existing Portfolio table (keyed by name) and avoids a new table.
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderGatewayService, Portfolio } from '../providers/provider-gateway.service';
import { KvService } from '../common/kv.service';
import { kvBool, kvNum, kvStr } from '../common/kv.util';
import {
  isRealExecutionHalted,
  clearRealExecutionHalt,
  getRealExecutionHaltStatus,
  RealExecutionHaltStatus,
} from '../common/real-execution-halt.util';
import { AuditService } from '../audit/audit.service';
import { RealOrderService } from '../real-order/real-order.service';
import { RealBrokerReconciliationService } from '../real-reconciliation/real-broker-reconciliation.service';

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

/**
 * Real-account state for the kernel risk gates — sourced from RealNavSnapshot (latest row
 * for this broker) + a live count of RealPosition rows (open positions at this broker).
 * Written by RealBrokerReconciliationService.syncPortfolio; NEVER derived from the paper
 * Portfolio row, which is a different account with different money.
 */
export interface RealAccountState {
  equity: number;
  hwm: number;
  buyingPower: number;
  openPositionsCount: number;
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

/**
 * Real-account-state freshness gate: a RealNavSnapshot older than this window is treated
 * as unavailable (same fail-closed handling as no snapshot at all) for opening trades
 * (long/short). If broker sync/reconciliation is down, the latest snapshot can be
 * arbitrarily stale — sizing/drawdown must never be computed off stale-optimistic equity.
 * Configurable via KV `execution.real_state_max_age_ms`; clamped to [30_000, 3_600_000]
 * (30s .. 1h). "exit"/"hold" never depend on this — see getRealAccountState doc comment.
 */
const DEFAULT_REAL_STATE_MAX_AGE_MS = 300_000;
const REAL_STATE_MAX_AGE_MS_MIN = 30_000;
const REAL_STATE_MAX_AGE_MS_MAX = 3_600_000;

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
    // RealOrderService owns idempotent, crash-safe real-order submission (client_order_id
    // generation, DB row created BEFORE the broker call). _executeReal delegates all real
    // order placement to it instead of calling gateway.placeOrder directly.
    private readonly realOrderService: RealOrderService,
    // RealBrokerReconciliationService — after a successful real submit, _executeReal fires
    // fastPollOrder(realOrder.id) fire-and-forget so a fast-filling order is reflected
    // without waiting for the steady-state reconciliation interval.
    private readonly reconciliation: RealBrokerReconciliationService,
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

    // Real mode: risk gates/sizing MUST read the REAL account (RealNavSnapshot/RealPosition),
    // never the paper portfolio — see getRealAccountState doc comment. Loaded unconditionally
    // once effectiveMode === 'real' (cheap: one findFirst + one count).
    const realState =
      effectiveMode === 'real' ? await this.getRealAccountState(policy.broker_plugin_id) : null;

    // FAIL CLOSED: a real opening trade with NO RealNavSnapshot yet (fresh, never-synced real
    // account) must be rejected outright — never sized/gated against paper numbers or a
    // fabricated 0% drawdown. "exit"/"hold" never reach this (closing/holding is always safe).
    if (effectiveMode === 'real' && (action === 'long' || action === 'short') && !realState) {
      this.log.warn(
        `REAL ORDER REJECTED [${id}]: no RealNavSnapshot for broker=${policy.broker_plugin_id} — failing closed`,
      );
      return this.db.tradeIntent.update({
        where: { id },
        data: {
          status: 'failed',
          decided_at: new Date(),
          decided_by: 'autonomous',
          result_json: JSON.stringify({
            error: 'real account state unavailable — cannot size/risk-check safely',
          }),
        },
      });
    }

    // Risk gate — only for opening trades. Real mode gates the REAL account (realState,
    // non-null here — see fail-closed check above); paper mode gates paperState, unchanged.
    if (action === 'long' || action === 'short') {
      const { pass, reason } =
        effectiveMode === 'real'
          ? this._passesAutoRisk(realState as RealAccountState, policy, 'real')
          : this._passesAutoRisk(paperState, policy, 'paper');
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
        realState,
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

    // "hold" → executed immediately as no-op, no quote fetch, no portfolio mutation. Mirrors
    // autoProcess() — a data-feed outage must never fail an approved no-op (see _executeReal's
    // defensive "should have been short-circuited before reaching here" comment: this is that
    // short-circuit for the human-approval path).
    if (action === 'hold') {
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

    // Real mode: risk gates/sizing MUST read the REAL account (RealNavSnapshot/RealPosition),
    // never the paper portfolio — see getRealAccountState doc comment. Loaded unconditionally
    // once effectiveMode === 'real' (cheap: one findFirst + one count).
    const realState =
      effectiveMode === 'real' ? await this.getRealAccountState(policy.broker_plugin_id) : null;

    // FAIL CLOSED: a real opening trade with NO RealNavSnapshot yet (fresh, never-synced real
    // account) must be rejected outright — never sized/gated against paper numbers or a
    // fabricated 0% drawdown. "exit"/"hold" never reach this (closing/holding is always safe).
    if (effectiveMode === 'real' && (action === 'long' || action === 'short') && !realState) {
      this.log.warn(
        `REAL ORDER REJECTED [${id}]: no RealNavSnapshot for broker=${policy.broker_plugin_id} — failing closed`,
      );
      return this.db.tradeIntent.update({
        where: { id },
        data: {
          status: 'failed',
          decided_at: new Date(),
          decided_by,
          result_json: JSON.stringify({
            error: 'real account state unavailable — cannot size/risk-check safely',
          }),
        },
      });
    }

    // Kernel risk gate — SAME gate as autoProcess(), applied on the human-approval
    // path too. Human approval must not bypass the drawdown halt / max-open-positions
    // floor. "exit"/"hold" always pass — closing a position must remain possible
    // even during an active halt. Real mode gates the REAL account (realState, non-null
    // here — see fail-closed check above); paper mode gates the paper state, unchanged.
    if (action === 'long' || action === 'short') {
      const { pass, reason } =
        effectiveMode === 'real'
          ? this._passesAutoRisk(realState as RealAccountState, policy, 'real')
          : this._passesAutoRisk(state, policy, 'paper');
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
      return this._executeReal(id, intent, policy, realState, decided_by, SIZING_PCT);
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

  /** Operator-facing read of the real-money kill-switch (see real-execution-halt.util.ts). */
  async getRealExecutionHaltStatus(): Promise<RealExecutionHaltStatus> {
    return getRealExecutionHaltStatus(this.kv);
  }

  /**
   * Clears the real-money kill-switch. Must ONLY ever be called from the TOTP-gated
   * operator "clear" endpoint — never automatically. See real-execution-halt.util.ts.
   */
  async clearRealExecutionHalt(): Promise<RealExecutionHaltStatus> {
    await clearRealExecutionHalt(this.kv);
    return getRealExecutionHaltStatus(this.kv);
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

  // ── getRealAccountState ───────────────────────────────────────────────────────

  /**
   * Real-account state for the kernel risk gates — sourced from RealNavSnapshot (latest row
   * for this broker) + a live count of RealPosition rows. Written by
   * RealBrokerReconciliationService.syncPortfolio; NEVER derived from the paper Portfolio
   * row, which is a different account with different money.
   *
   * Returns `null` when NO RealNavSnapshot exists yet for this broker — a fresh real account
   * that has never been synced — OR when the latest snapshot is STALE (older than
   * `_readRealStateMaxAgeMs()`, e.g. broker sync/reconciliation has stopped running). Callers
   * MUST fail closed on `null` for opening trades (long/short): never fall back to paper
   * numbers, a 0% drawdown default, or stale-optimistic equity. Closing (exit) is always safe
   * and does not depend on this loader — its qty is sourced directly from the broker's live
   * portfolio by `_resolveRealExitQty`.
   */
  private async getRealAccountState(brokerPluginId: string): Promise<RealAccountState | null> {
    const snapshot = await this.db.realNavSnapshot.findFirst({
      where: { broker_plugin_id: brokerPluginId },
      orderBy: { ts: 'desc' },
    });
    if (!snapshot) return null;

    const ageMs = Date.now() - new Date(snapshot.ts).getTime();
    const maxAgeMs = await this._readRealStateMaxAgeMs();
    if (ageMs > maxAgeMs) {
      this.log.warn(
        `REAL ACCOUNT STATE STALE: latest RealNavSnapshot for broker=${brokerPluginId} is ` +
          `${ageMs}ms old (> ${maxAgeMs}ms window) — treating as unavailable, failing closed`,
      );
      return null;
    }

    const openPositionsCount = await this.db.realPosition.count({
      where: { broker_plugin_id: brokerPluginId },
    });

    return {
      equity: snapshot.equity,
      hwm: snapshot.hwm,
      buyingPower: snapshot.buying_power,
      openPositionsCount,
    };
  }

  /** Freshness window (ms) for the real-account-state (RealNavSnapshot) staleness gate. */
  private async _readRealStateMaxAgeMs(): Promise<number> {
    let raw: string | null;
    try {
      raw = await this.kv.get('execution.real_state_max_age_ms');
    } catch {
      raw = null;
    }
    let ms = kvNum(raw, DEFAULT_REAL_STATE_MAX_AGE_MS);
    if (!Number.isFinite(ms) || ms < REAL_STATE_MAX_AGE_MS_MIN) {
      ms = REAL_STATE_MAX_AGE_MS_MIN;
    }
    if (ms > REAL_STATE_MAX_AGE_MS_MAX) ms = REAL_STATE_MAX_AGE_MS_MAX;
    return ms;
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
    realState: RealAccountState | null,
    decided_by: string,
  ): Promise<{ failedUpdate: ReturnType<PrismaService['tradeIntent']['update']> } | { ok: true }> {
    // Global real-money kill-switch: blocks NEW entries (long/short) only. "exit"/"hold"
    // are exempt — closing/holding a position must always be reachable, same exemption as
    // every other real-mode gate. See real-execution-halt.util.ts for the KV keys and the
    // auto-trip wiring (reconciliation circuit breaker, drift detection, repeated submit
    // failures) — the flag can ONLY be cleared by a human operator (TOTP-gated endpoint),
    // never automatically.
    if (action !== 'exit' && action !== 'hold') {
      const halted = await isRealExecutionHalted(this.kv);
      if (halted) {
        this.log.warn(`REAL ORDER REJECTED [${id}]: real execution halted (kill-switch active)`);
        return {
          failedUpdate: this.db.tradeIntent.update({
            where: { id },
            data: {
              status: 'failed',
              decided_at: new Date(),
              decided_by,
              result_json: JSON.stringify({ error: 'real execution halted (kill-switch active)' }),
            },
          }),
        };
      }
    }

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

    // Defensive: opening trades require real account state (belt-and-suspenders beyond the
    // fail-closed check in autoProcess/approve — see getRealAccountState doc comment). Never
    // place a long/short order without a real RealNavSnapshot to size/risk-check against.
    // "exit"/"hold" are exempt: closing/holding never sizes off this state.
    if ((action === 'long' || action === 'short') && !realState) {
      this.log.warn(`REAL ORDER REJECTED [${id}]: real account state unavailable — safety guard`);
      return {
        failedUpdate: this.db.tradeIntent.update({
          where: { id },
          data: {
            status: 'failed',
            decided_at: new Date(),
            decided_by,
            result_json: JSON.stringify({
              error: 'real account state unavailable — cannot size/risk-check safely',
            }),
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

  /**
   * Resolves the order side + qty for `_executeReal`. Extracted to keep that function's
   * cognitive complexity within the sonarjs limit.
   *
   * "exit"  → side='sell', qty sourced from the BROKER's live position via
   *           `_resolveRealExitQty` — the paper portfolio is never mutated in real mode and
   *           is therefore stale/irrelevant here. No ceiling clamp (closing reduces risk).
   * "long"/"short" → side='buy'/'sell', qty sized against `realState.equity` (the REAL
   *           account, never paper, and never buying_power — see below) and hard-clamped to
   *           policy.max_position_pct via `_clampToPositionCeiling`, THEN capped so notional
   *           never exceeds `realState.buyingPower` (the broker's hard constraint). Sizing off
   *           equity (not buying_power) keeps real sizing consistent with the paper path: on
   *           margin accounts buying_power can exceed equity, which would otherwise make
   *           max_position_pct a larger fraction of TRUE equity than intended. The
   *           buying_power cap is a MIN, never a substitute — it can only reduce qty, never
   *           raise it above the equity-based ceiling.
   *           `realState` is guaranteed non-null here — `_checkExecuteRealPreconditions`
   *           already fails closed for opening trades without it — this null check is a
   *           second belt-and-suspenders layer, never a fallback to paper numbers. A
   *           non-finite `equity`/`buyingPower` (NaN/Infinity) also fails closed BEFORE any
   *           arithmetic — NaN comparisons are always false, so a naive qty<=0 check would
   *           silently let a NaN-sized order slip through.
   */
  private async _resolveRealSideAndQty(
    id: string,
    symbol: string,
    action: TradeAction,
    policy: ExecutionPolicy,
    realState: RealAccountState | null,
    price: number,
    sizingPct: number,
    decided_by: string,
  ): Promise<
    | { side: 'buy' | 'sell'; qty: number }
    | { failedUpdate: ReturnType<PrismaService['tradeIntent']['update']> }
  > {
    if (action === 'exit') {
      const exitQty = await this._resolveRealExitQty(
        id,
        symbol,
        policy.broker_plugin_id,
        decided_by,
      );
      if ('failedUpdate' in exitQty) return exitQty;
      return { side: 'sell', qty: exitQty.qty };
    }

    if (!realState) {
      return {
        failedUpdate: this.db.tradeIntent.update({
          where: { id },
          data: {
            status: 'failed',
            decided_at: new Date(),
            decided_by,
            result_json: JSON.stringify({
              error: 'real account state unavailable — cannot size/risk-check safely',
            }),
          },
        }),
      };
    }

    // Finite guard BEFORE any arithmetic — a non-finite equity/buying_power (NaN/Infinity)
    // must fail closed here, never silently propagate into Math.floor/comparisons (NaN
    // comparisons are always false, so a downstream qty<=0 check would never catch it).
    if (!Number.isFinite(realState.equity) || !Number.isFinite(realState.buyingPower)) {
      this.log.warn(
        `REAL ORDER REJECTED [${id}]: non-finite real account state (equity=${realState.equity}, ` +
          `buyingPower=${realState.buyingPower}) — refusing to size`,
      );
      return {
        failedUpdate: this.db.tradeIntent.update({
          where: { id },
          data: {
            status: 'failed',
            decided_at: new Date(),
            decided_by,
            result_json: JSON.stringify({
              error: 'real account state has non-finite equity/buying_power — refusing to size',
            }),
          },
        }),
      };
    }

    const side: 'buy' | 'sell' = action === 'long' ? 'buy' : 'sell';
    // Base sizing on EQUITY (never buying_power) so real sizing stays consistent with the
    // paper path — see doc comment above.
    let qty = this._clampToPositionCeiling(
      Math.floor((realState.equity * sizingPct) / price),
      realState.equity,
      price,
      policy.max_position_pct,
      id,
      action === 'long' ? 'real long' : 'real short',
    );

    // Second, independent cap: notional must never exceed the broker's actual buying power.
    // This is a MIN, never a substitute for the equity-based ceiling above — it can only
    // reduce qty further, never raise it.
    const buyingPowerMaxQty = Math.floor(realState.buyingPower / price);
    if (qty > buyingPowerMaxQty) {
      this.log.warn(
        `POSITION SIZE CAPPED BY BUYING POWER [${id}] (${action === 'long' ? 'real long' : 'real short'}): ` +
          `qty ${qty} → ${buyingPowerMaxQty} (buying_power=${realState.buyingPower} / price=${price})`,
      );
      qty = buyingPowerMaxQty;
    }

    return { side, qty };
  }

  private async _executeReal(
    id: string,
    intent: { symbol: string; action: string },
    policy: ExecutionPolicy,
    realState: RealAccountState | null,
    decided_by: string,
    sizingPct: number,
  ) {
    const symbol = intent.symbol;
    const action = intent.action as TradeAction;

    // Broker + real-state + walk-forward re-check (exit/hold exempt from the real-state and
    // walk-forward parts — see _checkExecuteRealPreconditions doc comment). Extracted to keep
    // this function's cognitive complexity within the sonarjs limit.
    const preconditions = await this._checkExecuteRealPreconditions(
      id,
      policy,
      action,
      realState,
      decided_by,
    );
    if ('failedUpdate' in preconditions) return preconditions.failedUpdate;

    // Fetch live quote — best-effort ONLY. "long"/"short" need it for sizing (qty is derived
    // from price × equity), so a missing/invalid quote must still fail those. "exit"/"hold"
    // must NEVER depend on it: a real exit's qty is sourced from the BROKER's live position
    // via `_resolveRealSideAndQty` → `_resolveRealExitQty` (a market order — no price needed
    // to size it), and the quote here is used only for the WARN log below and the notional
    // ceiling, which already exempts exits (see the ceiling check further down). Failing an
    // exit/hold on a market-data outage would strand a real position open — violating the
    // "exit/hold always closeable" invariant (see class-level risk-kernel doc). A quote
    // failure is therefore swallowed here for exit/hold; `price` stays NaN and is only ever
    // used for logging in that path.
    let price = NaN;
    let quoteError: string | null = null;
    try {
      const quote = await this.gateway.getQuote(null, symbol);
      price = quote.last;
    } catch (err) {
      quoteError = String(err);
    }
    const quoteInvalid = quoteError !== null || !isFinite(price) || price <= 0;

    if (quoteInvalid && (action === 'long' || action === 'short')) {
      const reason = quoteError ?? `Invalid quote price: ${price}`;
      this.log.warn(`REAL ORDER FAILED [${id}]: ${reason} for ${symbol}`);
      return this.db.tradeIntent.update({
        where: { id },
        data: {
          status: 'failed',
          decided_at: new Date(),
          decided_by,
          result_json: JSON.stringify({ error: reason }),
        },
      });
    }
    if (quoteInvalid) {
      const quoteIssue = quoteError ?? `invalid price ${price}`;
      this.log.warn(
        `REAL ORDER [${id}]: quote unavailable for ${symbol} (${quoteIssue}) ` +
          `— proceeding anyway, ${action} does not depend on the quote`,
      );
    }

    // 'hold' — should have been short-circuited before reaching here; defensive no-op.
    if (action === 'hold') {
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

    // Compute side and qty. Extracted to keep this function's cognitive complexity within
    // the sonarjs limit.
    const resolved = await this._resolveRealSideAndQty(
      id,
      symbol,
      action,
      policy,
      realState,
      price,
      sizingPct,
      decided_by,
    );
    if ('failedUpdate' in resolved) return resolved.failedUpdate;
    const { side, qty } = resolved;

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

    // Submit through RealOrderService — it owns client_order_id generation, creates the
    // RealOrder row BEFORE any broker call (crash-safe), and is idempotent per
    // trade_intent_id. It never throws for a broker-side failure (returns a
    // status="submit_failed" row instead) but CAN throw for a genuine DB failure on the
    // initial row create (see its class doc) — wrap defensively so _executeReal itself
    // still never throws to its caller.
    let realOrder: Awaited<ReturnType<RealOrderService['submit']>>;
    try {
      realOrder = await this.realOrderService.submit({
        tradeIntentId: id,
        brokerPluginId: policy.broker_plugin_id,
        symbol,
        side,
        requestedQty: qty,
      });
    } catch (err) {
      this.log.warn(`REAL ORDER SUBMIT THREW [${id}]: ${String(err)}`);
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

    if (realOrder.status === 'submit_failed') {
      this.log.warn(
        `REAL ORDER SUBMIT FAILED [${id}]: ${side} ${qty} ${symbol} — ${realOrder.error ?? 'unknown error'}`,
      );
      return this.db.tradeIntent.update({
        where: { id },
        data: {
          status: 'failed',
          decided_at: new Date(),
          decided_by,
          result_json: JSON.stringify({
            error: realOrder.error ?? 'real order submission failed',
            qty,
            side,
            symbol,
          }),
        },
      });
    }

    this.log.warn(
      `REAL ORDER SUBMITTED [${id}]: ${side.toUpperCase()} ${qty} ${symbol} — ` +
        `real_order_id=${realOrder.id} status=${realOrder.status}`,
    );

    // Fire-and-forget: kick off the fast-poll backoff burst so a fast-filling order is
    // reflected without waiting for the steady-state reconciliation interval. NEVER awaited
    // here — must not block _executeReal — and its rejection must never propagate to the
    // caller (fastPollOrder is already fail-soft internally, but this .catch is a second
    // line of defense against a genuinely unexpected throw).
    void this.reconciliation
      .fastPollOrder(realOrder.id)
      .catch((err: unknown) =>
        this.log.error(
          `fastPollOrder fire-and-forget failed for RealOrder ${realOrder.id}: ${String(err)}`,
        ),
      );

    // No fabricated fill: a submitted order is only ACCEPTED, not filled — brokers fill
    // asynchronously. fill_price/quantity stay NULL until the reconciliation service
    // observes an actual fill from the broker and updates this row.
    return this.db.tradeIntent.update({
      where: { id },
      data: {
        status: 'real_pending',
        decided_at: new Date(),
        decided_by,
        result_json: JSON.stringify({
          requested_qty: qty,
          side,
          broker: policy.broker_plugin_id,
          real_order_id: realOrder.id,
          real_order_status: realOrder.status,
        }),
      },
    });
  }

  // ── _computeDrawdownPct ───────────────────────────────────────────────────────

  /**
   * Real drawdown from the true high-water-mark (hwm).
   *
   * Paper mode: read from the PAPER PORTFOLIO itself — the same state the kernel actually
   * sizes/gates against. hwm defaults to the current equity when unset (fresh portfolio, no
   * trades yet), so a brand-new paper account is NEVER false-halted on its very first trade.
   *
   * Real mode: read from RealAccountState (sourced from the latest RealNavSnapshot for the
   * configured broker — see getRealAccountState). hwm is always present on that row (never
   * defaulted) — callers must FAIL CLOSED upstream when no RealNavSnapshot exists at all
   * (state is `null`), rather than calling this with a fabricated 0%-drawdown state.
   */
  private _computeDrawdownPct(
    state: PaperState | RealAccountState,
    mode: 'paper' | 'real',
  ): number {
    if (mode === 'real') {
      const real = state as RealAccountState;
      return real.hwm > 0 ? Math.max(0, ((real.hwm - real.equity) / real.hwm) * 100) : 0;
    }
    const paper = state as PaperState;
    const hwm = paper.hwm ?? paper.equity;
    return hwm > 0 ? Math.max(0, ((hwm - paper.equity) / hwm) * 100) : 0;
  }

  // ── _passesAutoRisk ───────────────────────────────────────────────────────────

  /**
   * Kernel risk gate for NEW ENTRIES (long/short). Called from BOTH autoProcess()
   * and approve() — the human-approval path must not bypass these checks.
   * "exit"/"hold" are never gated here (callers must keep letting position-closing
   * actions through even during an active halt).
   *
   * Paper mode gates against `state.positions.length` (PaperState). Real mode gates against
   * `state.openPositionsCount` (RealAccountState, sourced from RealPosition rows) — callers
   * must never pass paperState here for a real-mode check (see getRealAccountState).
   */
  private _passesAutoRisk(
    state: PaperState | RealAccountState,
    policy: ExecutionPolicy,
    mode: 'paper' | 'real',
  ): { pass: boolean; reason?: string } {
    const drawdown = this._computeDrawdownPct(state, mode);
    if (drawdown >= policy.max_drawdown_halt_pct) {
      return {
        pass: false,
        reason: `circuit breaker: drawdown ${drawdown}% >= ${policy.max_drawdown_halt_pct}%`,
      };
    }

    const openPositions =
      mode === 'real'
        ? (state as RealAccountState).openPositionsCount
        : (state as PaperState).positions.length;
    if (openPositions >= policy.max_open_positions) {
      return {
        pass: false,
        reason: `max open positions reached (${openPositions}/${policy.max_open_positions})`,
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
