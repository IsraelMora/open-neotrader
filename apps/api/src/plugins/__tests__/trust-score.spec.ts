/**
 * trust-score.spec.ts — Phases 2.1–2.5 TDD RED→GREEN
 *
 * F3-s4: Trust Score + Badge + Content Checksum
 * Unit tests for pure functions: computeTrustScore, _readTrustConfig, computeContentChecksum.
 * All tests use no DB, no I/O (computeTrustScore is pure; checksum tests use tmp dirs).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { KvService } from '../../common/kv.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { PluginEventsService } from '../plugin-events.service';
import type { ConfigService } from '@nestjs/config';
import { computeTrustScore, PluginsService } from '../plugins.service';

// ── Helpers ───────────────────────────────────────────────────────────────────

const DEFAULT_WEIGHTS = { scan: 0.3, smoke: 0.2, reputation: 0.4, votes: 0.1 };
const DEFAULT_THRESHOLD = 80;

/** Build a minimal plugin-row-like object for computeTrustScore tests */
function makeRow(opts: {
  scan_result?: string | null;
  smoke_test_result?: string | null;
  reputation_score?: number | null;
  votes_net?: number;
}): Parameters<typeof computeTrustScore>[0] {
  return {
    scan_result: opts.scan_result ?? null,
    smoke_test_result: opts.smoke_test_result ?? null,
    reputation_score: opts.reputation_score ?? null,
    votes_net: opts.votes_net ?? 0,
  };
}

function scanWith(warnCount: number): string {
  const findings = Array.from({ length: warnCount }, (_, i) => ({
    severity: 'warning',
    message: `warn${i}`,
  }));
  return JSON.stringify({ ok: true, findings });
}

function smokeWith(result: 'passed' | 'inconclusive' | 'failed'): string {
  return JSON.stringify({ ok: true, result, checks: [] });
}

/** Build PluginsService wired with a KV mock for _readTrustConfig tests */
function makeServiceWithKvMock(kvMap: Record<string, string | null>): PluginsService {
  const db = {
    plugin: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  } as unknown as PrismaService;
  const events = { emit: jest.fn() } as unknown as PluginEventsService;
  const cfg = { get: jest.fn().mockReturnValue('/var/plugins') } as unknown as ConfigService;
  const kv = {
    get: jest.fn().mockImplementation((key: string) => Promise.resolve(kvMap[key] ?? null)),
    set: jest.fn(),
  } as unknown as KvService;

  const svc = new PluginsService(db, events, cfg, kv);
  svc.getManifest = jest.fn().mockReturnValue(null);
  return svc;
}

// ── Phase 2.1: computeTrustScore — normalization suite ────────────────────────

