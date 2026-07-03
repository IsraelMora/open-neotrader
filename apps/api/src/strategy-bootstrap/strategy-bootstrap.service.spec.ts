import { Logger } from '@nestjs/common';
import {
  StrategyBootstrapService,
  MOMENTUM_UNIVERSE,
  PLUGINS_TO_ACTIVATE,
  PLUGINS_TO_DEACTIVATE,
  BOOTSTRAP_APPLIED_KEY,
  LLM_GEMINI_APPLIED_KEY,
  PRETEST_PORTFOLIOS_TO_SEED,
} from './strategy-bootstrap.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { KvService } from '../common/kv.service';
import type { LlmService } from '../llm/llm.service';

function makeKv(initial: Record<string, string> = {}): {
  kv: KvService;
  store: Record<string, string>;
  setMock: jest.Mock;
} {
  const store = { ...initial };
  const setMock = jest.fn((k: string, v: string) => {
    store[k] = v;
    return Promise.resolve();
  });
  const kv = {
    get: jest.fn((k: string) => Promise.resolve(store[k] ?? null)),
    set: setMock,
    delete: jest.fn(() => Promise.resolve()),
  } as unknown as KvService;
  return { kv, store, setMock };
}

/** Minimal LlmService mock — only patchConfig is exercised by the bootstrap step. */
function makeLlm(opts: { throwOnPatch?: boolean } = {}): {
  llm: LlmService;
  patchConfig: jest.Mock;
} {
  const patchConfig = jest.fn((_patch: { model?: string; backend?: string }) => {
    if (opts.throwOnPatch) {
      throw new Error('patchConfig failed');
    }
    return {};
  });
  const llm = { patchConfig } as unknown as LlmService;
  return { llm, patchConfig };
}

function makeDb(
  missingIds: string[] = [],
  throwingIds: string[] = [],
  opts: {
    existingPretestNames?: string[];
    throwingPretestNames?: string[];
  } = {},
): {
  db: PrismaService;
  updateMany: jest.Mock;
  pretestFindUnique: jest.Mock;
  pretestCreate: jest.Mock;
} {
  const updateMany = jest.fn(({ where }: { where: { id: string } }) => {
    if (throwingIds.includes(where.id)) {
      return Promise.reject(new Error(`db error for ${where.id}`));
    }
    if (missingIds.includes(where.id)) {
      return Promise.resolve({ count: 0 });
    }
    return Promise.resolve({ count: 1 });
  });

  const existingPretestNames = opts.existingPretestNames ?? [];
  const throwingPretestNames = opts.throwingPretestNames ?? [];

  const pretestFindUnique = jest.fn(({ where }: { where: { name: string } }) => {
    if (existingPretestNames.includes(where.name)) {
      return Promise.resolve({ id: 'existing-id', name: where.name });
    }
    return Promise.resolve(null);
  });
  const pretestCreate = jest.fn(({ data }: { data: { name: string } }) => {
    if (throwingPretestNames.includes(data.name)) {
      return Promise.reject(new Error(`db error creating ${data.name}`));
    }
    return Promise.resolve({ id: 'new-id', ...data });
  });

  return {
    db: {
      plugin: { updateMany },
      pretestPortfolio: { findUnique: pretestFindUnique, create: pretestCreate },
    } as unknown as PrismaService,
    updateMany,
    pretestFindUnique,
    pretestCreate,
  };
}

