-- F6-s2 PR3: Curated lesson store. FIFO cap (max 30 rows) enforced by service at insert time.
CREATE TABLE "lesson_memory" (
  "id"         TEXT     NOT NULL PRIMARY KEY,
  "ts"         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "text"       TEXT     NOT NULL,
  "episode_id" TEXT,
  "rationale"  TEXT,
  "meta"       TEXT
);
CREATE INDEX "lesson_memory_ts_idx" ON "lesson_memory" ("ts");