describe('computeTrustScore — normalization (Phase 2.1)', () => {
  // scan normalization
  it('scan: 0 warnings → normalized 100', () => {
    const row = makeRow({ scan_result: scanWith(0) });
    const { breakdown } = computeTrustScore(row, DEFAULT_WEIGHTS, DEFAULT_THRESHOLD);
    expect(breakdown.inputs.scan).toBe(100);
  });

  it('scan: 1 warning → normalized 90', () => {
    const row = makeRow({ scan_result: scanWith(1) });
    const { breakdown } = computeTrustScore(row, DEFAULT_WEIGHTS, DEFAULT_THRESHOLD);
    expect(breakdown.inputs.scan).toBe(90);
  });

  it('scan: 10 warnings → normalized 0 (floored)', () => {
    const row = makeRow({ scan_result: scanWith(10) });
    const { breakdown } = computeTrustScore(row, DEFAULT_WEIGHTS, DEFAULT_THRESHOLD);
    expect(breakdown.inputs.scan).toBe(0);
  });

  it('scan: 15 warnings → normalized 0 (clamped, not negative)', () => {
    const row = makeRow({ scan_result: scanWith(15) });
    const { breakdown } = computeTrustScore(row, DEFAULT_WEIGHTS, DEFAULT_THRESHOLD);
    expect(breakdown.inputs.scan).toBe(0);
  });

  it('scan: null → excluded (breakdown.inputs.scan is null)', () => {
    const row = makeRow({ scan_result: null });
    const { breakdown } = computeTrustScore(row, DEFAULT_WEIGHTS, DEFAULT_THRESHOLD);
    expect(breakdown.inputs.scan).toBeNull();
  });

  // smoke normalization
  it('smoke: passed → 100', () => {
    const row = makeRow({ smoke_test_result: smokeWith('passed') });
    const { breakdown } = computeTrustScore(row, DEFAULT_WEIGHTS, DEFAULT_THRESHOLD);
    expect(breakdown.inputs.smoke).toBe(100);
  });

  it('smoke: inconclusive → 50', () => {
    const row = makeRow({ smoke_test_result: smokeWith('inconclusive') });
    const { breakdown } = computeTrustScore(row, DEFAULT_WEIGHTS, DEFAULT_THRESHOLD);
    expect(breakdown.inputs.smoke).toBe(50);
  });

  it('smoke: failed → 0', () => {
    const row = makeRow({ smoke_test_result: smokeWith('failed') });
    const { breakdown } = computeTrustScore(row, DEFAULT_WEIGHTS, DEFAULT_THRESHOLD);
    expect(breakdown.inputs.smoke).toBe(0);
  });

  it('smoke: null → excluded', () => {
    const row = makeRow({ smoke_test_result: null });
    const { breakdown } = computeTrustScore(row, DEFAULT_WEIGHTS, DEFAULT_THRESHOLD);
    expect(breakdown.inputs.smoke).toBeNull();
  });

  // reputation normalization
  it('reputation: 72 → passes through as 72', () => {
    const row = makeRow({ reputation_score: 72 });
    const { breakdown } = computeTrustScore(row, DEFAULT_WEIGHTS, DEFAULT_THRESHOLD);
    expect(breakdown.inputs.reputation).toBe(72);
  });

  it('reputation: null → excluded', () => {
    const row = makeRow({ reputation_score: null });
    const { breakdown } = computeTrustScore(row, DEFAULT_WEIGHTS, DEFAULT_THRESHOLD);
    expect(breakdown.inputs.reputation).toBeNull();
  });

  // votes normalization
  it('votes_net: 0 → neutral 50', () => {
    const row = makeRow({ votes_net: 0 });
    const { breakdown } = computeTrustScore(row, DEFAULT_WEIGHTS, DEFAULT_THRESHOLD);
    expect(breakdown.inputs.votes).toBe(50);
  });

  it('votes_net: +10 → 100', () => {
    const row = makeRow({ votes_net: 10 });
    const { breakdown } = computeTrustScore(row, DEFAULT_WEIGHTS, DEFAULT_THRESHOLD);
    expect(breakdown.inputs.votes).toBe(100);
  });

  it('votes_net: -10 → 0', () => {
    const row = makeRow({ votes_net: -10 });
    const { breakdown } = computeTrustScore(row, DEFAULT_WEIGHTS, DEFAULT_THRESHOLD);
    expect(breakdown.inputs.votes).toBe(0);
  });

  it('votes_net: +100 → clamped to 100', () => {
    const row = makeRow({ votes_net: 100 });
    const { breakdown } = computeTrustScore(row, DEFAULT_WEIGHTS, DEFAULT_THRESHOLD);
    expect(breakdown.inputs.votes).toBe(100);
  });

  it('votes_net is NEVER excluded (always in breakdown.inputs.votes as a number)', () => {
    const row = makeRow({ votes_net: 0 });
    const { breakdown } = computeTrustScore(row, DEFAULT_WEIGHTS, DEFAULT_THRESHOLD);
    expect(breakdown.inputs.votes).not.toBeNull();
    expect(typeof breakdown.inputs.votes).toBe('number');
  });
});

// ── Phase 2.2: computeTrustScore — re-weighting + edge cases ─────────────────

