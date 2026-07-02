-- Real-money accounting foundation (slice 2, additive only): DB-enforced guarantee that
-- at most one NON-TERMINAL RealOrder row exists per trade_intent_id. Prisma's schema DSL
-- cannot express partial unique indexes, so this constraint is raw SQL (SQLite supports a
-- WHERE clause on CREATE UNIQUE INDEX since 3.8.0). This is deliberately a NEW migration
-- rather than an edit to 0015_real_money_accounting/migration.sql: 0015 is not yet merged
-- to main, but it is already committed on this branch and may already have been applied
-- to a developer's local dev DB (migration-runner.service.ts tracks applied migrations by
-- folder name in `_migration_history`, so editing an already-applied 0015 would silently
-- skip re-running it and leave that DB without this constraint).
--
-- Terminal statuses (a row in one of these states can never receive further broker
-- activity, so it must NOT block a fresh submit() for the same trade_intent_id) must stay
-- in sync with TERMINAL_STATUSES in real-order.service.ts.
-- CreateIndex
CREATE UNIQUE INDEX "real_orders_active_trade_intent_id_key"
  ON "real_orders"("trade_intent_id")
  WHERE "status" NOT IN ('filled', 'canceled', 'rejected', 'expired', 'submit_failed');