describe('StrategyBootstrapService', () => {
  it('applies the bootstrap once, then no-ops on a second run (idempotency guard)', async () => {
    const { kv, store } = makeKv();
    const { db, updateMany } = makeDb();
    const { llm } = makeLlm();
    const svc = new StrategyBootstrapService(db, kv, llm);

    await svc.run();
    expect(store[BOOTSTRAP_APPLIED_KEY]).toBe('true');
    const callCountAfterFirst = updateMany.mock.calls.length;

    await svc.run();
    // No new plugin mutations on the second run — guard short-circuited before any writes.
    expect(updateMany.mock.calls).toHaveLength(callCountAfterFirst);
  });

  it('writes cycle.universe with the momentum rotation symbol list', async () => {
    const { kv, store } = makeKv();
    const { db } = makeDb();
    const { llm } = makeLlm();
    const svc = new StrategyBootstrapService(db, kv, llm);

    await svc.run();

    expect(store['cycle.universe']).toBe(MOMENTUM_UNIVERSE);
  });

  it('activates the momentum stack plugins and deactivates the noisy/buggy ones', async () => {
    const { kv } = makeKv();
    const { db, updateMany } = makeDb();
    const { llm } = makeLlm();
    const svc = new StrategyBootstrapService(db, kv, llm);

    await svc.run();

    for (const id of PLUGINS_TO_ACTIVATE) {
      expect(updateMany).toHaveBeenCalledWith({ where: { id }, data: { active: true } });
    }
    for (const id of PLUGINS_TO_DEACTIVATE) {
      expect(updateMany).toHaveBeenCalledWith({ where: { id }, data: { active: false } });
    }
  });

  it('sets PAPER mode (execution.real=false) and enables the scheduler with a sane interval', async () => {
    const { kv, store } = makeKv();
    const { db } = makeDb();
    const { llm } = makeLlm();
    const svc = new StrategyBootstrapService(db, kv, llm);

    await svc.run();

    expect(store['execution.real']).toBe('false');
    const scheduler = JSON.parse(store['scheduler']) as {
      enabled: boolean;
      override_interval_ms: number;
    };
    expect(scheduler.enabled).toBe(true);
    expect(scheduler.override_interval_ms).toBeGreaterThanOrEqual(30 * 60_000);
    expect(scheduler.override_interval_ms).toBeLessThanOrEqual(60 * 60_000);
  });

  it('preserves an existing scheduler override_interval_ms instead of clobbering it', async () => {
    const { kv, store } = makeKv({
      scheduler: JSON.stringify({ enabled: false, override_interval_ms: 90_000 }),
    });
    const { db } = makeDb();
    const { llm } = makeLlm();
    const svc = new StrategyBootstrapService(db, kv, llm);

    await svc.run();

    const scheduler = JSON.parse(store['scheduler']) as {
      enabled: boolean;
      override_interval_ms: number;
    };
    expect(scheduler.enabled).toBe(true);
    expect(scheduler.override_interval_ms).toBe(90_000);
  });

  it('NEVER sets execution.real=true and NEVER touches the real-money kill-switch', async () => {
    const { kv, setMock } = makeKv();
    const { db } = makeDb();
    const { llm } = makeLlm();
    const svc = new StrategyBootstrapService(db, kv, llm);

    await svc.run();

    const realCalls = setMock.mock.calls.filter(
      (c: unknown[]) => c[0] === 'execution.real',
    ) as Array<[string, string]>;
    expect(realCalls).toHaveLength(1);
    expect(realCalls[0][1]).toBe('false');

    const haltCalls = setMock.mock.calls.filter((c: unknown[]) => c[0] === 'real_execution.halted');
    expect(haltCalls).toHaveLength(0);
  });

  it('sets bootstrap.momentum_v1_applied LAST, only after config/plugin writes succeed', async () => {
    const { kv, setMock } = makeKv();
    const { db } = makeDb();
    const { llm } = makeLlm();
    const svc = new StrategyBootstrapService(db, kv, llm);

    await svc.run();

    const keysInOrder = setMock.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(keysInOrder[keysInOrder.length - 1]).toBe(BOOTSTRAP_APPLIED_KEY);
  });

  it('is fail-soft when a plugin row is missing: continues and still completes the bootstrap', async () => {
    const { kv, store } = makeKv();
    const { db } = makeDb(['momentum-factor-12-1']);
    const { llm } = makeLlm();
    const svc = new StrategyBootstrapService(db, kv, llm);

    await expect(svc.run()).resolves.not.toThrow();
    expect(store[BOOTSTRAP_APPLIED_KEY]).toBe('true');
    expect(store['cycle.universe']).toBe(MOMENTUM_UNIVERSE);
  });

  it('is fail-soft when a plugin update throws (DB error): continues with the rest', async () => {
    const { kv, store } = makeKv();
    const { db, updateMany } = makeDb([], ['trend-following']);
    const { llm } = makeLlm();
    const svc = new StrategyBootstrapService(db, kv, llm);

    await expect(svc.run()).resolves.not.toThrow();
    // The rest of the plugins still get processed despite one throwing.
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'relative-strength' },
      data: { active: true },
    });
    expect(store[BOOTSTRAP_APPLIED_KEY]).toBe('true');
  });

  it('onModuleInit never throws even if the KV layer is completely broken', async () => {
    const kv = {
      get: jest.fn().mockRejectedValue(new Error('db is down')),
      set: jest.fn().mockRejectedValue(new Error('db is down')),
      delete: jest.fn(),
    } as unknown as KvService;
    const { db } = makeDb();
    const { llm } = makeLlm();
    const svc = new StrategyBootstrapService(db, kv, llm);

    await expect(svc.onModuleInit()).resolves.not.toThrow();
  });

  it('creates the scheduler KV with run_count:0 (cosmetic fix — avoids run_count+1 = NaN)', async () => {
    const { kv, store } = makeKv();
    const { db } = makeDb();
    const { llm } = makeLlm();
    const svc = new StrategyBootstrapService(db, kv, llm);

    await svc.run();

    const scheduler = JSON.parse(store['scheduler']) as { run_count: number };
    expect(scheduler.run_count).toBe(0);
  });

  it('defaults run_count to 0 when an existing scheduler config is missing the field', async () => {
    const { kv, store } = makeKv({
      scheduler: JSON.stringify({ enabled: false, override_interval_ms: 90_000 }),
    });
    const { db } = makeDb();
    const { llm } = makeLlm();
    const svc = new StrategyBootstrapService(db, kv, llm);

    await svc.run();

    const scheduler = JSON.parse(store['scheduler']) as { run_count: number };
    expect(scheduler.run_count).toBe(0);
  });

  it('preserves an existing run_count instead of clobbering it', async () => {
    const { kv, store } = makeKv({
      scheduler: JSON.stringify({ enabled: false, override_interval_ms: 90_000, run_count: 7 }),
    });
    const { db } = makeDb();
    const { llm } = makeLlm();
    const svc = new StrategyBootstrapService(db, kv, llm);

    await svc.run();

    const scheduler = JSON.parse(store['scheduler']) as { run_count: number };
    expect(scheduler.run_count).toBe(7);
  });
});

