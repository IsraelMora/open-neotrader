/**
 * RealOrderService — real-money order lifecycle tracking for the accounting foundation.
 *
 * It persists RealOrder rows and talks to the broker via ProviderGatewayService. It is
 * wired into the platform: _executeReal in trade-intent.service.ts submits through it,
 * and RealBrokerReconciliationService reconciles broker fills back onto its rows.
 *
 * Crash-safety invariant (the whole point of this service): the DB row is created
 * with status="pending_submit" and AWAITED/COMMITTED before any network call to the
 * broker. If the process dies between the DB write and the broker call, the row is
 * still discoverable by recoverInflight() on next startup — it is never silently lost.
 *
 * No-blind-resubmit invariant: recoverInflight() ALWAYS asks the broker for truth
 * (getOrderByClientId) before doing anything else, and NEVER calls placeOrder. Blindly
 * re-submitting an order that might already be live at the broker would risk a double
 * fill — the whole reason client_order_id exists is so the broker itself can dedupe,
 * but this service doesn't even rely on that: it simply refuses to resubmit.
 *
 * One-active-order-per-intent invariant: submit() is idempotent per trade_intent_id.
 * An app-level guard checks for an existing NON-TERMINAL row before creating a new
 * one; a DB-level partial unique index (real_orders_active_trade_intent_id_key, see
 * prisma/migrations/0016_real_order_active_intent_unique/migration.sql) makes a
 * concurrent double-create provably impossible — a race that slips past the app-level
 * check is caught as a Prisma P2002 error and resolved by fetching the winning row.
 *
 * Unconditional fail-soft: submit() NEVER throws to its caller, regardless of which
 * DB write fails. A broker error is recorded on the row (status="submit_failed") when
 * possible; if placeOrder actually succeeded, the row is deliberately NOT relabeled
 * submit_failed even if the follow-up status write itself fails — the order IS live at
 * the broker at that point, and mislabeling it risks a duplicate resubmit later. Every
 * DB write past the initial create is wrapped so a write failure is logged, never thrown.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderGatewayService } from '../providers/provider-gateway.service';
import { KvService } from '../common/kv.service';
import {
  normalizeBrokerStatus,
  TERMINAL_STATUSES as BROKER_TERMINAL_STATUSES,
} from '../common/broker-status.util';
import { haltRealExecution } from '../common/real-execution-halt.util';
import { isPrismaUniqueViolation } from '../common/prisma-error.util';
import type { RealOrder } from '@prisma/client';

/** Statuses considered "in flight" — not yet confirmed as accepted or terminally failed. */
const RECOVERABLE_STATUSES = ['pending_submit', 'submit_failed'];

/**
 * Terminal statuses for a RealOrder — a row in one of these states can never receive
 * further broker activity, so it must NOT block a fresh submit() for the same
 * trade_intent_id. Mirrors the partial unique index's WHERE clause exactly (see
 * migration 0016) — keep these in sync.
 */
const TERMINAL_STATUSES = ['filled', 'canceled', 'rejected', 'expired', 'submit_failed'];

/**
 * R8 kill-switch threshold: this many CONSECUTIVE submit_failed events within
 * SUBMIT_FAILURE_WINDOW_MS trip the real-money kill-switch (see real-execution-halt.util.ts).
 * A simple in-memory sliding window is enough here — this only needs to catch a burst of
 * failures within one process's lifetime; it deliberately does not survive a restart.
 */
const SUBMIT_FAILURE_THRESHOLD = 3;
const SUBMIT_FAILURE_WINDOW_MS = 5 * 60_000;

export interface SubmitArgs {
  tradeIntentId: string;
  brokerPluginId: string;
  symbol: string;
  side: string;
  requestedQty: number;
  orderType?: string;
  limitPrice?: number;
}

@Injectable()
export class RealOrderService implements OnModuleInit {
  private readonly log = new Logger(RealOrderService.name);

  /** In-memory sliding window of recent CONSECUTIVE submit_failed timestamps (ms epoch). */
  private submitFailureTimestamps: number[] = [];

  constructor(
    private readonly db: PrismaService,
    private readonly gateway: ProviderGatewayService,
    private readonly kv: KvService,
  ) {}

