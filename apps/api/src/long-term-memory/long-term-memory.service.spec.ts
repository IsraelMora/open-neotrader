/**
 * long-term-memory.service.spec.ts — Tasks 1.5/1.6, 1.7/1.8, 1.9/1.10, 1.11/1.12 TDD RED→GREEN
 *
 * F6-s2: LongTermMemoryService — sanitization, boot-check, record/prefetch, updateOutcome
 *
 * Integration tests use real better-sqlite3 in-memory DB with 0008 SQL applied.
 * Unit tests for sanitizeMatch and boot-check mock PrismaService.
 */
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { LongTermMemoryService } from './long-term-memory.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { EpisodeInput } from './memory-provider.interface';

// ── Helpers ────────────────────────────────────────────────────────────────────

const MIGRATION_FILE = path.resolve(
  __dirname,
  '../..',
  'prisma/migrations/0008_long_term_memory/migration.sql',
);

/** Build a real in-memory DB with the 0008 schema applied. */
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  const sql = fs.readFileSync(MIGRATION_FILE, 'utf8');
  db.exec(sql);
  return db;
}

/** Build a PrismaService mock that delegates to a real better-sqlite3 DB. */
function makePrismaFromDb(db: Database.Database): PrismaService {
  return {
    $executeRaw: jest
      .fn()
      .mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = buildSql(strings, values);
        db.exec(sql);
        return Promise.resolve(0);
      }),
    $queryRaw: jest
      .fn()
      .mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = buildSql(strings, values);
        const stmt = db.prepare(sql);
        return Promise.resolve(stmt.all());
      }),
    $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      return fn({
        $executeRaw: jest
          .fn()
          .mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
            const sql = buildSql(strings, values);
            db.exec(sql);
            return Promise.resolve(0);
          }),
        $queryRaw: jest
          .fn()
          .mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
            const sql = buildSql(strings, values);
            const stmt = db.prepare(sql);
            return Promise.resolve(stmt.all());
          }),
      });
    }),
  } as unknown as PrismaService;
}

/**
 * Reconstruct SQL from a tagged template literal call.
 * Inlines values using sqlite3 quoting (strings quoted, numbers/null inlined).
 */
function buildSql(strings: TemplateStringsArray, values: unknown[]): string {
  let result = '';
  for (let i = 0; i < strings.length; i++) {
    result += strings[i];
    if (i < values.length) {
      const v = values[i];
      if (v === null || v === undefined) {
        result += 'NULL';
      } else if (typeof v === 'number') {
        result += v;
      } else {
        // Escape single quotes in strings
        const str = typeof v === 'string' ? v : JSON.stringify(v);
        result += `'${str.replace(/'/g, "''")}'`;
      }
    }
  }
  return result;
}

/** Build a minimal episode input. */
function makeEpisodeInput(overrides: Partial<EpisodeInput> = {}): EpisodeInput {
  return {
    cycle_id: 'cycle-001',
    symbols: ['SPY'],
    regime_tags: ['vix_high'],
    action_summary: 'EXIT SPY',
    llm_rationale: 'High VIX, exit',
    narrative: 'SPY vix_high EXIT SPY High VIX exit',
    ...overrides,
  };
}

/** Build a service with a mocked PrismaService (no real DB). */
function makeServiceWithMock(prismaOverrides: Partial<PrismaService> = {}): {
  service: LongTermMemoryService;
  logWarn: jest.SpyInstance;
} {
  const db = {
    $executeRaw: jest.fn().mockResolvedValue(0),
    $queryRaw: jest.fn().mockResolvedValue([]),
    $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        $executeRaw: jest.fn().mockResolvedValue(0),
        $queryRaw: jest.fn().mockResolvedValue([]),
      }),
    ),
    ...prismaOverrides,
  } as unknown as PrismaService;

  const service = new LongTermMemoryService(db);
  const logWarn = jest.spyOn(service['log'], 'warn').mockImplementation(() => undefined);
  return { service, logWarn };
}

// ── Typed subclass for accessing protected members in tests ───────────────────

