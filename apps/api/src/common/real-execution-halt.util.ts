/**
 * Global real-money kill-switch — halts all NEW real long/short entries platform-wide.
 * "exit"/"hold" are NEVER affected (closing a position must always be reachable — same
 * exemption used everywhere else in the real-execution kernel, see TradeIntentService).
 *
 * State lives in two plain KV keys (configEntry table), read/written directly via
 * KvService — mirrors how other feature modules (e.g. real-reconciliation's circuit
 * breaker) provide KvService directly rather than via a shared CommonModule, so this
 * stays a plain function module with no DI wiring of its own:
 *   - real_execution.halted: 'true' | 'false' (kvBool, default false)
 *   - real_execution.halt_reason: free-text reason for the most recent trip
 *
 * NO AUTO-CLEAR, EVER: haltRealExecution() may be called from anywhere (reconciliation
 * circuit breaker, drift detection, repeated order-submit failures) to trip the switch,
 * but only clearRealExecutionHalt() may un-trip it — and that is wired to an
 * operator-only, TOTP-gated endpoint (see ExecutionController). A subsequent healthy
 * cycle (a successful reconcile tick, a successful order submit, ...) must never clear
 * this flag on its own.
 */
import { KvService } from './kv.service';
import { kvBool } from './kv.util';

export const REAL_EXECUTION_HALTED_KEY = 'real_execution.halted';
export const REAL_EXECUTION_HALT_REASON_KEY = 'real_execution.halt_reason';

export interface RealExecutionHaltStatus {
  halted: boolean;
  reason: string | null;
}

/** Whether the real-execution kill-switch is currently tripped. Default: not halted. */
export async function isRealExecutionHalted(kv: KvService): Promise<boolean> {
  const raw = await kv.get(REAL_EXECUTION_HALTED_KEY);
  return kvBool(raw, false);
}

/**
 * Trips the kill-switch with the given reason. Idempotent/safe to call repeatedly — each
 * call overwrites the reason with the latest trigger. Never clears the flag itself.
 */
export async function haltRealExecution(kv: KvService, reason: string): Promise<void> {
  await kv.set(REAL_EXECUTION_HALTED_KEY, 'true');
  await kv.set(REAL_EXECUTION_HALT_REASON_KEY, reason);
}

/**
 * Clears the kill-switch. Must ONLY ever be invoked explicitly by a human operator
 * (the TOTP-gated clear endpoint) — never automatically by a healthy cycle.
 */
export async function clearRealExecutionHalt(kv: KvService): Promise<void> {
  await kv.set(REAL_EXECUTION_HALTED_KEY, 'false');
  await kv.delete(REAL_EXECUTION_HALT_REASON_KEY);
}

/** Full status for the operator-facing read-only status endpoint. */
export async function getRealExecutionHaltStatus(kv: KvService): Promise<RealExecutionHaltStatus> {
  const [rawHalted, rawReason] = await Promise.all([
    kv.get(REAL_EXECUTION_HALTED_KEY),
    kv.get(REAL_EXECUTION_HALT_REASON_KEY),
  ]);
  const halted = kvBool(rawHalted, false);
  return { halted, reason: halted ? (rawReason ?? null) : null };
}
