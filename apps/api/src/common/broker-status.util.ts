/**
 * broker-status.util.ts — single shared vocabulary mapping a raw broker order
 * status string (currently Alpaca's) to the platform's canonical RealOrder
 * status.
 *
 * Money-critical rationale: RealOrder.status drives TWO independent things
 * that must never disagree —
 *   1. RealBrokerReconciliationService.reconcileAllOpenOrders() re-selects a
 *      row for polling only when its status is in OPEN_STATUSES.
 *   2. RealOrderService.recoverInflight() writes a status straight onto the
 *      row after a crash-recovery broker lookup.
 * Before this module existed, recoverRow() wrote the RAW broker string (e.g.
 * "new") directly onto RealOrder.status. "new" is in neither the open nor the
 * terminal vocabulary used by the reconciliation loop's WHERE clause, so the
 * row silently fell out of the polling set forever (orphaned, un-pollable).
 * A raw "filled" was worse: it skipped the transactional TradeIntent update
 * entirely, leaving RealOrder=filled while TradeIntent stayed real_pending
 * (a ledger desync — a fill visible on one side of the books only).
 *
 * BOTH RealOrderService and RealBrokerReconciliationService import this one
 * function so there is exactly one place that knows what a given broker
 * status means. Neither service may maintain its own divergent mapping.
 */

/** The platform's canonical RealOrder.status vocabulary (superset: pending_submit/submit_failed are submit()-only, not broker statuses). */
export type CanonicalRealOrderStatus =
  | 'accepted'
  | 'partially_filled'
  | 'filled'
  | 'canceled'
  | 'rejected'
  | 'expired';

/** RealOrder statuses that are still open and eligible for reconciliation polling. */
export const OPEN_STATUSES: readonly CanonicalRealOrderStatus[] = ['accepted', 'partially_filled'];

/** RealOrder statuses that can never receive further broker activity. */
export const TERMINAL_STATUSES: readonly CanonicalRealOrderStatus[] = [
  'filled',
  'canceled',
  'rejected',
  'expired',
];

/**
 * Maps a raw broker order status string to the platform's canonical
 * RealOrder status. Every Alpaca order status is covered explicitly so no
 * broker status can ever leave a row un-pollable:
 *   - open/in-flight variants (new, pending_new, accepted,
 *     accepted_for_bidding, pending_replace, replaced, held, suspended) →
 *     "accepted" (still open, eligible for the next poll).
 *   - partially_filled → partially_filled (open, but with fill progress).
 *   - filled → filled (terminal — caller MUST route this through the
 *     transactional RealOrder+TradeIntent update, never a direct write).
 *   - canceled / pending_cancel → canceled (terminal).
 *   - rejected → rejected (terminal).
 *   - expired / done_for_day → expired (terminal).
 *   - anything unrecognized → "accepted" (fail-open to a pollable state
 *     rather than silently dropping the order from future reconciliation;
 *     logged by the caller since this function has no logger of its own).
 */
export function normalizeBrokerStatus(raw: string): CanonicalRealOrderStatus {
  switch (raw) {
    case 'new':
    case 'pending_new':
    case 'accepted':
    case 'accepted_for_bidding':
    case 'pending_replace':
    case 'replaced':
    case 'held':
    case 'suspended':
      return 'accepted';
    case 'partially_filled':
      return 'partially_filled';
    case 'filled':
      return 'filled';
    case 'canceled':
    case 'pending_cancel':
      return 'canceled';
    case 'rejected':
      return 'rejected';
    case 'expired':
    case 'done_for_day':
      return 'expired';
    default:
      return 'accepted';
  }
}

/** True when a canonical status can never receive further broker activity. */
export function isTerminalStatus(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}
