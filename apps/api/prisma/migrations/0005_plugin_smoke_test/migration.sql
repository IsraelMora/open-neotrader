-- Migration 0005: Add smoke_test_result column to plugins table
-- Part of F3-s2: Pre-Activation Smoke Test (neutral-kernel)
-- Nullable JSON string; null means plugin has not been smoke-tested yet.
-- Existing rows get NULL automatically (backward-compatible).

ALTER TABLE "plugins" ADD COLUMN "smoke_test_result" TEXT;
