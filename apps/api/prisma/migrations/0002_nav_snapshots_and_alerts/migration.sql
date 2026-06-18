-- Migration 0002: NAV Snapshots y Alert Engine
-- Añade: nav_snapshots (equity curve persistente) y alerts (emitidas por plugins)

CREATE TABLE IF NOT EXISTS "nav_snapshots" (
    "id"          TEXT    NOT NULL PRIMARY KEY,
    "ts"          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cycle_id"    TEXT,
    "provider_id" TEXT,
    "equity"      REAL    NOT NULL,
    "cash"        REAL    NOT NULL,
    "positions"   TEXT    NOT NULL,  -- JSON: Position[]
    "total_pnl"   REAL    NOT NULL DEFAULT 0,
    "meta"        TEXT
);

CREATE INDEX IF NOT EXISTS "nav_snapshots_ts_idx" ON "nav_snapshots"("ts");

-- Alertas emitidas por plugins discipline/extra via emit_alerts en el contexto del ciclo
-- La plataforma no genera alertas por sí misma (es un shell plugin-first).
CREATE TABLE IF NOT EXISTS "alerts" (
    "id"          TEXT    NOT NULL PRIMARY KEY,
    "ts"          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type"        TEXT    NOT NULL,   -- DRAWDOWN | FLASH_CRASH | CORRELATION_SPIKE | VOLUME_ANOMALY | MACRO_EVENT | CUSTOM
    "severity"    TEXT    NOT NULL,   -- LOW | MEDIUM | HIGH | CRITICAL
    "symbol"      TEXT,
    "message"     TEXT    NOT NULL,
    "meta"        TEXT,               -- JSON con contexto adicional del plugin
    "resolved"    BOOLEAN NOT NULL DEFAULT false,
    "resolved_at" DATETIME
);

CREATE INDEX IF NOT EXISTS "alerts_ts_idx"   ON "alerts"("ts");
CREATE INDEX IF NOT EXISTS "alerts_type_idx" ON "alerts"("type");
