-- Migration 0004: Add scan_result column to plugins table
-- Part of F3-s1: Static AST Analysis (neutral-kernel)
-- Nullable JSON string; null means plugin has not been scanned yet.
-- Existing rows get NULL automatically (backward-compatible).

ALTER TABLE "plugins" ADD COLUMN "scan_result" TEXT;
