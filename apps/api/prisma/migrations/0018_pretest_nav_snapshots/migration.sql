-- nav-data-collection F2: point-in-time equity snapshot for a pretest portfolio, taken at
-- the end of every runCycle (after the portfolio's state row is persisted). Powers the
-- pretest equity time-series endpoint (GET /pretest/nav-history) — mirrors NavSnapshot's
-- role for the real/paper account, one level down for virtual pretest portfolios.
CREATE TABLE "pretest_nav_snapshots" (
  "id"               TEXT     NOT NULL PRIMARY KEY,
  "portfolio_id"     TEXT     NOT NULL,
  "ts"               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "equity"           REAL     NOT NULL,
  "cash"             REAL     NOT NULL,
  "positions_count"  INTEGER  NOT NULL,
  "run_count"        INTEGER  NOT NULL
);
CREATE INDEX "pretest_nav_snapshots_portfolio_id_idx" ON "pretest_nav_snapshots" ("portfolio_id");