  /**
   * Startup recovery hook — runs recoverInflight() once the module is initialized.
   * Fail-soft: a thrown error inside recovery is logged, never rethrown, so it can
   * never block application boot.
   *
   * Fix 3 (boot-order independence): this used to be the ONLY path that ever called
   * recoverInflight() — a stuck pending_submit/submit_failed row would sit unrecovered
   * until the next process restart, which made AppModule's import-array ordering
   * (RealOrderModule before RealReconciliationModule, see app.module.ts) load-bearing
   * for correctness. Since RealBrokerReconciliationService.reconcileAllOpenOrders()
   * now also calls recoverInflight() on every steady-state tick (Fix 1), this
   * onModuleInit call is no longer the only safety net — it's kept as a fast-path
   * convenience (recovers a stuck row immediately on boot instead of waiting for the
   * first tick), never a correctness requirement.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.recoverInflight();
    } catch (err) {
      this.log.error(
        `onModuleInit: recoverInflight failed — application boot continues regardless: ${String(err)}`,
      );
    }
  }

  /**
   * Generates a fresh client_order_id for a NEW order attempt. Called once per
   * submit() — never regenerated for a retry of an existing row (a retry must reuse
   * the client_order_id already persisted on that row, sourced from the row itself,
   * not from a new call to this method).
   */
  generateClientOrderId(tradeIntentId: string): string {
    return `nt-${tradeIntentId.slice(0, 8)}-${randomUUID().slice(0, 8)}`;
  }

  /**
   * Crash-safe, per-intent-idempotent order submission. Sequence (see class doc for
   * the crash-safety and idempotency rationale):
   *   0. App-level guard: if a NON-TERMINAL row already exists for this
   *      trade_intent_id, return it as-is — no new client_order_id, no create, no
   *      broker call.
   *   1. Generate client_order_id.
   *   2. Create the RealOrder row (status=pending_submit) — AWAITED before any
   *      network call. A P2002 unique-violation here means a concurrent submit() won
   *      the DB-level race; fetch and return that row instead of throwing.
   *   3. Call gateway.placeOrder.
   *   4. On success: update row to status=submitted with broker_order_id. If THIS
   *      write itself fails, log distinctly (the order is live at the broker) and
   *      return the row as-is — never relabel it submit_failed.
   *   5. On broker error: update row to status=submit_failed with the error message.
   *      If THIS write itself fails, log and return the row as-is.
   * Fail-soft: never throws — always resolves with the best available row state.
   */
  async submit(args: SubmitArgs): Promise<RealOrder> {
    const existingActive = await this.findActiveOrderForIntent(args.tradeIntentId);
    if (existingActive) {
      this.log.log(
        `submit: an active RealOrder already exists for trade_intent_id=${args.tradeIntentId} ` +
          `(id=${existingActive.id}, status=${existingActive.status}) — skipping duplicate submit`,
      );
      return existingActive;
    }

    // Symbol-scoped guard (production incident: the LLM emitted "exit SPY" every
    // cycle — each cycle creates a NEW TradeIntent, so the per-intent guard above
    // never matches even though an order for the SAME symbol is still open at the
    // broker). If ANY non-terminal order already exists for this symbol+broker,
    // regardless of which trade_intent_id created it, skip the resubmit entirely —
    // one open order per symbol is enough; a second one (entry or exit) is always
    // redundant while the first is still live.
    const existingActiveForSymbol = await this.findActiveOrderForSymbol(
      args.symbol,
      args.brokerPluginId,
    );
    if (existingActiveForSymbol) {
      this.log.warn(
        `submit: duplicate real order for open symbol — skipping resubmit ` +
          `(symbol=${args.symbol}, broker=${args.brokerPluginId}, ` +
          `existing_id=${existingActiveForSymbol.id}, existing_status=${existingActiveForSymbol.status}, ` +
          `existing_trade_intent_id=${existingActiveForSymbol.trade_intent_id}, ` +
          `new_trade_intent_id=${args.tradeIntentId})`,
      );
      return existingActiveForSymbol;
    }

    const clientOrderId = this.generateClientOrderId(args.tradeIntentId);

    let row: RealOrder;
    try {
      row = await this.db.realOrder.create({
        data: {
          status: 'pending_submit',
          client_order_id: clientOrderId,
          trade_intent_id: args.tradeIntentId,
          broker_plugin_id: args.brokerPluginId,
          symbol: args.symbol,
          side: args.side,
          order_type: args.orderType ?? 'market',
          requested_qty: args.requestedQty,
          limit_price: args.limitPrice ?? null,
        },
      });
    } catch (err) {
      if (isPrismaUniqueViolation(err)) {
        // Concurrent submit() won the DB-level race — fetch and return its row.
        const raceWinner = await this.findActiveOrderForIntent(args.tradeIntentId);
        if (raceWinner) {
          this.log.log(
            `submit: create() lost a concurrent race for trade_intent_id=${args.tradeIntentId} ` +
              `— returning the winning row (id=${raceWinner.id})`,
          );
          return raceWinner;
        }
      }
      throw err;
    }

    try {
      const orderResponse = await this.gateway.placeOrder(args.brokerPluginId, {
        symbol: args.symbol,
        qty: args.requestedQty,
        side: args.side === 'sell' ? 'sell' : 'buy',
        type: args.orderType === 'limit' ? 'limit' : 'market',
        clientOrderId,
        limitPrice: args.limitPrice,
      });

      // A successful placeOrder resets the consecutive-failure streak — only CONSECUTIVE
      // failures should ever trip the kill-switch (R8).
      this.submitFailureTimestamps = [];

      const brokerOrderId = this.extractBrokerOrderId(orderResponse);
      try {
        return await this.db.realOrder.update({
          where: { id: row.id },
          data: {
            status: 'submitted',
            broker_order_id: brokerOrderId,
            submitted_at: new Date(),
            broker_raw_json: JSON.stringify(orderResponse),
          },
        });
      } catch (updateErr) {
        this.log.error(
          `REAL ORDER PLACED AT BROKER BUT STATUS WRITE FAILED [${row.id}] ` +
            `(client_order_id=${clientOrderId}) — order IS live at the broker, MUST be ` +
            `reconciled manually: ${String(updateErr)}`,
        );
        return row;
      }
    } catch (err) {
      this.log.warn(
        `REAL ORDER SUBMIT FAILED [${row.id}]: ${args.side} ${args.requestedQty} ${args.symbol} — ${String(err)}`,
      );
      await this._recordSubmitFailureAndMaybeHalt();
      try {
        return await this.db.realOrder.update({
          where: { id: row.id },
          data: {
            status: 'submit_failed',
            error: String(err),
          },
        });
      } catch (updateErr) {
        this.log.error(
          `REAL ORDER SUBMIT_FAILED STATUS WRITE ALSO FAILED [${row.id}] — leaving row as-is: ${String(updateErr)}`,
        );
        return row;
      }
    }
  }

