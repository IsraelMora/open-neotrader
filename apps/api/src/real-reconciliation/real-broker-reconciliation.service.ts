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
 * This slice intentionally implements ONLY reconcileOrder(realOrderId). The
 * polling loop / @Interval / startup trigger that calls it is a later slice.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderGatewayService, OrderStatusResult } from '../providers/provider-gateway.service';
import type { RealOrder } from '@prisma/client';

/** RealOrder statuses that can never receive further broker activity. */
const TERMINAL_STATUSES = ['filled', 'canceled', 'rejected', 'expired'];

@Injectable()
export class RealBrokerReconciliationService {
  private readonly log = new Logger(RealBrokerReconciliationService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly gateway: ProviderGatewayService,
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

  private async applyBrokerOrder(row: RealOrder, brokerOrder: OrderStatusResult): Promise<void> {
    const now = new Date();
    const isValidFillEvidence =
      Number.isFinite(brokerOrder.filled_qty) &&
      brokerOrder.filled_qty > 0 &&
      brokerOrder.filled_avg_price !== null &&
      Number.isFinite(brokerOrder.filled_avg_price) &&
      brokerOrder.filled_avg_price > 0;

    if (brokerOrder.status === 'filled' && !isValidFillEvidence) {
      // Defensive: broker status string says filled, but the numeric evidence
      // is not trustworthy — treat as not-yet-filled rather than fabricate.
      this.log.warn(
        `reconcileOrder: RealOrder ${row.id} broker status="filled" but filled_qty=${brokerOrder.filled_qty} ` +
          `filled_avg_price=${brokerOrder.filled_avg_price} is not valid positive numeric evidence — not recording a fill`,
      );
      await this.touchLastReconciledAt(row.id);
      return;
    }

    if (brokerOrder.status === 'filled' && isValidFillEvidence) {
      await this.db.$transaction(async (tx) => {
        await tx.realOrder.update({
          where: { id: row.id },
          data: {
            status: 'filled',
            broker_order_id: brokerOrder.broker_order_id,
            filled_qty: brokerOrder.filled_qty,
            filled_avg_price: brokerOrder.filled_avg_price,
            filled_at: now,
            last_reconciled_at: now,
          },
        });
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

    if (brokerOrder.status === 'partially_filled') {
      // Future work: partial_fill_timeout_minutes — an auto-cancel-of-remainder-
      // on-timeout feature should watch rows stuck in partially_filled past a
      // configurable window. Not implemented in this slice — no timer here.
      await this.db.realOrder.update({
        where: { id: row.id },
        data: {
          status: 'partially_filled',
          filled_qty: brokerOrder.filled_qty,
          filled_avg_price: brokerOrder.filled_avg_price,
          last_reconciled_at: now,
        },
      });
      return;
    }

    if (['rejected', 'canceled', 'expired'].includes(brokerOrder.status)) {
      const rejectReason = this.extractRejectReason(brokerOrder);
      await this.db.$transaction(async (tx) => {
        await tx.realOrder.update({
          where: { id: row.id },
          data: {
            status: brokerOrder.status,
            broker_order_id: brokerOrder.broker_order_id,
            last_reconciled_at: now,
          },
        });
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

    // "new" / "accepted" / other non-terminal broker states — leave the
    // RealOrder status as submitted, just record the reconcile attempt.
    await this.touchLastReconciledAt(row.id);
  }

  /** Records a reconcile attempt without changing status (fail-soft / not-found / not-yet-final paths). */
  private async touchLastReconciledAt(realOrderId: string): Promise<void> {
    try {
      await this.db.realOrder.update({
        where: { id: realOrderId },
        data: { last_reconciled_at: new Date() },
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
}
