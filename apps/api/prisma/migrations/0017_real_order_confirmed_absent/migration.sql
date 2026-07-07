-- Fix: unbounded recoverInflight() polling of hopeless RealOrder rows (production incident —
-- "broker confirms no record of row <id> ... left as-is, no resubmit" repeated for the SAME
-- rows every ~15s indefinitely). RealOrderService now escalates a row to a new terminal
-- status, 'confirmed_absent', once the broker has AUTHORITATIVELY confirmed (a clean null
-- response from getOrderByClientId) that it has no record of the order across
-- CONFIRMED_ABSENT_ESCALATION_THRESHOLD (3) CONSECUTIVE recoverInflight() checks. This status
-- is excluded from RECOVERABLE_STATUSES (see real-order.service.ts) so the row is never
-- selected by future polls, and it must also be excluded from the partial unique index's
-- "active order" definition below — otherwise an escalated row would still count as "active"
-- at the DB level and could block a legitimate fresh submit() for the same trade_intent_id.
--
-- No new column is needed: 'confirmed_absent' is just a new value for the existing `status`
-- TEXT column. This migration only re-creates the partial unique index from 0016 with the
-- updated terminal-status list, kept in sync with TERMINAL_STATUSES in real-order.service.ts.
DROP INDEX IF EXISTS "real_orders_active_trade_intent_id_key";

-- CreateIndex
CREATE UNIQUE INDEX "real_orders_active_trade_intent_id_key"
  ON "real_orders"("trade_intent_id")
  WHERE "status" NOT IN ('filled', 'canceled', 'rejected', 'expired', 'submit_failed', 'confirmed_absent');
