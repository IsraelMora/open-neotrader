/**
 * migration-smoke-0008.spec.ts — Task 1.1 TDD RED → 1.2 GREEN
 *
 * F6-s2: Long-Term / RAG Memory (SQLite FTS5)
 * Asserts migration 0008_long_term_memory exists and contains the required DDL.
 */
import * as fs from 'fs';
import * as path from 'path';

const MIGRATION_DIR = path.resolve(
  __dirname,
  '../../..',
  'prisma/migrations/0008_long_term_memory',
);
const MIGRATION_FILE = path.join(MIGRATION_DIR, 'migration.sql');

describe('Migration 0008_long_term_memory (F6-s2)', () => {
  it('migration directory exists', () => {
    expect(fs.existsSync(MIGRATION_DIR)).toBe(true);
  });

  it('migration.sql file exists', () => {
    expect(fs.existsSync(MIGRATION_FILE)).toBe(true);
  });

  it('migration.sql creates episode_memory table', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf8');
    expect(content).toMatch(/CREATE\s+TABLE\s+"episode_memory"/i);
  });

  it('migration.sql creates episode_fts FTS5 virtual table', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf8');
    expect(content).toMatch(/CREATE\s+VIRTUAL\s+TABLE\s+"episode_fts"\s+USING\s+fts5/i);
  });

  it('migration.sql uses unicode61 tokenizer', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf8');
    expect(content).toMatch(/tokenize\s*=\s*['"]?unicode61['"]?/i);
  });

  it('episode_fts is standalone (NOT external-content)', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf8');
    // Must NOT use content= directive (standalone, not external-content)
    expect(content).not.toMatch(/content\s*=\s*['"]episode_memory['"]/i);
  });
});
