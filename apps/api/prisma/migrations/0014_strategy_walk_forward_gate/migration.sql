-- Walk-forward gate (measurable-veto-shield): real-money execution requires the
-- CURRENTLY-APPLIED strategy to carry a recent "ROBUSTO" walk-forward verdict.
-- Set by BacktestService.runWalkForward() via StrategyService.recordWalkForward();
-- enforced by TradeIntentService when deciding real vs paper. Both columns nullable
-- so existing rows (no walk-forward run yet) fall back to paper — never real.
ALTER TABLE "strategies" ADD COLUMN "walk_forward_verdict" TEXT;
ALTER TABLE "strategies" ADD COLUMN "walk_forward_checked_at" DATETIME;
