-- HITL paper trade-execution layer: persists LLM trade decisions for human review.
-- Real-money execution is intentionally NOT wired — only "paper" mode is supported.
CREATE TABLE "trade_intents" (
  "id"            TEXT     NOT NULL PRIMARY KEY,
  "cycle_id"      TEXT,
  "symbol"        TEXT     NOT NULL,
  "action"        TEXT     NOT NULL,
  "confidence"    REAL     NOT NULL,
  "rationale"     TEXT     NOT NULL,
  "timeframe"     TEXT     NOT NULL DEFAULT '1d',
  "mode"          TEXT     NOT NULL DEFAULT 'paper',
  "status"        TEXT     NOT NULL DEFAULT 'pending',
  "created_at"    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decided_at"    DATETIME,
  "decided_by"    TEXT,
  "reject_reason" TEXT,
  "fill_price"    REAL,
  "quantity"      REAL,
  "realized_pnl"  REAL,
  "result_json"   TEXT
);
CREATE INDEX "trade_intents_status_idx" ON "trade_intents" ("status");
CREATE INDEX "trade_intents_created_at_idx" ON "trade_intents" ("created_at");
CREATE INDEX "trade_intents_cycle_id_idx" ON "trade_intents" ("cycle_id");
