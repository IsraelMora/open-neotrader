/**
 * RealBrokerReconciliationService — reconciles a single RealOrder row against
 * broker truth.
 *
 * Money-critical invariant: a fill must never appear on one side of the ledger
 * without the other. Any transition into a terminal state that also changes
 * TradeIntent (filled / rejected / canceled / expired) is written in ONE
 * `$transaction` call touching both RealOrder and TradeIntent — never two
 * separate awaited updates.
 *
 * Fail-soft: reconcileOrder() NEVER throws to its caller. A broker lookup
 * error is logged and `last_reconciled_at` is bumped (no status change); the
 * caller (a future polling loop, not implemented in this slice) can simply
 * retry on the next tick.
 *
 * No-fabricated-fill invariant: a fill is only recorded when the broker
 * reports status "filled" AND filled_qty/filled_avg_price are both finite and
 * strictly positive. A status string alone is not trusted — defensive against
 * a malformed/partial broker response that could otherwise mislabel an order
 * as filled with garbage numbers.
 *
 * This slice also implements the reconciliation polling machinery around
 * reconcileOrder():
 *   - fastPollOrder(realOrderId): a short backoff burst (2s/4s/8s/16s) run
 *     right after a real order is submitted, so a fast-filling order is
 *     reflected without waiting for the steady-state interval.
 *   - reconcileAllOpenOrders(): reconciles every non-terminal RealOrder row
 *     (status in submitted/accepted/partially_filled).
 *   - onModuleInit()/onModuleDestroy(): a KV-configured setInterval loop that
 *     calls reconcileAllOpenOrders() on a steady cadence, with an overlap
 *     guard (skip a tick if the previous one is still running) and a
 *     KV-persisted, half-open circuit breaker — mirrors
 *     CycleSchedulerService's breaker (see scheduler/cycle-scheduler.service.ts
 *     CB_KEY/CB_HALF_OPEN_MS) rather than dying permanently in memory: after
 *     CB_MAX_FAILURES consecutive tick failures the breaker opens (persisted
 *     to KV) and a CRITICAL AlertEntry is emitted so an operator sees the
 *     halt; after CB_HALF_OPEN_MS the next tick is a half-open probe — a
 *     success closes the breaker and resumes normal ticking, a failure
 *     reopens it. getCircuitBreaker() exposes the state for a later
 *     health/kill-switch endpoint.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  ProviderGatewayService,
  OrderStatusResult,
  Position,
} from '../providers/provider-gateway.service';
import { KvService } from '../common/kv.service';
import { kvNum, kvStr } from '../common/kv.util';
import { normalizeBrokerStatus } from '../common/broker-status.util';
import { AlertsService } from '../alerts/alerts.service';
import type { RealOrder } from '@prisma/client';

/** Persisted circuit-breaker state — mirrors CycleSchedulerService.CircuitBreakerState. */
export interface ReconciliationCircuitBreakerState {
  state: 'closed' | 'open' | 'half_open';
  consecutive_failures: number;
  last_failure_at: string | null;
  last_success_at: string | null;
  reason: string | null;
}

const CLOSED_CB: ReconciliationCircuitBreakerState = {
  state: 'closed',
  consecutive_failures: 0,
  last_failure_at: null,
  last_success_at: null,
  reason: null,
};

/**
 * RealOrder statuses that can never receive further broker activity.
 * "submitted" is this service's own pre-broker-confirmation status (written
 * by RealOrderService.submit before the first reconcile); it is NOT part of
 * the shared broker-status vocabulary (see common/broker-status.util.ts)
 * since no broker ever reports "submitted" — it's added here alongside the
 * broker-derived terminal set below.
 */
const TERMINAL_STATUSES = ['filled', 'canceled', 'rejected', 'expired'];

/** RealOrder statuses that are still open and eligible for reconciliation. */
const OPEN_STATUSES = ['submitted', 'accepted', 'partially_filled'];

