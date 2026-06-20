-- ml-feature-extractor-s1: per-skill signal -> outcome capture for the on-device ML feature extractor.
-- One row per (cycle_id, symbol). skill_vector is a JSON array of per-skill
-- {plugin_id, action, confidence}. outcome_* are NULL at capture, backfilled by
-- the NEXT snapshot (no lookahead). Mirrors episode_memory (0008).
CREATE TABLE "ml_signal_record" (
  "id"                TEXT     NOT NULL PRIMARY KEY,
  "ts"                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "cycle_id"          TEXT     NOT NULL,
  "symbol"            TEXT     NOT NULL,
  "skill_vector"      TEXT     NOT NULL,
  "action"            TEXT     NOT NULL,
  "outcome_pnl"       REAL,
  "outcome_equity"    REAL,
  "active_skill_hash" TEXT     NOT NULL,
  "meta"              TEXT
);
CREATE INDEX "ml_signal_record_cycle_id_idx" ON "ml_signal_record" ("cycle_id");
CREATE INDEX "ml_signal_record_ts_idx" ON "ml_signal_record" ("ts");
