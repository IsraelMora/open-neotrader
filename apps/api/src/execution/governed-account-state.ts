/**
 * Shared governed-execution types — the unified account/risk/fill vocabulary used by BOTH
 * the real/live-paper path (TradeIntentService) and the pretest path (PretestService), via
 * GovernedPaperExecutionService.
 *
 * Canonical action vocabulary is long/short/exit/hold ONLY. No buy/sell/close/cover
 * synonyms anywhere in this core — callers translate their own vocabulary (if any) BEFORE
 * reaching this layer. This is intentional: a single vocabulary is what makes the gate/fill
 * logic provably identical across callers.
 */

export const GOVERNED_ACTIONS = ['long', 'short', 'exit', 'hold'] as const;
export type TradeAction = (typeof GOVERNED_ACTIONS)[number];

export interface GovernedPosition {
  symbol: string;
  /** Signed quantity: positive = long, negative = short. */
  quantity: number;
  avg_price: number;
}

/**
 * Superset of PaperState's fields — generic account state the entry gates and fill logic
 * operate on, independent of WHERE it's persisted (Portfolio row for the live paper account,
 * PretestPortfolio.state for a pretest portfolio). Callers own persistence; this core is a
 * pure/async-fetch-only computation layer.
 */
export interface GovernedAccountState {
  equity: number;
  cash: number;
  positions: GovernedPosition[];
  /** High-water-mark equity. Defaults to `equity` when unset (fresh account). */
  hwm?: number;
  /** UTC calendar-day key ("YYYY-MM-DD") for the daily loss circuit-breaker baseline. */
  day_key?: string;
  day_start_equity?: number;
  /** UTC Monday-anchored week-start key for the weekly loss circuit-breaker baseline. */
  week_key?: string;
  week_start_equity?: number;
  /** Peak-to-trough tracking fields some callers (pretest) also carry on their own ledger.
   * Not read by this core's gates (which use `hwm`/`equity` instead) — kept optional here
   * purely so callers can round-trip their own state shape through GovernedAccountState. */
  max_equity?: number;
  max_drawdown_pct?: number;
}

/**
 * Kernel risk floor — the SAME shape/semantics as TradeIntentService's ExecutionPolicy risk
 * fields. A pretest portfolio's RiskPolicy must come from the same global KV `execution.*`
 * keys (may only be STRICTER, never looser, than what the real account uses).
 */
export interface RiskPolicy {
  max_position_pct: number;
  max_open_positions: number;
  max_drawdown_halt_pct: number;
  max_short_notional_pct: number;
  loss_circuit_breaker_enabled: boolean;
  max_daily_loss_pct: number;
  max_weekly_loss_pct: number;
}

/**
 * Per-call fill sizing/execution-cost knobs. `slippage_pct`/`commission_pct` default to 0 so
 * the real/live-paper caller (which never modeled either) gets byte-identical fills; pretest
 * passes its own PretestPolicy-derived values to keep its existing commission/slippage
 * modeling working through the shared core.
 */
export interface FillPolicy {
  sizingPct: number;
  maxPositionPct: number;
  maxShortNotionalPct: number;
  slippagePct?: number;
  commissionPct?: number;
}

export interface EntryGateResult {
  pass: boolean;
  reason?: string;
  /** Possibly period-baseline-reset (and/or MTM-refreshed) state — callers MUST use this for
   * any subsequent execution/persistence, mirroring the original _passesPaperEntryGate contract. */
  state: GovernedAccountState;
  /** True when a day/week baseline rollover was detected — callers whose entry is ultimately
   * REJECTED must persist `state` immediately (a rejected intent never reaches the fill step,
   * so without this the rollover would otherwise be silently lost). */
  baselineChanged: boolean;
}

export interface FillResult {
  quantity: number;
  realized_pnl: number | null;
  newState: GovernedAccountState;
}

export interface EvaluateAndExecuteResult extends FillResult {
  pass: boolean;
  reason?: string;
  baselineChanged: boolean;
}
