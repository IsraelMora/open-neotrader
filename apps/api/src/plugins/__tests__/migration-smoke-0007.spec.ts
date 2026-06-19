/**
 * migration-smoke-0007.spec.ts — Phase 2.6 TDD RED: 0007_plugin_trust migration exists
 *
 * F3-s4: Trust Score + Badge + Content Checksum — Spec AC-8.
 * Asserts the migration file is present and contains the 3 correct ALTER TABLE statements.
 */
import * as fs from 'fs';
import * as path from 'path';

const MIGRATION_DIR = path.resolve(__dirname, '../../..', 'prisma/migrations/0007_plugin_trust');
const MIGRATION_FILE = path.join(MIGRATION_DIR, 'migration.sql');

describe('Migration 0007_plugin_trust (F3-s4 AC-8)', () => {
  it('migration directory exists', () => {
    expect(fs.existsSync(MIGRATION_DIR)).toBe(true);
  });

  it('migration.sql file exists', () => {
    expect(fs.existsSync(MIGRATION_FILE)).toBe(true);
  });

  it('migration.sql contains ADD COLUMN "trust_score" REAL', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf8');
    expect(content).toMatch(/ADD\s+COLUMN\s+"trust_score"\s+REAL/i);
  });

  it('migration.sql contains ADD COLUMN "content_checksum" TEXT', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf8');
    expect(content).toMatch(/ADD\s+COLUMN\s+"content_checksum"\s+TEXT/i);
  });

  it('migration.sql contains ADD COLUMN "votes_net" INTEGER NOT NULL DEFAULT 0', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf8');
    expect(content).toMatch(/ADD\s+COLUMN\s+"votes_net"\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+0/i);
  });
});
