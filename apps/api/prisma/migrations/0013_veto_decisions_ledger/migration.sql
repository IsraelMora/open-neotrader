-- Immutable veto decision ledger — one row per proposed signal per cycle, capturing
-- what the veto layer decided (approved/blocked/modified) and enough context to
-- reconstruct the counterfactual offline. cf_* fields are NULL at write time and
-- backfilled later by a separate read-side analyzer (no lookahead), mirroring the
-- outcome_pnl pattern on ml_signal_record (0010).
CREATE TABLE "veto_decisions" (
  "id"                     TEXT     NOT NULL PRIMARY KEY,
  "ts"                     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "cycle_id"               TEXT     NOT NULL,
  "symbol"                 TEXT     NOT NULL,
  "source_plugin"          TEXT     NOT NULL,
  "signal_confidence"      REAL,
  "proposed_action"        TEXT     NOT NULL,
  "proposed_qty"           REAL     NOT NULL,
  "verdict"                TEXT     NOT NULL,
  "approved_action"        TEXT,
  "approved_qty"           REAL,
  "discipline"             TEXT,
  "rationale"              TEXT,
  "ref_price"              REAL,
  "regime_tags"            TEXT,
  "portfolio_drawdown_pct" REAL,
  "context_snapshot"       TEXT,
  "cf_pnl"                 REAL,
  "cf_method"              TEXT,
  "cf_evaluated_at"        DATETIME
);
CREATE INDEX "veto_decisions_cycle_id_idx" ON "veto_decisions" ("cycle_id");
CREATE INDEX "veto_decisions_symbol_idx" ON "veto_decisions" ("symbol");
CREATE INDEX "veto_decisions_ts_idx" ON "veto_decisions" ("ts");
CREATE INDEX "veto_decisions_verdict_idx" ON "veto_decisions" ("verdict");
