/**
 * migration-smoke.spec.ts — Phase 1 TDD RED: 0005_plugin_smoke_test migration exists
 *
 * F3-s2: Pre-Activation Smoke Test — Spec AC-8.
 * Asserts the migration file is present and contains the correct ALTER TABLE statement.
 */
import * as fs from 'fs';
import * as path from 'path';

const MIGRATION_DIR = path.resolve(
  __dirname,
  '../../..',
  'prisma/migrations/0005_plugin_smoke_test',
);
const MIGRATION_FILE = path.join(MIGRATION_DIR, 'migration.sql');

describe('Migration 0005_plugin_smoke_test (F3-s2 AC-8)', () => {
  it('migration directory exists', () => {
    expect(fs.existsSync(MIGRATION_DIR)).toBe(true);
  });

  it('migration.sql file exists', () => {
    expect(fs.existsSync(MIGRATION_FILE)).toBe(true);
  });

  it('migration.sql contains ADD COLUMN "smoke_test_result" TEXT', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf8');
    expect(content).toMatch(/ADD\s+COLUMN\s+"smoke_test_result"\s+TEXT/i);
  });
});