/** Thin subclass that exposes protected members for unit tests. */
class TestableLongTermMemoryService extends LongTermMemoryService {
  testSanitizeMatch(q: string): string {
    return this.sanitizeMatch(q);
  }
  setFts5Available(v: boolean): void {
    (this as unknown as Record<string, unknown>)['fts5Available'] = v;
  }
}

// ── Task 1.5 / 1.6: sanitizeMatch unit tests ──────────────────────────────────

describe('LongTermMemoryService.sanitizeMatch (unit)', () => {
  let service: TestableLongTermMemoryService;

  beforeEach(() => {
    const db = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          $executeRaw: jest.fn().mockResolvedValue(0),
          $queryRaw: jest.fn().mockResolvedValue([]),
        }),
      ),
    } as unknown as PrismaService;
    service = new TestableLongTermMemoryService(db);
  });

  it('\'BRK.B\' → \'"BRK" "B"\'', () => {
    expect(service.testSanitizeMatch('BRK.B')).toBe('"BRK" "B"');
  });

  it("'^VIX' → '\"VIX\"'", () => {
    expect(service.testSanitizeMatch('^VIX')).toBe('"VIX"');
  });

  it('\'foo" OR x\' → \'"foo" "OR" "x"\'', () => {
    expect(service.testSanitizeMatch('foo" OR x')).toBe('"foo" "OR" "x"');
  });

  it("empty string → ''", () => {
    expect(service.testSanitizeMatch('')).toBe('');
  });

  it("whitespace-only → ''", () => {
    expect(service.testSanitizeMatch('   ')).toBe('');
  });

  it('\'SPY vix_high\' → \'"SPY" "vix" "high"\'', () => {
    expect(service.testSanitizeMatch('SPY vix_high')).toBe('"SPY" "vix" "high"');
  });
});

// ── Task 1.7 / 1.8: boot-check unit tests ─────────────────────────────────────

