/**
 * migration-smoke-0011.spec.ts — TDD RED → GREEN
 *
 * HITL paper trade-execution layer: trade_intents table.
 * Asserts migration 0011_trade_intents exists and contains the required DDL.
 *
 * NOTE: This test validates the SQL file content only (pure fs reads).
 * It does NOT run better-sqlite3 — that would fail locally due to Node ABI
 * mismatch (node 24 vs better-sqlite3 built for node 22). The file-content
 * assertions are sufficient to gate CI; DB-level smoke runs in the container.
 */
import * as fs from 'fs';
import * as path from 'path';

const MIGRATION_DIR = path.resolve(__dirname, '../../..', 'prisma/migrations/0011_trade_intents');
const MIGRATION_FILE = path.join(MIGRATION_DIR, 'migration.sql');

describe('Migration 0011_trade_intents (HITL paper trade-execution)', () => {
  it('migration directory exists', () => {
    expect(fs.existsSync(MIGRATION_DIR)).toBe(true);
  });

  it('migration.sql file exists', () => {
    expect(fs.existsSync(MIGRATION_FILE)).toBe(true);
  });

  it('migration.sql creates trade_intents table', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf8');
    expect(content).toMatch(/CREATE\s+TABLE\s+"?trade_intents"?/i);
  });

  it('trade_intents has id TEXT NOT NULL PRIMARY KEY', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf8');
    expect(content).toMatch(/"?id"?\s+TEXT\s+NOT\s+NULL\s+PRIMARY\s+KEY/i);
  });

  it('trade_intents has symbol TEXT NOT NULL', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf8');
    expect(content).toMatch(/"?symbol"?\s+TEXT\s+NOT\s+NULL/i);
  });

  it('trade_intents has action TEXT NOT NULL', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf8');
    expect(content).toMatch(/"?action"?\s+TEXT\s+NOT\s+NULL/i);
  });

  it('trade_intents has confidence REAL NOT NULL', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf8');
    expect(content).toMatch(/"?confidence"?\s+REAL\s+NOT\s+NULL/i);
  });

  it('trade_intents has rationale TEXT NOT NULL', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf8');
    expect(content).toMatch(/"?rationale"?\s+TEXT\s+NOT\s+NULL/i);
  });

  it('trade_intents has mode TEXT NOT NULL DEFAULT paper', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf8');
    expect(content).toMatch(/"?mode"?\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'paper'/i);
  });

  it('trade_intents has status TEXT NOT NULL DEFAULT pending', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf8');
    expect(content).toMatch(/"?status"?\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'pending'/i);
  });

  it('trade_intents has created_at DATETIME NOT NULL with DEFAULT CURRENT_TIMESTAMP', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf8');
    expect(content).toMatch(/"?created_at"?\s+DATETIME\s+NOT\s+NULL.*DEFAULT\s+CURRENT_TIMESTAMP/i);
  });

  it('trade_intents has nullable decided_at DATETIME', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf8');
    expect(content).toMatch(/"?decided_at"?\s+DATETIME/i);
  });

  it('trade_intents has fill_price REAL (nullable)', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf8');
    expect(content).toMatch(/"?fill_price"?\s+REAL/i);
  });

  it('trade_intents has realized_pnl REAL (nullable)', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf8');
    expect(content).toMatch(/"?realized_pnl"?\s+REAL/i);
  });

  it('migration.sql creates index on status', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf8');
    expect(content).toMatch(/CREATE\s+INDEX.*status/i);
  });

  it('migration.sql creates index on created_at', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf8');
    expect(content).toMatch(
      /CREATE\s+INDEX.*trade_intents.*created_at|CREATE\s+INDEX.*created_at.*trade_intents/i,
    );
  });

  it('migration.sql creates index on cycle_id', () => {
    const content = fs.readFileSync(MIGRATION_FILE, 'utf8');
    expect(content).toMatch(/CREATE\s+INDEX.*cycle_id/i);
  });
});
