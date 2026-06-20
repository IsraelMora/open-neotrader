/**
 * migration-smoke-0010.spec.ts — Task 1.1 TDD RED → 1.2 GREEN
 *
 * ml-feature-extractor-s1: per-skill signal-to-outcome capture table.
 * Asserts migration 0010_ml_signal_record exists and contains the required DDL.
 */
import * as fs from 'fs';
import * as path from 'path';

const MIGRATION_DIR = path.resolve(
  __dirname,
  '../../..',
  'prisma/migrations/0010_ml_signal_record',
);
const MIGRATION_FILE = path.join(MIGRATION_DIR, 'migration.sql');

describe('Migration 0010_ml_signal_record (ml-feature-extractor-s1)', () => {
  it('migration directory exists', () => {
    expect(fs.existsSync(MIGRATION_DIR)).toBe(true);
  });

  it('migration.sql file exists', () => {
    expect(fs.existsSync(MIGRATION_FILE)).toBe(true);
  });

  it('migration.sql creates ml_signal_record table', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf8');
    expect(content).toMatch(/CREATE\s+TABLE\s+"?ml_signal_record"?/i);
  });

  it('ml_signal_record has id TEXT NOT NULL PRIMARY KEY', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf8');
    expect(content).toMatch(/"?id"?\s+TEXT\s+NOT\s+NULL\s+PRIMARY\s+KEY/i);
  });

  it('ml_signal_record has ts DATETIME with DEFAULT CURRENT_TIMESTAMP', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf8');
    expect(content).toMatch(/"?ts"?\s+DATETIME.*DEFAULT\s+CURRENT_TIMESTAMP/i);
  });

  it('ml_signal_record has cycle_id TEXT NOT NULL', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf8');
    expect(content).toMatch(/"?cycle_id"?\s+TEXT\s+NOT\s+NULL/i);
  });

  it('ml_signal_record has symbol TEXT NOT NULL', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf8');
    expect(content).toMatch(/"?symbol"?\s+TEXT\s+NOT\s+NULL/i);
  });

  it('ml_signal_record has skill_vector TEXT NOT NULL', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf8');
    expect(content).toMatch(/"?skill_vector"?\s+TEXT\s+NOT\s+NULL/i);
  });

  it('ml_signal_record has action TEXT NOT NULL', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf8');
    expect(content).toMatch(/"?action"?\s+TEXT\s+NOT\s+NULL/i);
  });

  it('ml_signal_record has outcome_pnl REAL (nullable)', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf8');
    expect(content).toMatch(/"?outcome_pnl"?\s+REAL/i);
  });

  it('ml_signal_record has outcome_equity REAL (nullable)', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf8');
    expect(content).toMatch(/"?outcome_equity"?\s+REAL/i);
  });

  it('ml_signal_record has active_skill_hash TEXT NOT NULL', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf8');
    expect(content).toMatch(/"?active_skill_hash"?\s+TEXT\s+NOT\s+NULL/i);
  });

  it('ml_signal_record has meta TEXT (nullable)', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf8');
    expect(content).toMatch(/"?meta"?\s+TEXT/i);
  });

  it('migration.sql creates index on cycle_id', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf8');
    expect(content).toMatch(/CREATE\s+INDEX.*cycle_id/i);
  });

  it('migration.sql creates index on ts', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf8');
    expect(content).toMatch(
      /CREATE\s+INDEX.*ml_signal_record.*ts|CREATE\s+INDEX.*ts.*ml_signal_record/i,
    );
  });
});