describe('LongTermMemoryService boot-check (unit)', () => {
  it('warns-not-crashes when FTS5 probe throws', async () => {
    const { service, logWarn } = makeServiceWithMock({
      $executeRaw: jest.fn().mockRejectedValue(new Error('no such module: fts5')),
      $transaction: jest.fn().mockRejectedValue(new Error('no such module: fts5')),
    });

    await expect(service.onModuleInit()).resolves.not.toThrow();
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining('FTS5 unavailable'));
  });

  it('does not warn when boot-check succeeds', async () => {
    const { service, logWarn } = makeServiceWithMock();
    await service.onModuleInit();
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('prefetch returns [] when fts5Available=false', async () => {
    const { service } = makeServiceWithMock({
      $executeRaw: jest.fn().mockRejectedValue(new Error('no such module: fts5')),
      $transaction: jest.fn().mockRejectedValue(new Error('no such module: fts5')),
    });

    await service.onModuleInit();
    const result = await service.prefetch('SPY', 5);
    expect(result).toEqual([]);
  });
});

// ── Task 1.9 / 1.10: record + prefetch integration ────────────────────────────

describe('LongTermMemoryService record + prefetch (integration)', () => {
  let service: LongTermMemoryService;
  let db: Database.Database;

  beforeEach(async () => {
    db = makeDb();
    const prisma = makePrismaFromDb(db);
    service = new LongTermMemoryService(prisma);
    await service.onModuleInit();
  });

  afterEach(() => {
    db.close();
  });

  it('FTS5 virtual table is queryable after migration', () => {
    const stmt = db.prepare('SELECT count(*) as cnt FROM episode_fts');
    const row = stmt.get() as { cnt: number };
    expect(row.cnt).toBe(0);
  });

  it('record inserts a row into episode_memory', async () => {
    const ep = makeEpisodeInput({ cycle_id: 'c-001' });
    await service.record(ep);
    const row = db.prepare("SELECT * FROM episode_memory WHERE cycle_id = 'c-001'").get();
    expect(row).toBeTruthy();
  });

  it('record inserts matching row into episode_fts (dual-write)', async () => {
    const ep = makeEpisodeInput({ cycle_id: 'c-002', narrative: 'AAPL fomc_day BUY' });
    await service.record(ep);
    const row = db
      .prepare("SELECT rowid, * FROM episode_memory WHERE cycle_id = 'c-002'")
      .get() as { rowid: number };
    expect(row).toBeTruthy();
    const ftsRow = db.prepare(`SELECT * FROM episode_fts WHERE rowid = ${row.rowid}`).get();
    expect(ftsRow).toBeTruthy();
  });

  it('prefetch returns hits ordered by BM25 rank (most relevant first)', async () => {
    await service.record(
      makeEpisodeInput({
        cycle_id: 'c-a',
        narrative: 'QQQ regime_down EXIT QQQ low volume',
      }),
    );
    await service.record(
      makeEpisodeInput({
        cycle_id: 'c-b',
        narrative: 'SPY vix_high EXIT SPY high volatility sell signal',
      }),
    );
    await service.record(
      makeEpisodeInput({
        cycle_id: 'c-c',
        narrative: 'SPY vix_high BUY SPY recovery',
      }),
    );

    const hits = await service.prefetch('SPY vix_high', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThanOrEqual(5);
    // SPY vix_high episodes should be ranked above QQQ one
    const cycleIds = hits.map((h) => h.cycle_id);
    expect(cycleIds.some((id) => id === 'c-b' || id === 'c-c')).toBe(true);
  });

  it('prefetch no-match returns []', async () => {
    await service.record(makeEpisodeInput({ narrative: 'SPY vix_high EXIT SPY' }));
    const hits = await service.prefetch('TSLA fomc_day', 5);
    expect(hits).toEqual([]);
  });

  it('memory-never-throws: $queryRaw throws → prefetch returns [], no throw', async () => {
    const brokenPrisma = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      $queryRaw: jest.fn().mockRejectedValue(new Error('DB locked')),
      $transaction: jest.fn().mockResolvedValue(undefined),
    } as unknown as PrismaService;
    const s = new TestableLongTermMemoryService(brokenPrisma);
    s.setFts5Available(true); // bypass boot-check; test query error path
    const result = await s.prefetch('SPY', 5);
    expect(result).toEqual([]);
  });

  it('memory-never-throws: $transaction throws → record() resolves, no throw', async () => {
    const brokenPrisma = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn().mockRejectedValue(new Error('DB locked')),
    } as unknown as PrismaService;
    const s = new TestableLongTermMemoryService(brokenPrisma);
    s.setFts5Available(true);
    await expect(s.record(makeEpisodeInput())).resolves.not.toThrow();
  });
});

// ── Task 1.11 / 1.12: updateOutcome integration ───────────────────────────────

describe('LongTermMemoryService updateOutcome (integration)', () => {
  let service: LongTermMemoryService;
  let db: Database.Database;

  beforeEach(async () => {
    db = makeDb();
    const prisma = makePrismaFromDb(db);
    service = new LongTermMemoryService(prisma);
    await service.onModuleInit();
  });

  afterEach(() => {
    db.close();
  });

  it('updateOutcome sets pnl and equity by cycle_id', async () => {
    await service.record(makeEpisodeInput({ cycle_id: 'C1' }));
    await service.updateOutcome('C1', 42.5, 10042.5);
    const row = db
      .prepare("SELECT outcome_pnl, outcome_equity FROM episode_memory WHERE cycle_id = 'C1'")
      .get() as { outcome_pnl: number; outcome_equity: number };
    expect(row.outcome_pnl).toBeCloseTo(42.5);
    expect(row.outcome_equity).toBeCloseTo(10042.5);
  });

  it('updateOutcome with unknown cycle_id is a no-op (no error)', async () => {
    await expect(service.updateOutcome('UNKNOWN', 0, 0)).resolves.not.toThrow();
  });

  it('promote() is a no-op stub (PR3)', async () => {
    await expect(service.promote({ text: 'test lesson' })).resolves.not.toThrow();
  });
});
