-- F6-s2: Long-term episodic memory. Normal table + standalone FTS5 index.
-- episode_memory: authoritative store for trade cycle episodes.
-- episode_fts: standalone FTS5 virtual table (NOT external-content) synced by service dual-write.
CREATE TABLE "episode_memory" (
  "id"              TEXT     NOT NULL PRIMARY KEY,
  "ts"              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "cycle_id"        TEXT     NOT NULL,
  "symbols"         TEXT     NOT NULL,
  "regime_tags"     TEXT     NOT NULL,
  "action_summary"  TEXT     NOT NULL,
  "llm_rationale"   TEXT     NOT NULL,
  "narrative"       TEXT     NOT NULL,
  "outcome_pnl"     REAL,
  "outcome_equity"  REAL,
  "promoted"        INTEGER  NOT NULL DEFAULT 0,
  "meta"            TEXT
);
CREATE INDEX "episode_memory_cycle_id_idx" ON "episode_memory" ("cycle_id");
CREATE INDEX "episode_memory_ts_idx" ON "episode_memory" ("ts");
-- Standalone FTS5 (NOT external-content). rowid kept in sync by LongTermMemoryService.record().
CREATE VIRTUAL TABLE "episode_fts" USING fts5(narrative, tokenize = 'unicode61');
