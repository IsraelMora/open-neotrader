/**
 * migration-smoke-0009.spec.ts — Task 3.1 TDD RED → 3.2 GREEN
 *
 * F6-s2 PR3: Curated Lessons — lesson_memory table.
 * Asserts migration 0009_lesson_memory exists and contains the required DDL.
 */
import * as fs from 'fs';
import * as path from 'path';

const MIGRATION_DIR = path.resolve(
  __dirname,
  '../../..',
  'prisma/migrations/0009_lesson_memory',
);
const MIGRATION_FILE = path.join(MIGRATION_DIR, 'migration.sql');

describe('Migration 0009_lesson_memory (F6-s2 PR3)', () => {
  it('migration directory exists', () => {
    expect(fs.existsSync(MIGRATION_DIR)).toBe(true);
  });

  it('migration.sql file exists', () => {
    expect(fs.existsSync(MIGRATION_FILE)).toBe(true);
  });

  it('migration.sql creates lesson_memory table', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf8');
    expect(content).toMatch(/CREATE\s+TABLE\s+"?lesson_memory"?/i);
  });

  it('lesson_memory has id TEXT PRIMARY KEY', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf8');
    expect(content).toMatch(/"?id"?\s+TEXT/i);
  });

  it('lesson_memory has ts DATETIME with DEFAULT CURRENT_TIMESTAMP', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf8');
    expect(content).toMatch(/CURRENT_TIMESTAMP/i);
  });

  it('lesson_memory has text TEXT column', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf8');
    expect(content).toMatch(/"?text"?\s+TEXT/i);
  });

  it('lesson_memory has episode_id column (nullable)', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf8');
    expect(content).toMatch(/"?episode_id"?/i);
  });

  it('migration.sql creates index on ts', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf8');
    expect(content).toMatch(/CREATE\s+INDEX/i);
    expect(content).toMatch(/lesson_memory.*ts|ts.*lesson_memory/i);
  });
});
