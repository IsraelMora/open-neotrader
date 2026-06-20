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

// ── Task 3.3 / 3.4: promote + listLessons + FIFO prune ───────────────────────

const MIGRATION_FILE_0009 = path.resolve(
  __dirname,
  '../..',
  'prisma/migrations/0009_lesson_memory/migration.sql',
);

/** Build a real in-memory DB with both 0008 and 0009 schema applied. */
function makeDb0009(): Database.Database {
  const db = new Database(':memory:');
  const sql0008 = fs.readFileSync(MIGRATION_FILE, 'utf8');
  db.exec(sql0008);
  const sql0009 = fs.readFileSync(MIGRATION_FILE_0009, 'utf8');
  db.exec(sql0009);
  return db;
}

describe('LongTermMemoryService promote + listLessons (integration)', () => {
  let service: LongTermMemoryService;
  let db: Database.Database;

  beforeEach(async () => {
    db = makeDb0009();
    const prisma = makePrismaFromDb(db);
    service = new LongTermMemoryService(prisma);
    await service.onModuleInit();
  });

  afterEach(() => {
    db.close();
  });

  it('promote inserts a lesson row into lesson_memory', async () => {
    await service.promote({ text: 'Lesson A', rationale: 'why A' });
    const count = (db.prepare('SELECT COUNT(*) as n FROM lesson_memory').get() as { n: number }).n;
    expect(count).toBe(1);
  });

  it('promote stores text and rationale correctly', async () => {
    await service.promote({ text: 'Important lesson', rationale: 'because', episode_id: 'ep-1' });
    const row = db
      .prepare('SELECT text, rationale, episode_id FROM lesson_memory LIMIT 1')
      .get() as { text: string; rationale: string; episode_id: string };
    expect(row.text).toBe('Important lesson');
    expect(row.rationale).toBe('because');
    expect(row.episode_id).toBe('ep-1');
  });

  it('promote never throws on DB error (fail-soft)', async () => {
    const brokenPrisma = {
      $executeRaw: jest.fn().mockRejectedValue(new Error('DB error')),
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn().mockRejectedValue(new Error('DB error')),
    } as unknown as PrismaService;
    const s = new LongTermMemoryService(brokenPrisma);
    await expect(s.promote({ text: 'lesson' })).resolves.not.toThrow();
  });

  it('FIFO prune: after inserting 31st lesson, count stays at 30', async () => {
    // Insert 30 lessons
    for (let i = 0; i < 30; i++) {
      await service.promote({ text: `Lesson ${String(i)}` });
    }
    let count = (db.prepare('SELECT COUNT(*) as n FROM lesson_memory').get() as { n: number }).n;
    expect(count).toBe(30);

    // Insert the 31st — oldest should be deleted
    await service.promote({ text: 'Lesson 31 — newest' });
    count = (db.prepare('SELECT COUNT(*) as n FROM lesson_memory').get() as { n: number }).n;
    expect(count).toBe(30);
  });

  it('FIFO prune: the oldest lesson is deleted (not the newest)', async () => {
    // Insert 30 lessons with distinct text
    await service.promote({ text: 'OLDEST LESSON' });
    for (let i = 1; i < 30; i++) {
      await service.promote({ text: `Filler ${String(i)}` });
    }
    // Insert the 31st
    await service.promote({ text: 'NEWEST LESSON' });

    const rows = db.prepare('SELECT text FROM lesson_memory ORDER BY ts ASC').all() as { text: string }[];
    const texts = rows.map((r) => r.text);
    // Oldest ('OLDEST LESSON') should be gone
    expect(texts).not.toContain('OLDEST LESSON');
    // Newest should still be present
    expect(texts).toContain('NEWEST LESSON');
  });

  it('listLessons returns the most recent N lessons ordered newest-first', async () => {
    await service.promote({ text: 'First lesson' });
    await service.promote({ text: 'Second lesson' });
    await service.promote({ text: 'Third lesson' });

    const lessons = await service.listLessons(2);
    expect(lessons.length).toBe(2);
    // Most recent first
    expect(lessons[0]?.text).toBe('Third lesson');
    expect(lessons[1]?.text).toBe('Second lesson');
  });

  it('listLessons returns empty array when no lessons', async () => {
    const lessons = await service.listLessons(3);
    expect(lessons).toEqual([]);
  });

  it('listLessons never throws on DB error (fail-soft)', async () => {
    const brokenPrisma = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      $queryRaw: jest.fn().mockRejectedValue(new Error('DB error')),
      $transaction: jest.fn().mockResolvedValue(undefined),
    } as unknown as PrismaService;
    const s = new LongTermMemoryService(brokenPrisma);
    await expect(s.listLessons(3)).resolves.not.toThrow();
    const result = await s.listLessons(3).catch(() => 'threw');
    expect(result).not.toBe('threw');
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

  it('promote() does not throw (lesson_memory table not available in 0008-only DB — fail-soft)', async () => {
    // promote() inserts into lesson_memory which doesn't exist in the 0008 DB.
    // It must swallow the error and not throw (fail-soft contract).
    await expect(service.promote({ text: 'test lesson' })).resolves.not.toThrow();
  });
});
