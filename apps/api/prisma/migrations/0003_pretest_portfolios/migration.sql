-- Migration 0003: Pretest Portfolios
-- Carteras virtuales para validar estrategias antes de usar dinero real.
-- Cada pretest tiene su propio set de plugins, config y estado virtual independiente.

CREATE TABLE IF NOT EXISTS "pretest_portfolios" (
    "id"              TEXT    NOT NULL PRIMARY KEY,
    "name"            TEXT    NOT NULL UNIQUE,
    "description"     TEXT,
    "initial_capital" REAL    NOT NULL DEFAULT 10000,
    "plugin_ids"      TEXT    NOT NULL,  -- JSON: string[]
    "plugin_configs"  TEXT,              -- JSON: Record<plugin_id, config_override>
    "state"           TEXT    NOT NULL,  -- JSON: PretestState
    "run_count"       INTEGER NOT NULL DEFAULT 0,
    "last_run_at"     DATETIME,
    "is_active"       BOOLEAN NOT NULL DEFAULT true,
    "created_at"      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      DATETIME NOT NULL
);