  /**
   * R8: tracks CONSECUTIVE submit_failed events in an in-memory sliding window and trips
   * the global real-money kill-switch (see real-execution-halt.util.ts) once
   * SUBMIT_FAILURE_THRESHOLD failures land within SUBMIT_FAILURE_WINDOW_MS. The window is
   * pruned on every call so failures that age out never count towards the threshold.
   * Fail-soft: a KV write error here is logged, never thrown — a broken kill-switch write
   * must not prevent submit() from returning its best-available row state.
   */
  private async _recordSubmitFailureAndMaybeHalt(): Promise<void> {
    const now = Date.now();
    this.submitFailureTimestamps = [
      ...this.submitFailureTimestamps.filter((t) => now - t <= SUBMIT_FAILURE_WINDOW_MS),
      now,
    ];
    if (this.submitFailureTimestamps.length < SUBMIT_FAILURE_THRESHOLD) return;

    try {
      await haltRealExecution(this.kv, 'repeated real order submit failures');
    } catch (haltErr) {
      this.log.error(
        `Failed to trip the real-execution kill-switch after repeated submit failures: ${String(haltErr)}`,
      );
    }
  }

  /** Finds the NON-TERMINAL RealOrder row for a trade_intent_id, if any (see TERMINAL_STATUSES). */
  private async findActiveOrderForIntent(tradeIntentId: string): Promise<RealOrder | null> {
    return this.db.realOrder.findFirst({
      where: {
        trade_intent_id: tradeIntentId,
        status: { notIn: TERMINAL_STATUSES },
      },
    });
  }