// ── Risk-differentiated pretest portfolios ────────────────────────────────────
//
// Bootstrap also seeds 3 virtual pretest portfolios (Conservative/Aggressive/Trend-only)
// that all trade the same global ETF universe seeded above, at different risk profiles.
// Idempotency reuses the SAME bootstrap.momentum_v1_applied flag — no separate KV key.

describe('StrategyBootstrapService — pretest portfolio seeding', () => {
  it('seeds exactly 3 risk-differentiated pretest portfolios on first run', async () => {
    const { kv } = makeKv();
    const { db, pretestCreate } = makeDb();
    const { llm } = makeLlm();
    const svc = new StrategyBootstrapService(db, kv, llm);

    await svc.run();

    expect(pretestCreate).toHaveBeenCalledTimes(3);
    const names = (pretestCreate.mock.calls as Array<[{ data: { name: string } }]>).map(
      (c) => c[0].data.name,
    );
    expect(names).toEqual(
      expect.arrayContaining(['Conservador Momentum', 'Agresivo Momentum', 'Trend Puro']),
    );
  });

  it('each seeded portfolio uses $100k initial capital and the DEFAULT_STATE shape', async () => {
    const { kv } = makeKv();
    const { db, pretestCreate } = makeDb();
    const { llm } = makeLlm();
    const svc = new StrategyBootstrapService(db, kv, llm);

    await svc.run();

    for (const call of pretestCreate.mock.calls as Array<
      [{ data: { initial_capital: number; state: string } }]
    >) {
      expect(call[0].data.initial_capital).toBe(100000);
      const state = JSON.parse(call[0].data.state) as { equity: number; cash: number };
      expect(state.equity).toBe(100000);
      expect(state.cash).toBe(100000);
    }
  });

  it('plugin_configs use config keys the plugins actually read (no dead "vol_target" key)', async () => {
    const { kv } = makeKv();
    const { db, pretestCreate } = makeDb();
    const { llm } = makeLlm();
    const svc = new StrategyBootstrapService(db, kv, llm);

    await svc.run();

    for (const call of pretestCreate.mock.calls as Array<
      [{ data: { name: string; plugin_configs: string } }]
    >) {
      const configs = JSON.parse(call[0].data.plugin_configs) as Record<
        string,
        Record<string, unknown>
      >;
      const sizing = configs['position-sizing'];
      if (sizing) {
        expect(sizing['mode']).toBe('vol_target');
        expect(sizing).not.toHaveProperty('vol_target');
        // max_position_pct must be a percentage-point number (manifest range 1-25),
        // never a 0-1 fraction — that would silently clamp/misconfigure sizing.
        expect(sizing['max_position_pct']).toBeGreaterThanOrEqual(1);
        expect(sizing['max_position_pct']).toBeLessThanOrEqual(25);
      }
      const policy = configs['__pretest_policy__'];
      expect(policy).toBeDefined();
      expect(typeof policy['sizing_pct']).toBe('number');
    }
  });

  it('is idempotent by name: does not recreate a portfolio that already exists', async () => {
    const { kv } = makeKv();
    const { db, pretestCreate } = makeDb([], [], {
      existingPretestNames: ['Conservador Momentum'],
    });
    const { llm } = makeLlm();
    const svc = new StrategyBootstrapService(db, kv, llm);

    await svc.run();

    const names = (pretestCreate.mock.calls as Array<[{ data: { name: string } }]>).map(
      (c) => c[0].data.name,
    );
    expect(names).not.toContain('Conservador Momentum');
    expect(names).toEqual(expect.arrayContaining(['Agresivo Momentum', 'Trend Puro']));
  });

  it('no-ops on a second run (gated by the same bootstrap.momentum_v1_applied flag)', async () => {
    const { kv } = makeKv();
    const { db, pretestCreate } = makeDb();
    const { llm } = makeLlm();
    const svc = new StrategyBootstrapService(db, kv, llm);

    await svc.run();
    const callsAfterFirst = pretestCreate.mock.calls.length;
    await svc.run();

    expect(pretestCreate.mock.calls).toHaveLength(callsAfterFirst);
  });

  it('is fail-soft: a create failure for one portfolio does not block the rest or the bootstrap', async () => {
    const { kv, store } = makeKv();
    const { db, pretestCreate } = makeDb([], [], {
      throwingPretestNames: ['Agresivo Momentum'],
    });
    const { llm } = makeLlm();
    const svc = new StrategyBootstrapService(db, kv, llm);

    await expect(svc.run()).resolves.not.toThrow();
    expect(store[BOOTSTRAP_APPLIED_KEY]).toBe('true');
    const names = (pretestCreate.mock.calls as Array<[{ data: { name: string } }]>).map(
      (c) => c[0].data.name,
    );
    expect(names).toEqual(
      expect.arrayContaining(['Conservador Momentum', 'Agresivo Momentum', 'Trend Puro']),
    );
  });

  it('PRETEST_PORTFOLIOS_TO_SEED exposes exactly the 3 expected specs', () => {
    expect(PRETEST_PORTFOLIOS_TO_SEED.map((p) => p.name)).toEqual([
      'Conservador Momentum',
      'Agresivo Momentum',
      'Trend Puro',
    ]);
  });
});