/** fastPollOrder backoff schedule (ms) — total window ~30s. */
const FAST_POLL_DELAYS_MS = [2_000, 4_000, 8_000, 16_000];

const RECONCILE_INTERVAL_KEY = 'execution.real_reconciliation_interval_ms';
const DEFAULT_RECONCILE_INTERVAL_MS = 15_000;
const MIN_RECONCILE_INTERVAL_MS = 5_000;

/** Consecutive tick failures before the circuit breaker opens. */
const CB_MAX_FAILURES = 3;
/** KV key the circuit breaker state is persisted under (survives process restarts). */
const CB_KEY = 'real_reconciliation:circuit_breaker';
/** Cooldown before a half-open retry attempt — mirrors CycleSchedulerService's CB_HALF_OPEN_MS. */
const CB_HALF_OPEN_MS = 5 * 60_000;

/** KV key for the active broker plugin id — same key _effectiveMode (TradeIntentService) reads. */
const BROKER_PLUGIN_ID_KEY = 'execution.broker_plugin_id';

/** RealOrder statuses that count as evidence explaining a broker position (see detectDrift). */
const FILL_EVIDENCE_STATUSES = ['filled', 'partially_filled'];

/**
 * Minimum spacing between steady-state-tick-triggered portfolio syncs. The
 * reconciliation interval (default 15s, min-clamped 5s) is much finer-grained
 * than a full portfolio/NAV snapshot needs to be — this throttles poll-sourced
 * syncPortfolio calls to roughly once a minute via a lastPortfolioSyncAt
 * timestamp check. Does NOT apply to the one startup_reconcile call.
 */
const PORTFOLIO_SYNC_THROTTLE_MS = 60_000;