describe('computeTrustScore — re-weighting and edge cases (Phase 2.2)', () => {
  it('all signals present (denom=1.0): worked example scan=1warn/smoke=passed/rep=72/votes=0 → 80.8', () => {
    // nScan=90, nSmoke=100, nRep=72, nVotes=50
    // raw = .3*90 + .2*100 + .4*72 + .1*50 = 27+20+28.8+5 = 80.8
    const row = makeRow({
      scan_result: scanWith(1),
      smoke_test_result: smokeWith('passed'),
      reputation_score: 72,
      votes_net: 0,
    });
    const { trust_score } = computeTrustScore(row, DEFAULT_WEIGHTS, DEFAULT_THRESHOLD);
    expect(trust_score).toBeCloseTo(80.8, 1);
  });

  it('reputation null → denom=0.6, raw = (0.3*90 + 0.2*100 + 0.1*50)/0.6 = 86.7', () => {
    // nScan=90, nSmoke=100, nVotes=50; reputation excluded → denom=0.3+0.2+0.1=0.6
    // raw=(27+20+5)/0.6=52/0.6=86.666... → 86.7
    const row = makeRow({
      scan_result: scanWith(1),
      smoke_test_result: smokeWith('passed'),
      reputation_score: null,
      votes_net: 0,
    });
    const { trust_score } = computeTrustScore(row, DEFAULT_WEIGHTS, DEFAULT_THRESHOLD);
    expect(trust_score).toBeCloseTo(86.7, 1);
  });

  it('scan+smoke+reputation all null, votes_net=0 → trust_score=50 (votes reweights to 100%)', () => {
    // AC-4: brand-new plugin → NOT zero, votes alone, trust_score=50
    const row = makeRow({
      scan_result: null,
      smoke_test_result: null,
      reputation_score: null,
      votes_net: 0,
    });
    const { trust_score } = computeTrustScore(row, DEFAULT_WEIGHTS, DEFAULT_THRESHOLD);
    expect(trust_score).toBe(50);
  });

  it('scan (2 warns→80) + votes (net=0→50) only: denom=0.3+0.1=0.4 → score=72.5', () => {
    // nScan=80, nVotes=50; smoke+rep excluded → denom=0.4
    // raw=(0.3*80+0.1*50)/0.4=(24+5)/0.4=29/0.4=72.5
    const row = makeRow({
      scan_result: scanWith(2),
      smoke_test_result: null,
      reputation_score: null,
      votes_net: 0,
    });
    const { trust_score } = computeTrustScore(row, DEFAULT_WEIGHTS, DEFAULT_THRESHOLD);
    expect(trust_score).toBe(72.5);
  });

  it('all weights 0 → trust_score null (denom=0)', () => {
    const row = makeRow({ votes_net: 0 });
    const { trust_score } = computeTrustScore(
      row,
      { scan: 0, smoke: 0, reputation: 0, votes: 0 },
      DEFAULT_THRESHOLD,
    );
    expect(trust_score).toBeNull();
  });
});

// ── Phase 2.3: computeTrustScore — badge threshold ───────────────────────────

describe('computeTrustScore — badge threshold (Phase 2.3)', () => {
  it('trust_score >= threshold → badge true', () => {
    // clean plugin: scan 0 warns / smoke passed / rep 80 / votes 0 → ~87 → badge true
    const row = makeRow({
      scan_result: scanWith(0),
      smoke_test_result: smokeWith('passed'),
      reputation_score: 80,
      votes_net: 0,
    });
    const { badge } = computeTrustScore(row, DEFAULT_WEIGHTS, 80);
    expect(badge).toBe(true);
  });

  it('trust_score just below threshold → badge false', () => {
    // scan=1warn(90), smoke=failed(0), rep=80, votes=0(50) → .3*90+.2*0+.4*80+.1*50 = 27+0+32+5=64 < 80
    const row = makeRow({
      scan_result: scanWith(1),
      smoke_test_result: smokeWith('failed'),
      reputation_score: 80,
      votes_net: 0,
    });
    const { trust_score, badge } = computeTrustScore(row, DEFAULT_WEIGHTS, 80);
    expect(trust_score).toBeLessThan(80);
    expect(badge).toBe(false);
  });

  it('null trust_score → badge false', () => {
    const row = makeRow({ votes_net: 0 });
    const { badge } = computeTrustScore(row, { scan: 0, smoke: 0, reputation: 0, votes: 0 }, 80);
    expect(badge).toBe(false);
  });

  it('custom threshold: trust_score=65 with threshold=60 → badge true', () => {
    // force a score around 65: scan=2warns(80), rep=50, votes=0(50); smoke=null
    // denom=0.3+0.4+0.1=0.8; raw=(24+20+5)/0.8=49/0.8=61.25
    const row = makeRow({
      scan_result: scanWith(2),
      smoke_test_result: null,
      reputation_score: 50,
      votes_net: 0,
    });
    const { trust_score, badge } = computeTrustScore(row, DEFAULT_WEIGHTS, 60);
    expect(trust_score).toBeLessThan(80);
    expect(badge).toBe(trust_score !== null && trust_score >= 60);
  });

  it('breakdown shape includes inputs, weights_used, threshold', () => {
    const row = makeRow({ votes_net: 0 });
    const { breakdown } = computeTrustScore(row, DEFAULT_WEIGHTS, DEFAULT_THRESHOLD);
    expect(breakdown).toHaveProperty('inputs');
    expect(breakdown).toHaveProperty('weights_used');
    expect(breakdown).toHaveProperty('threshold', DEFAULT_THRESHOLD);
  });

  it('breakdown.inputs contains scan, smoke, reputation, votes keys', () => {
    const row = makeRow({ votes_net: 0 });
    const { breakdown } = computeTrustScore(row, DEFAULT_WEIGHTS, DEFAULT_THRESHOLD);
    expect(breakdown.inputs).toHaveProperty('scan');
    expect(breakdown.inputs).toHaveProperty('smoke');
    expect(breakdown.inputs).toHaveProperty('reputation');
    expect(breakdown.inputs).toHaveProperty('votes');
  });
});