  /**
   * Finds the NON-TERMINAL RealOrder row for a symbol+broker, if any, regardless of
   * trade_intent_id. See submit()'s symbol-scoped guard doc for why this exists
   * alongside findActiveOrderForIntent — the per-intent guard alone misses a
   * resubmit for the SAME symbol from a freshly-created TradeIntent.
   */
  private async findActiveOrderForSymbol(
    symbol: string,
    brokerPluginId: string,
  ): Promise<RealOrder | null> {
    return this.db.realOrder.findFirst({
      where: {
        symbol,
        broker_plugin_id: brokerPluginId,
        status: { notIn: TERMINAL_STATUSES },
      },
      orderBy: { created_at: 'desc' },
    });
  }
  /**
   * Startup/crash recovery for orders left in an in-flight state (pending_submit or
   * submit_failed). For each such row, asks the broker for truth via
   * getOrderByClientId BEFORE doing anything else, and NEVER calls placeOrder — see
   * class doc for the no-blind-resubmit invariant.
   *
   * Three distinct branches per row:
   *   - Broker HAS the order → row is updated to reflect broker truth (broker_order_id,
   *     mapped status, filled_qty).
   *   - Broker confirms it does NOT have it (getOrderByClientId returns null, i.e. a
   *     confirmed 404) → the row is left as-is, eligible for a fresh submit() attempt
   *     later. Explicitly does NOT resubmit from this path.
   *   - The lookup itself throws (network/auth/5xx/timeout) → the row is left as-is.
   *     Fail-soft per row: one row's lookup failure never aborts recovery of the others.
   */
  async recoverInflight(): Promise<void> {
    const rows = await this.db.realOrder.findMany({
      where: { status: { in: RECOVERABLE_STATUSES } },
    });

    for (const row of rows) {
      await this.recoverRow(row);
    }
  }

  private async recoverRow(row: RealOrder): Promise<void> {
    let brokerOrder: Awaited<ReturnType<ProviderGatewayService['getOrderByClientId']>>;
    try {
      brokerOrder = await this.gateway.getOrderByClientId(
        row.broker_plugin_id,
        row.client_order_id,
      );
    } catch (err) {
      // Lookup-error branch — fail-soft per row: one broker-lookup failure never
      // blocks recovering the rest.
      this.log.warn(
        `recoverInflight: getOrderByClientId failed for row ${row.id} (client_order_id=${row.client_order_id}) — left as-is: ${String(err)}`,
      );
      return;
    }

    if (brokerOrder === null) {
      // Confirmed-not-found branch (broker returned a confirmed 404) — leave the row
      // retryable, do NOT resubmit here.
      this.log.log(
        `recoverInflight: broker confirms no record of row ${row.id} (client_order_id=${row.client_order_id}) — left as-is, no resubmit`,
      );
      return;
    }

    // Broker-has-it branch — reconcile the row to broker truth.
    //
    // Money-critical: this method must NEVER write a raw broker status string
    // straight onto RealOrder.status, and must NEVER write a fill directly.
    // See broker-status.util.ts's module doc for why — in short:
    //   - A raw non-canonical status (e.g. "new") is in neither OPEN_STATUSES
    //     nor TERMINAL_STATUSES, so reconcileAllOpenOrders() would never
    //     re-select the row again — it becomes silently un-pollable forever.
    //   - A raw "filled" written here would set RealOrder=filled while
    //     TradeIntent stays real_pending — a fill visible on one side of the
    //     ledger only, since this path does not touch TradeIntent at all.
    // So: normalize the broker status, persist broker_order_id, and if the
    // normalized status is terminal, DOWNGRADE to a pollable OPEN status
    // instead of writing it here. The very next reconciliation tick will
    // call reconcileOrder() for this row (it's now in OPEN_STATUSES), ask the
    // broker again, and apply the terminal transition through the single
    // $transaction that keeps RealOrder and TradeIntent in sync. This method
    // deliberately never writes filled_qty/filled_avg_price — those belong
    // exclusively to that transactional path.
    const canonical = normalizeBrokerStatus(brokerOrder.status);
    const pollableStatus = (BROKER_TERMINAL_STATUSES as readonly string[]).includes(canonical)
      ? 'accepted'
      : canonical;

    await this.db.realOrder.update({
      where: { id: row.id },
      data: {
        broker_order_id: brokerOrder.broker_order_id,
        status: pollableStatus,
        last_reconciled_at: new Date(),
      },
    });
  }

  /** Broker responses are untyped Record<string, unknown> — extract "id" defensively. */
  private extractBrokerOrderId(orderResponse: Record<string, unknown>): string | null {
    const id = orderResponse['id'];
    return typeof id === 'string' ? id : null;
  }
}