@Injectable()
export class RealBrokerReconciliationService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(RealBrokerReconciliationService.name);

  private ticker: ReturnType<typeof setInterval> | null = null;
  /** Overlap guard — true while a tick's reconcileAllOpenOrders() call is in flight. */
  private tickRunning = false;
  /** Wall-clock ms of the last syncPortfolio() call — drives the poll-tick throttle. */
  private lastPortfolioSyncAt: number | null = null;

  constructor(
    private readonly db: PrismaService,
    private readonly gateway: ProviderGatewayService,
    private readonly kv: KvService,
    private readonly alerts: AlertsService,
  ) {}

  /**
   * Reconciles one RealOrder against broker truth. See class doc for the
   * transactional-fill and fail-soft invariants. Sequence:
   *   1. Load the row. Already-terminal → no-op (idempotent re-reconcile).
   *   2. Ask the broker: getOrderStatus if broker_order_id is known, else
   *      getOrderByClientId (client_order_id is always present).
   *      - Lookup throws → fail-soft: log, bump last_reconciled_at, return.
   *      - getOrderByClientId confirms a 404 (null) → leave the row as-is
   *        (still bump last_reconciled_at), no fabricated fill.
   *   3. Map broker status → RealOrder status, with a numeric sanity guard on
   *      "filled" (see class doc).
   *   4. Write the outcome (transactional for filled / rejected / canceled /
   *      expired; a plain update for partially_filled since TradeIntent does
   *      not change on that branch).
   */
  async reconcileOrder(realOrderId: string): Promise<void> {
    const row = await this.db.realOrder.findUnique({ where: { id: realOrderId } });
    if (!row) {
      this.log.warn(`reconcileOrder: no RealOrder found for id=${realOrderId}`);
      return;
    }
    if (TERMINAL_STATUSES.includes(row.status)) {
      // Already terminal — idempotent no-op, no broker call needed.
      return;
    }

    let brokerOrder: OrderStatusResult | null;
    try {
      brokerOrder = row.broker_order_id
        ? await this.gateway.getOrderStatus(row.broker_plugin_id, row.broker_order_id)
        : await this.gateway.getOrderByClientId(row.broker_plugin_id, row.client_order_id);
    } catch (err) {
      // Lookup-error branch — fail-soft: record the attempt, never throw.
      this.log.warn(
        `reconcileOrder: broker lookup failed for RealOrder ${row.id} (client_order_id=${row.client_order_id}): ${String(err)}`,
      );
      await this.touchLastReconciledAt(row.id);
      return;
    }

    if (brokerOrder === null) {
      // Confirmed 404 — broker never received this order. Do NOT fabricate a
      // fill and do NOT change status; still record the reconcile attempt.
      this.log.log(
        `reconcileOrder: broker confirms no record of RealOrder ${row.id} (client_order_id=${row.client_order_id}) — left as-is`,
      );
      await this.touchLastReconciledAt(row.id);
      return;
    }

    await this.applyBrokerOrder(row, brokerOrder);
  }

  /**
   * Applies broker truth to a RealOrder row. Uses the SAME shared normalizer
   * (normalizeBrokerStatus) as RealOrderService.recoverRow — see
   * common/broker-status.util.ts's module doc for why one shared vocabulary
   * is mandatory: divergent mappings between the two services could leave an
   * order un-pollable or double-mapped inconsistently.
   *
   * Fix 3 (optimistic concurrency): a write that changes RealOrder.status is
   * ALWAYS a compare-and-set — `updateMany({ where: { id, status: row.status
   * } })` — never a bare `update`. row.status is the status this call
   * actually observed via findUnique() at the top of reconcileOrder(). If a
   * concurrent writer (e.g. a fastPollOrder tick racing the steady-state
   * loop) already advanced the row past that status, the WHERE no longer
   * matches, `count` comes back 0, and this call backs off — it must NEVER
   * downgrade a row another writer already moved further along, and for the
   * transactional branches it must NEVER touch TradeIntent when the
   * RealOrder side of the CAS was rejected (that would desync the ledger the
   * other way).
   */
  private async applyBrokerOrder(row: RealOrder, brokerOrder: OrderStatusResult): Promise<void> {
    const now = new Date();
    const canonical = normalizeBrokerStatus(brokerOrder.status);
    const isValidFillEvidence =
      Number.isFinite(brokerOrder.filled_qty) &&
      brokerOrder.filled_qty > 0 &&
      brokerOrder.filled_avg_price !== null &&
      Number.isFinite(brokerOrder.filled_avg_price) &&
      brokerOrder.filled_avg_price > 0;

    if (canonical === 'filled' && !isValidFillEvidence) {
      // Defensive: broker status string says filled, but the numeric evidence
      // is not trustworthy — treat as not-yet-filled rather than fabricate.
      this.log.warn(
        `reconcileOrder: RealOrder ${row.id} broker status="${brokerOrder.status}" but filled_qty=${brokerOrder.filled_qty} ` +
          `filled_avg_price=${brokerOrder.filled_avg_price} is not valid positive numeric evidence — not recording a fill`,
      );
      await this.touchLastReconciledAt(row.id);
      return;
    }

    if (canonical === 'filled' && isValidFillEvidence) {
      await this.db.$transaction(async (tx) => {
        const result = await tx.realOrder.updateMany({
          where: { id: row.id, status: row.status },
          data: {
            status: 'filled',
            broker_order_id: brokerOrder.broker_order_id,
            filled_qty: brokerOrder.filled_qty,
            filled_avg_price: brokerOrder.filled_avg_price,
            filled_at: now,
            last_reconciled_at: now,
          },
        });
        if (result.count === 0) {
          this.log.warn(
            `reconcileOrder: stale fill write skipped for RealOrder ${row.id} — status ` +
              `changed since this call's read (expected "${row.status}")`,
          );
          return;
        }
        await tx.tradeIntent.update({
          where: { id: row.trade_intent_id },
          data: {
            status: 'executed',
            fill_price: brokerOrder.filled_avg_price,
            quantity: brokerOrder.filled_qty,
          },
        });
      });
      return;
    }

    if (canonical === 'partially_filled') {
      // Future work: partial_fill_timeout_minutes — an auto-cancel-of-remainder-
      // on-timeout feature should watch rows stuck in partially_filled past a
      // configurable window. Not implemented in this slice — no timer here.
      const result = await this.db.realOrder.updateMany({
        where: { id: row.id, status: row.status },
        data: {
          status: 'partially_filled',
          filled_qty: brokerOrder.filled_qty,
          filled_avg_price: brokerOrder.filled_avg_price,
          last_reconciled_at: now,
        },
      });
      if (result.count === 0) {
        this.log.warn(
          `reconcileOrder: stale partially_filled write skipped for RealOrder ${row.id} — ` +
            `status changed since this call's read (expected "${row.status}")`,
        );
      }
      return;
    }

    if (canonical === 'rejected' || canonical === 'canceled' || canonical === 'expired') {
      const rejectReason = this.extractRejectReason(brokerOrder);
      await this.db.$transaction(async (tx) => {
        const result = await tx.realOrder.updateMany({
          where: { id: row.id, status: row.status },
          data: {
            status: canonical,
            broker_order_id: brokerOrder.broker_order_id,
            last_reconciled_at: now,
          },
        });
        if (result.count === 0) {
          this.log.warn(
            `reconcileOrder: stale ${canonical} write skipped for RealOrder ${row.id} — status ` +
              `changed since this call's read (expected "${row.status}")`,
          );
          return;
        }
        await tx.tradeIntent.update({
          where: { id: row.trade_intent_id },
          data: {
            status: 'failed',
            reject_reason: rejectReason,
          },
        });
      });
      return;
    }

    // canonical === 'accepted' (still open — "new"/"accepted"/"held"/etc., or an
    // unrecognized status normalized fail-open) — leave the RealOrder status as-is,
    // just record the reconcile attempt. Fix 4: backfill broker_order_id when this
    // row was looked up by client_order_id and didn't have one yet, so future polls
    // use the direct getOrderStatus(broker_order_id) lookup instead.
    await this.touchLastReconciledAt(
      row.id,
      row.broker_order_id ? undefined : brokerOrder.broker_order_id,
    );
  }

  /**
   * Records a reconcile attempt without changing status (fail-soft / not-found /
   * not-yet-final paths). Optionally backfills broker_order_id (Fix 4) — pass a
   * value only when the row didn't already have one; omit/undefined leaves it
   * untouched.
   */
  private async touchLastReconciledAt(
    realOrderId: string,
    backfillBrokerOrderId?: string | null,
  ): Promise<void> {
    try {
      await this.db.realOrder.update({
        where: { id: realOrderId },
        data: {
          last_reconciled_at: new Date(),
          ...(backfillBrokerOrderId ? { broker_order_id: backfillBrokerOrderId } : {}),
        },
      });
    } catch (err) {
      this.log.error(
        `reconcileOrder: failed to record last_reconciled_at for RealOrder ${realOrderId}: ${String(err)}`,
      );
    }
  }

  /** Broker-provided rejection reason, falling back to a generic message built from the status. */
  private extractRejectReason(brokerOrder: OrderStatusResult): string {
    const raw = brokerOrder.raw;
    if (raw && typeof raw === 'object') {
      const reason = (raw as Record<string, unknown>)['reject_reason'];
      if (typeof reason === 'string' && reason.length > 0) return reason;
    }
    return `Broker order ${brokerOrder.status}`;
  }

  // ── fastPollOrder ─────────────────────────────────────────────────────────

  /**
   * Awaitable delay, isolated behind a protected method so tests can drive it
   * deterministically with fake timers instead of sleeping for real.
   */
  protected delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Short backoff burst run right after a real order submit, so a fast-filling
   * order is reflected without waiting for the steady-state interval.
   * Schedule: wait 2s, poll, wait 4s, poll, wait 8s, poll, wait 16s, poll
   * (total window ~30s). Stops as soon as the RealOrder reaches a terminal
   * status. NEVER throws — every failure is logged and the loop continues to
   * the next attempt; if the window elapses without reaching terminal status,
   * this simply returns (the steady-state loop will pick it up later).
   */
  async fastPollOrder(realOrderId: string): Promise<void> {
    try {
      for (const delayMs of FAST_POLL_DELAYS_MS) {
        await this.delay(delayMs);

        try {
          await this.reconcileOrder(realOrderId);
        } catch (err) {
          this.log.warn(`fastPollOrder: reconcileOrder failed for ${realOrderId}: ${String(err)}`);
          continue;
        }

        const row = await this.db.realOrder.findUnique({ where: { id: realOrderId } });
        if (row && TERMINAL_STATUSES.includes(row.status)) {
          return;
        }
      }
    } catch (err) {
      // Fail-soft — fastPollOrder must never throw to its caller.
      this.log.warn(`fastPollOrder: unexpected error for ${realOrderId}: ${String(err)}`);
    }
  }

  // ── reconcileAllOpenOrders ────────────────────────────────────────────────

  /**
   * Reconciles every RealOrder row still open with the broker (status in
   * submitted/accepted/partially_filled — NOT pending_submit/submit_failed,
   * which are handled by RealOrderService.recoverInflight). Processed
   * sequentially; one order's reconcileOrder() throwing does not stop the
   * others (reconcileOrder is itself fail-soft, but this is an extra
   * per-order guard for defense in depth).
   */
  async reconcileAllOpenOrders(): Promise<void> {
    const rows = await this.db.realOrder.findMany({
      where: { status: { in: OPEN_STATUSES } },
    });

    for (const row of rows) {
      try {
        await this.reconcileOrder(row.id);
      } catch (err) {
        this.log.warn(
          `reconcileAllOpenOrders: reconcileOrder failed for ${row.id}: ${String(err)}`,
        );
      }
    }
  }

  // ── steady-state loop ─────────────────────────────────────────────────────

  /**
   * Runs one reconcileAllOpenOrders() at startup (in addition to, not instead
   * of, RealOrderService.recoverInflight, which runs in its own onModuleInit),
   * then starts a KV-configured setInterval loop.
   */
  async onModuleInit(): Promise<void> {
    // Runs BEFORE tick(): primes lastPortfolioSyncAt so tick()'s own
    // _maybeSyncPortfolioOnTick() (poll-throttled) does not double-sync on
    // the very first tick.
    await this._syncPortfolioAtStartup();
    await this.tick();
    const intervalMs = await this._readIntervalMs();
    this.ticker = setInterval(() => void this.tick(), intervalMs);
    this.log.log(`Real broker reconciliation loop started (interval=${intervalMs}ms)`);
  }

  onModuleDestroy(): void {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  /** Reads the steady-state interval from KV, clamped to a minimum of 5000ms. */
  private async _readIntervalMs(): Promise<number> {
    let raw: string | null;
    try {
      raw = await this.kv.get(RECONCILE_INTERVAL_KEY);
    } catch {
      raw = null;
    }
    let ms = kvNum(raw, DEFAULT_RECONCILE_INTERVAL_MS);
    if (!Number.isFinite(ms) || ms < MIN_RECONCILE_INTERVAL_MS) {
      ms = MIN_RECONCILE_INTERVAL_MS;
    }
    return ms;
  }

  /**
   * One scheduled tick: overlap guard (skip if the previous tick is still
   * running) + a KV-persisted, half-open circuit breaker.
   *
   * The ticker interval itself is NEVER cleared by the circuit breaker (unlike
   * onModuleDestroy, which clears it on shutdown) — that would be the
   * permanent-silent-halt bug this replaces. Instead, every tick reads the
   * persisted breaker state first:
   *   - closed → attempt normally.
   *   - open, still within CB_HALF_OPEN_MS of the last failure → skip this
   *     tick entirely (no reconcileAllOpenOrders call, no state change).
   *   - open, cooldown elapsed → transition to half_open and attempt (a
   *     single probe). Success closes the breaker; failure reopens it.
   * A transition INTO "open" (from closed or half_open) emits a CRITICAL
   * RECONCILIATION_HALTED AlertEntry so the halt is visible to an operator,
   * not just a silent stop.
   */
  private async tick(): Promise<void> {
    // Portfolio sync is a separate concern from order reconciliation (own
    // internal throttle + fail-soft handling) — runs independently of the
    // overlap guard/circuit breaker below, which only govern
    // reconcileAllOpenOrders().
    await this._maybeSyncPortfolioOnTick();

    if (this.tickRunning) return;

    let cb = await this.getCircuitBreaker();
    if (cb.state === 'open') {
      const lastFailureMs = cb.last_failure_at ? new Date(cb.last_failure_at).getTime() : 0;
      if (Date.now() < lastFailureMs + CB_HALF_OPEN_MS) {
        // Still cooling down — skip this tick without touching KV or attempting anything.
        return;
      }
      // Cooldown elapsed — this tick is a half-open probe attempt.
      cb = { ...cb, state: 'half_open' };
      await this._saveCb(cb);
    }

    this.tickRunning = true;
    try {
      await this.reconcileAllOpenOrders();
      await this._saveCb({
        state: 'closed',
        consecutive_failures: 0,
        last_failure_at: cb.last_failure_at,
        last_success_at: new Date().toISOString(),
        reason: null,
      });
    } catch (err) {
      await this._handleTickFailure(err, cb);
    } finally {
      this.tickRunning = false;
    }
  }

  /** Handles a whole-tick failure: bumps the persisted breaker state and alerts on a fresh trip. */
  private async _handleTickFailure(
    err: unknown,
    cb: ReconciliationCircuitBreakerState,
  ): Promise<void> {
    const msg = err instanceof Error ? err.message : String(err);
    const failures = cb.consecutive_failures + 1;
    this.log.error(`reconciliation tick failed (${failures}/${CB_MAX_FAILURES}): ${msg}`);

    // A half-open probe failing reopens immediately, regardless of the failure count —
    // the whole point of the probe is "is it safe to resume yet", and it just said no.
    const tripped = failures >= CB_MAX_FAILURES || cb.state === 'half_open';
    const newCb: ReconciliationCircuitBreakerState = {
      state: tripped ? 'open' : 'closed',
      consecutive_failures: failures,
      last_failure_at: new Date().toISOString(),
      last_success_at: cb.last_success_at,
      reason: msg.slice(0, 200),
    };
    await this._saveCb(newCb);

    if (tripped && cb.state !== 'open') {
      // Fresh transition into "open" (was closed or half_open, not already open) — alert.
      this.log.error(
        `Real broker reconciliation circuit breaker OPEN after ${failures} consecutive ` +
          `failures — reconciliation halted, retrying after a half-open cooldown of ` +
          `${CB_HALF_OPEN_MS / 60000}min`,
      );
      try {
        await this.alerts.create({
          type: 'RECONCILIATION_HALTED',
          severity: 'CRITICAL',
          message:
            `Real-money order reconciliation halted after ${failures} consecutive tick ` +
            `failures: ${msg.slice(0, 200)}`,
        });
      } catch (alertErr) {
        this.log.error(
          `Failed to emit RECONCILIATION_HALTED alert (reconciliation is still halted): ${String(alertErr)}`,
        );
      }
    }
  }

  /**
   * Public getter exposing the persisted circuit breaker state — for a later
   * health-check / kill-switch endpoint (not implemented in this slice).
   */
  async getCircuitBreaker(): Promise<ReconciliationCircuitBreakerState> {
    let raw: string | null;
    try {
      raw = await this.kv.get(CB_KEY);
    } catch {
      raw = null;
    }
    if (!raw) return { ...CLOSED_CB };
    try {
      return JSON.parse(raw) as ReconciliationCircuitBreakerState;
    } catch {
      return { ...CLOSED_CB };
    }
  }

  private async _saveCb(state: ReconciliationCircuitBreakerState): Promise<void> {
    await this.kv.set(CB_KEY, JSON.stringify(state));
  }

  // ── syncPortfolio / detectDrift ───────────────────────────────────────────

  /**
   * Reconciles the FULL broker position/equity snapshot — a different concern
   * from reconcileOrder (single-order fill status). Sequence:
   *   1. getPortfolio(brokerPluginId) — broker truth. Fail-soft: a throw here
   *      is logged and this method returns cleanly with NO writes (no partial
   *      RealPosition/RealNavSnapshot state) and does not propagate.
   *   2. Full-replace RealPosition rows for this broker inside ONE
   *      `$transaction` (interactive callback form — see class doc): upsert
   *      every broker position, delete rows for this broker whose symbol is
   *      no longer reported. Readers never observe a half-updated set.
   *   3. Inside the SAME transaction, append one RealNavSnapshot row. HWM is
   *      read from the most recent prior RealNavSnapshot for this broker
   *      (order by ts desc, take 1) INSIDE the transaction — reading it
   *      outside would open a race window where a concurrent sync could
   *      commit a higher hwm between the read and this write. `hwm =
   *      max(previousHwm, equity)`; if no prior snapshot exists, `hwm =
   *      equity`. Never regresses.
   *   4. AFTER the transaction commits (so detectDrift's alerting reflects
   *      the just-committed cache, not a pre-commit view), detectDrift()
   *      checks each broker position for unexplained history and alerts.
   *      driftedSymbols is returned untouched by anything above — broker
   *      truth always wins on cache state regardless of drift.
   *
   * Future work: R8 (auto-kill-switch) will consume the returned
   * driftedSymbols to halt trading when an unexplained broker position is
   * detected. Not implemented in this slice — this return shape is the seam.
   */
  async syncPortfolio(
    brokerPluginId: string,
    source: 'poll' | 'startup_reconcile',
  ): Promise<{ driftedSymbols: string[] }> {
    let portfolio: Awaited<ReturnType<ProviderGatewayService['getPortfolio']>>;
    try {
      portfolio = await this.gateway.getPortfolio(brokerPluginId);
    } catch (err) {
      this.log.warn(
        `syncPortfolio: getPortfolio failed for broker=${brokerPluginId}: ${String(err)}`,
      );
      return { driftedSymbols: [] };
    }

    const brokerSymbols = portfolio.positions.map((p) => p.symbol);

    await this.db.$transaction(async (tx) => {
      await tx.realPosition.deleteMany({
        where: { broker_plugin_id: brokerPluginId, symbol: { notIn: brokerSymbols } },
      });

      for (const pos of portfolio.positions) {
        await tx.realPosition.upsert({
          where: { symbol: pos.symbol },
          create: {
            symbol: pos.symbol,
            broker_plugin_id: brokerPluginId,
            qty: pos.qty,
            avg_entry: pos.avg_entry,
            market_value: pos.market_value,
            unrealized_pnl: pos.unrealized_pnl,
            side: pos.side,
          },
          update: {
            broker_plugin_id: brokerPluginId,
            qty: pos.qty,
            avg_entry: pos.avg_entry,
            market_value: pos.market_value,
            unrealized_pnl: pos.unrealized_pnl,
            side: pos.side,
          },
        });
      }

      const prevSnapshot = await tx.realNavSnapshot.findFirst({
        where: { broker_plugin_id: brokerPluginId },
        orderBy: { ts: 'desc' },
      });
      const prevHwm = prevSnapshot?.hwm ?? portfolio.equity;
      const hwm = Math.max(prevHwm, portfolio.equity);

      await tx.realNavSnapshot.create({
        data: {
          broker_plugin_id: brokerPluginId,
          equity: portfolio.equity,
          cash: portfolio.cash,
          buying_power: portfolio.buying_power,
          positions: JSON.stringify(portfolio.positions),
          total_pnl: portfolio.total_pnl,
          hwm,
          source,
        },
      });
    });

    const driftedSymbols = await this.detectDrift(portfolio.positions, brokerPluginId);
    return { driftedSymbols };
  }

  /**
   * Flags broker positions with no explaining fill history. A broker position
   * is "drift" when no RealOrder row exists for that symbol+broker with
   * status filled or partially_filled (FILL_EVIDENCE_STATUSES) — i.e. this
   * platform never placed/tracked an order that could explain the position.
   *
   * On drift, emits ONE CRITICAL BROKER_DRIFT AlertEntry (via AlertsService,
   * same path as RECONCILIATION_HALTED). Alert-spam guard: an already-open
   * (unresolved) BROKER_DRIFT alert for the same symbol is not duplicated —
   * checked via alerts.getActive() rather than a direct AlertEntry query, so
   * this service's only write/read surface onto the alerts table stays
   * AlertsService (mirrors how the circuit-breaker alert works).
   *
   * The RealPosition cache is updated to broker truth by syncPortfolio
   * BEFORE this runs, unconditionally — drift only ever affects alerting.
   */
  async detectDrift(brokerPositions: Position[], brokerPluginId: string): Promise<string[]> {
    if (brokerPositions.length === 0) return [];

    const activeAlerts = await this.alerts.getActive();
    const drifted: string[] = [];

    for (const pos of brokerPositions) {
      const explained = await this.db.realOrder.findFirst({
        where: {
          symbol: pos.symbol,
          broker_plugin_id: brokerPluginId,
          status: { in: FILL_EVIDENCE_STATUSES },
        },
      });
      if (explained) continue;

      drifted.push(pos.symbol);

      const alreadyOpen = activeAlerts.some(
        (a) => a.type === 'BROKER_DRIFT' && a.symbol === pos.symbol,
      );
      if (alreadyOpen) continue;

      try {
        await this.alerts.create({
          type: 'BROKER_DRIFT',
          severity: 'CRITICAL',
          symbol: pos.symbol,
          message:
            `Unexplained broker position: symbol=${pos.symbol} qty=${pos.qty} has no ` +
            `filled/partially_filled RealOrder history on this platform`,
        });
      } catch (err) {
        this.log.error(
          `detectDrift: failed to emit BROKER_DRIFT alert for ${pos.symbol}: ${String(err)}`,
        );
      }
    }

    // Future work: R8 will consume the caller's driftedSymbols to trigger an
    // auto-kill-switch here. Not implemented in this slice.
    return drifted;
  }

  /** Reads the active broker plugin id the same way TradeIntentService._effectiveMode does. */
  private async _resolveBrokerPluginId(): Promise<string> {
    let raw: string | null;
    try {
      raw = await this.kv.get(BROKER_PLUGIN_ID_KEY);
    } catch {
      raw = null;
    }
    return (kvStr(raw) ?? '').trim();
  }

  /** One-time startup sync — not throttled, source='startup_reconcile'. Paper-only deploys skip cleanly. */
  private async _syncPortfolioAtStartup(): Promise<void> {
    const brokerPluginId = await this._resolveBrokerPluginId();
    if (!brokerPluginId) return;

    this.lastPortfolioSyncAt = Date.now();
    try {
      await this.syncPortfolio(brokerPluginId, 'startup_reconcile');
    } catch (err) {
      this.log.warn(`_syncPortfolioAtStartup: syncPortfolio failed: ${String(err)}`);
    }
  }

  /** Steady-state-tick sync — throttled to PORTFOLIO_SYNC_THROTTLE_MS, source='poll'. Paper-only deploys skip cleanly. */
  private async _maybeSyncPortfolioOnTick(): Promise<void> {
    const brokerPluginId = await this._resolveBrokerPluginId();
    if (!brokerPluginId) return;

    const now = Date.now();
    if (
      this.lastPortfolioSyncAt !== null &&
      now - this.lastPortfolioSyncAt < PORTFOLIO_SYNC_THROTTLE_MS
    ) {
      return;
    }

    this.lastPortfolioSyncAt = now;
    try {
      await this.syncPortfolio(brokerPluginId, 'poll');
    } catch (err) {
      this.log.warn(`_maybeSyncPortfolioOnTick: syncPortfolio failed: ${String(err)}`);
    }
  }
}