// ── LLM Gemini backend switch ─────────────────────────────────────────────────
//
// Independent idempotent step, gated by its own KV flag (LLM_GEMINI_APPLIED_KEY),
// so it keeps retrying on every boot until GEMINI_API_KEY is present — even after
// the momentum bootstrap has already been marked applied.

describe('StrategyBootstrapService — Gemini LLM backend switch', () => {
  const ORIGINAL_GEMINI_KEY = process.env.GEMINI_API_KEY;

  afterEach(() => {
    if (ORIGINAL_GEMINI_KEY === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = ORIGINAL_GEMINI_KEY;
    }
  });

  it('switches the LLM backend to gemini and marks the flag when GEMINI_API_KEY is present', async () => {
    process.env.GEMINI_API_KEY = 'test-key-value';
    const { kv, store } = makeKv();
    const { db } = makeDb();
    const { llm, patchConfig } = makeLlm();
    const svc = new StrategyBootstrapService(db, kv, llm);

    await svc.run();

    expect(patchConfig).toHaveBeenCalledWith({ backend: 'gemini', model: 'gemini-3-flash-preview' });
    expect(store[LLM_GEMINI_APPLIED_KEY]).toBe('true');
  });

  it('skips the switch and does NOT set the flag when GEMINI_API_KEY is absent', async () => {
    delete process.env.GEMINI_API_KEY;
    const { kv, store } = makeKv();
    const { db } = makeDb();
    const { llm, patchConfig } = makeLlm();
    const svc = new StrategyBootstrapService(db, kv, llm);

    await svc.run();

    expect(patchConfig).not.toHaveBeenCalled();
    expect(store[LLM_GEMINI_APPLIED_KEY]).toBeUndefined();
  });

  it('is idempotent: no-ops on a second run once the flag is already set', async () => {
    process.env.GEMINI_API_KEY = 'test-key-value';
    const { kv } = makeKv({ [LLM_GEMINI_APPLIED_KEY]: 'true' });
    const { db } = makeDb();
    const { llm, patchConfig } = makeLlm();
    const svc = new StrategyBootstrapService(db, kv, llm);

    await svc.run();

    expect(patchConfig).not.toHaveBeenCalled();
  });

  it('retries on a later boot once the key appears, even if the momentum bootstrap already applied', async () => {
    process.env.GEMINI_API_KEY = 'test-key-value';
    const { kv, store } = makeKv({ [BOOTSTRAP_APPLIED_KEY]: 'true' });
    const { db } = makeDb();
    const { llm, patchConfig } = makeLlm();
    const svc = new StrategyBootstrapService(db, kv, llm);

    await svc.run();

    expect(patchConfig).toHaveBeenCalledWith({ backend: 'gemini', model: 'gemini-3-flash-preview' });
    expect(store[LLM_GEMINI_APPLIED_KEY]).toBe('true');
  });

  it('is fail-soft: does not set the flag and does not throw if patchConfig throws', async () => {
    process.env.GEMINI_API_KEY = 'test-key-value';
    const { kv, store } = makeKv();
    const { db } = makeDb();
    const { llm } = makeLlm({ throwOnPatch: true });
    const svc = new StrategyBootstrapService(db, kv, llm);

    await expect(svc.run()).resolves.not.toThrow();
    expect(store[LLM_GEMINI_APPLIED_KEY]).toBeUndefined();
  });

  it('never logs or embeds the API key value itself', async () => {
    process.env.GEMINI_API_KEY = 'super-secret-value-should-not-leak';
    const { kv } = makeKv();
    const { db } = makeDb();
    const { llm, patchConfig } = makeLlm();
    const svc = new StrategyBootstrapService(db, kv, llm);
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    await svc.run();

    for (const call of logSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('super-secret-value-should-not-leak');
    }
    expect(patchConfig).toHaveBeenCalledWith({ backend: 'gemini', model: 'gemini-3-flash-preview' });
    logSpy.mockRestore();
  });
});