// ── Phase 2.4: _readTrustConfig fail-safe ────────────────────────────────────

describe('PluginsService._readTrustConfig (Phase 2.4)', () => {
  beforeEach(() => jest.restoreAllMocks());

  it('missing KV keys → defaults {scan:0.3,smoke:0.2,reputation:0.4,votes:0.1} + threshold 80', async () => {
    const svc = makeServiceWithKvMock({});
    // Access private method via bracket notation
    const cfg = await (
      svc as unknown as {
        _readTrustConfig(): Promise<{ weights: Record<string, number>; threshold: number }>;
      }
    )._readTrustConfig();
    expect(cfg.weights).toEqual({ scan: 0.3, smoke: 0.2, reputation: 0.4, votes: 0.1 });
    expect(cfg.threshold).toBe(80);
  });

  it('malformed JSON in trust.weights → defaults', async () => {
    const svc = makeServiceWithKvMock({ 'trust.weights': 'not-json{{{' });
    const cfg = await (
      svc as unknown as {
        _readTrustConfig(): Promise<{ weights: Record<string, number>; threshold: number }>;
      }
    )._readTrustConfig();
    expect(cfg.weights).toEqual({ scan: 0.3, smoke: 0.2, reputation: 0.4, votes: 0.1 });
  });

  it('negative weight → coerced to 0', async () => {
    const svc = makeServiceWithKvMock({
      'trust.weights': JSON.stringify({ scan: -0.1, smoke: 0.3, reputation: 0.4, votes: 0.2 }),
    });
    const cfg = await (
      svc as unknown as {
        _readTrustConfig(): Promise<{ weights: Record<string, number>; threshold: number }>;
      }
    )._readTrustConfig();
    expect(cfg.weights.scan).toBe(0);
    expect(cfg.weights.smoke).toBeCloseTo(0.3, 5);
  });

  it('all-zero weights → restore defaults', async () => {
    const svc = makeServiceWithKvMock({
      'trust.weights': JSON.stringify({ scan: 0, smoke: 0, reputation: 0, votes: 0 }),
    });
    const cfg = await (
      svc as unknown as {
        _readTrustConfig(): Promise<{ weights: Record<string, number>; threshold: number }>;
      }
    )._readTrustConfig();
    expect(cfg.weights).toEqual({ scan: 0.3, smoke: 0.2, reputation: 0.4, votes: 0.1 });
  });

  it('bad/missing trust.badge_threshold → 80', async () => {
    const svc = makeServiceWithKvMock({ 'trust.badge_threshold': 'not-a-number' });
    const cfg = await (
      svc as unknown as {
        _readTrustConfig(): Promise<{ weights: Record<string, number>; threshold: number }>;
      }
    )._readTrustConfig();
    expect(cfg.threshold).toBe(80);
  });

  it('trust.badge_threshold below 0 → clamped to 0', async () => {
    const svc = makeServiceWithKvMock({ 'trust.badge_threshold': '-5' });
    const cfg = await (
      svc as unknown as {
        _readTrustConfig(): Promise<{ weights: Record<string, number>; threshold: number }>;
      }
    )._readTrustConfig();
    expect(cfg.threshold).toBe(0);
  });

  it('trust.badge_threshold above 100 → clamped to 100', async () => {
    const svc = makeServiceWithKvMock({ 'trust.badge_threshold': '150' });
    const cfg = await (
      svc as unknown as {
        _readTrustConfig(): Promise<{ weights: Record<string, number>; threshold: number }>;
      }
    )._readTrustConfig();
    expect(cfg.threshold).toBe(100);
  });

  it('valid custom weights read and returned correctly', async () => {
    const custom = { scan: 0.5, smoke: 0.3, reputation: 0.2, votes: 0 };
    const svc = makeServiceWithKvMock({
      'trust.weights': JSON.stringify(custom),
      'trust.badge_threshold': '60',
    });
    const cfg = await (
      svc as unknown as {
        _readTrustConfig(): Promise<{ weights: Record<string, number>; threshold: number }>;
      }
    )._readTrustConfig();
    expect(cfg.weights).toEqual(custom);
    expect(cfg.threshold).toBe(60);
  });
});

