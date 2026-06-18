-- Migration 0001: Initial schema
-- Creates all tables from scratch for production deployments.
-- SQLite + better-sqlite3 via Prisma driver adapter.

CREATE TABLE IF NOT EXISTS "users" (
    "id"                 TEXT    NOT NULL PRIMARY KEY,
    "username"           TEXT    NOT NULL UNIQUE,
    "password_hash"      TEXT    NOT NULL,
    "totp_secret"        TEXT,
    "totp_enabled"       BOOLEAN NOT NULL DEFAULT false,
    "backup_codes_hash"  TEXT,
    "is_active"          BOOLEAN NOT NULL DEFAULT true,
    "created_at"         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"         DATETIME NOT NULL
);

-- type: skill | universe | discipline | stack | provider | extra
-- verification: unverified | pending | verified | rejected
CREATE TABLE IF NOT EXISTS "plugins" (
    "id"             TEXT    NOT NULL PRIMARY KEY,
    "name"           TEXT    NOT NULL,
    "description"    TEXT,
    "version"        TEXT    NOT NULL,
    "type"           TEXT    NOT NULL,
    "active"         BOOLEAN NOT NULL DEFAULT false,
    "verification"   TEXT    NOT NULL DEFAULT 'unverified',
    "author"         TEXT,
    "source_url"     TEXT,
    "git_url"        TEXT,
    "stack_plugins"  TEXT,   -- JSON array
    "skills"         TEXT,   -- JSON array
    "symbols"        TEXT,   -- JSON array
    "config"         TEXT,   -- JSON object
    "installed_path" TEXT,
    "installed_at"   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"     DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS "config" (
    "key"       TEXT     NOT NULL PRIMARY KEY,
    "value"     TEXT     NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS "portfolio" (
    "name"      TEXT     NOT NULL PRIMARY KEY,
    "data"      TEXT     NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- Audit log — registro inmutable de decisiones del agente LLM
CREATE TABLE IF NOT EXISTS "audit_log" (
    "id"             TEXT     NOT NULL PRIMARY KEY,
    "ts"             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cycle_id"       TEXT,
    "event_type"     TEXT     NOT NULL,
    "plugin_id"      TEXT,
    "symbol"         TEXT,
    "action"         TEXT,
    "llm_text"       TEXT,
    "signals_count"  INTEGER,
    "skills_read"    TEXT,    -- JSON array
    "skills_written" TEXT,    -- JSON array
    "sandbox_ok"     BOOLEAN,
    "error"          TEXT,
    "meta"           TEXT     -- JSON libre
);

CREATE INDEX IF NOT EXISTS "audit_log_ts_idx"         ON "audit_log"("ts");
CREATE INDEX IF NOT EXISTS "audit_log_cycle_id_idx"   ON "audit_log"("cycle_id");
CREATE INDEX IF NOT EXISTS "audit_log_event_type_idx" ON "audit_log"("event_type");