// ── Phase 2.5: computeContentChecksum ────────────────────────────────────────

describe('PluginsService.computeContentChecksum (Phase 2.5)', () => {
  let tmpDir: string;
  let svc: PluginsService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-checksum-test-'));
    svc = makeServiceWithKvMock({});
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  function callChecksum(installedPath: string | null): string | null {
    return (
      svc as unknown as { computeContentChecksum(p: string | null): string | null }
    ).computeContentChecksum(installedPath);
  }

  function writeFile(rel: string, content: string): void {
    const full = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }

  it('clean dir (manifest.toml + plugin.py + hooks/a.py + hooks/b.py) → stable 64-char hex', () => {
    writeFile('manifest.toml', '[plugin]\nname = "test"');
    writeFile('plugin.py', 'def run(): pass');
    writeFile('hooks/a.py', 'def hook_a(): pass');
    writeFile('hooks/b.py', 'def hook_b(): pass');

    const hash1 = callChecksum(tmpDir);
    const hash2 = callChecksum(tmpDir);

    expect(hash1).toHaveLength(64);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
    expect(hash1).toBe(hash2); // stable
  });

  it('reorder hooks files on disk → SAME hash (sorted deterministically)', () => {
    // Write with reversed names to confirm sorting is not disk-order dependent
    writeFile('manifest.toml', '[plugin]\nname = "test"');
    writeFile('plugin.py', 'def run(): pass');
    writeFile('hooks/z_hook.py', 'def z(): pass');
    writeFile('hooks/a_hook.py', 'def a(): pass');

    const hash = callChecksum(tmpDir);

    // Rebuild dir reversed (simulate different creation order)
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-checksum-order-'));
    try {
      fs.writeFileSync(path.join(tmpDir2, 'manifest.toml'), '[plugin]\nname = "test"', 'utf8');
      fs.writeFileSync(path.join(tmpDir2, 'plugin.py'), 'def run(): pass', 'utf8');
      fs.mkdirSync(path.join(tmpDir2, 'hooks'));
      fs.writeFileSync(path.join(tmpDir2, 'hooks', 'a_hook.py'), 'def a(): pass', 'utf8');
      fs.writeFileSync(path.join(tmpDir2, 'hooks', 'z_hook.py'), 'def z(): pass', 'utf8');

      const hash2 = callChecksum(tmpDir2);
      expect(hash).toBe(hash2);
    } finally {
      fs.rmSync(tmpDir2, { recursive: true, force: true });
    }
  });

  it('change one byte in plugin.py → DIFFERENT hash', () => {
    writeFile('manifest.toml', '[plugin]\nname = "test"');
    writeFile('plugin.py', 'def run(): pass');

    const hash1 = callChecksum(tmpDir);

    fs.writeFileSync(path.join(tmpDir, 'plugin.py'), 'def run(): return 1', 'utf8');
    const hash2 = callChecksum(tmpDir);

    expect(hash1).not.toBe(hash2);
  });

  it('missing plugin.py (manifest + hooks only) → still computes hash', () => {
    writeFile('manifest.toml', '[plugin]\nname = "test"');
    writeFile('hooks/hook.py', 'def h(): pass');
    // plugin.py intentionally absent

    const hash = callChecksum(tmpDir);
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('empty hooks dir (no *.py) → hash over manifest+plugin.py only', () => {
    writeFile('manifest.toml', '[plugin]\nname = "test"');
    writeFile('plugin.py', 'def run(): pass');
    fs.mkdirSync(path.join(tmpDir, 'hooks'));
    // No .py files in hooks

    const hash = callChecksum(tmpDir);
    expect(hash).toHaveLength(64);
  });

  it('null installedPath → null', () => {
    expect(callChecksum(null)).toBeNull();
  });

  it('no files present at all → null', () => {
    // tmpDir is empty
    const hash = callChecksum(tmpDir);
    expect(hash).toBeNull();
  });
});
