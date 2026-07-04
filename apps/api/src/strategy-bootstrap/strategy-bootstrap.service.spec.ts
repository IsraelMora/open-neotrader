import { Logger } from '@nestjs/common';
import {
  StrategyBootstrapService,
  MOMENTUM_UNIVERSE,
  PLUGINS_TO_ACTIVATE,
  PLUGINS_TO_DEACTIVATE,
  BOOTSTRAP_APPLIED_KEY,
  PRETEST_SEED_KEY,
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

/** Minimal LlmService mock — patchConfig and getConfig are exercised by the bootstrap step. */
function makeLlm(
  opts: {
    throwOnPatch?: boolean;
    currentBackend?: string;
    currentModel?: string;
  } = {},
): {
  llm: LlmService;
  patchConfig: jest.Mock;
  getConfig: jest.Mock;
} {
  const patchConfig = jest.fn((_patch: { model?: string; backend?: string }) => {
    if (opts.throwOnPatch) {
      throw new Error('patchConfig failed');
    }
    return {};
  });
  const getConfig = jest.fn(() => ({
    backend: opts.currentBackend ?? 'anthropic',
    model: opts.currentModel ?? 'claude-haiku-4-5-20251001',
  }));
  const llm = { patchConfig, getConfig } as unknown as LlmService;
  return { llm, patchConfig, getConfig };
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

  it('deactivates sentiment-analysis (news now comes from the kernel web_search tool, not the plugin)', async () => {
    const { kv } = makeKv();
    const { db, updateMany } = makeDb();
    const { llm } = makeLlm();
    const svc = new StrategyBootstrapService(db, kv, llm);

    await svc.run();

    expect(PLUGINS_TO_DEACTIVATE).toContain('sentiment-analysis');
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'sentiment-analysis' },
      data: { active: false },
    });
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

  it('sets bootstrap.momentum_v1_applied only after config/plugin writes succeed, before pretest seeding', async () => {
    const { kv, setMock } = makeKv();
    const { db } = makeDb();
    const { llm } = makeLlm();
    const svc = new StrategyBootstrapService(db, kv, llm);

    await svc.run();

    const keysInOrder = setMock.mock.calls.map((c: unknown[]) => c[0] as string);
    const momentumIdx = keysInOrder.indexOf(BOOTSTRAP_APPLIED_KEY);
    const universeIdx = keysInOrder.indexOf('cycle.universe');
    const executionIdx = keysInOrder.indexOf('execution.real');
    expect(momentumIdx).toBeGreaterThan(universeIdx);
    expect(momentumIdx).toBeGreaterThan(executionIdx);
    // Pretest seeding is a SEPARATE, independently-gated step that runs after the
    // momentum block — see PRETEST_SEED_KEY decoupling below.
    expect(keysInOrder[keysInOrder.length - 1]).toBe(PRETEST_SEED_KEY);
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
// Bootstrap also seeds 7 virtual pretest portfolios spanning a full risk spectrum
// (Ultra-Conservative → Ultra-Aggressive momentum, plus Trend-only and Relative-Strength
// families) that all trade the same global ETF universe seeded above.
//
// Idempotency is gated by its OWN, INDEPENDENT key (PRETEST_SEED_KEY) — decoupled
// from BOOTSTRAP_APPLIED_KEY (the momentum flag) on purpose: an already-bootstrapped
// instance (operator may have since enabled real-money mode or customized the
// universe/plugins) must be able to receive these 7 portfolios on its next boot
// WITHOUT re-running the momentum/execution/universe/plugin block. See the
// "independent idempotency" describe block below and the module docstring.

describe('StrategyBootstrapService — pretest portfolio seeding', () => {
  it('seeds exactly 11 risk-differentiated pretest portfolios on first run', async () => {
    const { kv } = makeKv();
    const { db, pretestCreate } = makeDb();
    const { llm } = makeLlm();
    const svc = new StrategyBootstrapService(db, kv, llm);

    await svc.run();

    expect(pretestCreate).toHaveBeenCalledTimes(11);
    const names = (pretestCreate.mock.calls as Array<[{ data: { name: string } }]>).map(
      (c) => c[0].data.name,
    );
    expect(names).toEqual(
      expect.arrayContaining([
        'Ultra-Conservador Momentum',
        'Conservador Momentum',
        'Balanceado Momentum',
        'Agresivo Momentum',
        'Ultra-Agresivo Momentum',
        'Trend Puro',
        'Relative-Strength Puro',
      ]),
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

  it('no-ops on a second run (gated by its own PRETEST_SEED_KEY flag)', async () => {
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

  it('PRETEST_PORTFOLIOS_TO_SEED exposes exactly the 11 expected specs', () => {
    expect(PRETEST_PORTFOLIOS_TO_SEED.map((p) => p.name)).toEqual([
      'Ultra-Conservador Momentum',
      'Conservador Momentum',
      'Balanceado Momentum',
      'Agresivo Momentum',
      'Ultra-Agresivo Momentum',
      'Trend Puro',
      'Relative-Strength Puro',
      'Vol-Managed Index',
      'Vol-Managed QQQ',
      'Vol-Managed TECL (Agresivo)',
      'Vol-Managed SOXL (Agresivo)',
    ]);
  });

  it('Vol-Managed Index is wired to risk-manager exposure_mode:vol_target with the batch-6 winner config (tv=12%, w=20d, cap=1.0)', () => {
    const spec = PRETEST_PORTFOLIOS_TO_SEED.find((p) => p.name === 'Vol-Managed Index');
    expect(spec).toBeDefined();
    expect(spec?.plugin_ids).toEqual(['broad-index-hold', 'risk-manager']);
    expect(spec?.plugin_configs['risk-manager']).toEqual({
      exposure_mode: 'vol_target',
      target_vol_pct: 12,
      vol_window_days: 20,
      exposure_cap: 1.0,
      vol_target_benchmark: 'SPY',
    });
  });

  it('Vol-Managed QQQ is wired to risk-manager exposure_mode:vol_target with the batch-9 winner config (tv=15%, w=20d, cap=1.5)', () => {
    const spec = PRETEST_PORTFOLIOS_TO_SEED.find((p) => p.name === 'Vol-Managed QQQ');
    expect(spec).toBeDefined();
    expect(spec?.plugin_ids).toEqual(['broad-index-hold', 'risk-manager']);
    expect(spec?.plugin_configs['broad-index-hold']).toEqual({ symbols: 'QQQ' });
    expect(spec?.plugin_configs['risk-manager']).toEqual({
      exposure_mode: 'vol_target',
      target_vol_pct: 15,
      vol_window_days: 20,
      exposure_cap: 1.5,
      vol_target_benchmark: 'QQQ',
    });
    expect(spec?.plugin_configs['__pretest_policy__']).toEqual({
      sizing_pct: 1.0,
      slippage_pct: 0.0005,
      commission_pct: 0,
    });
  });

  it('Vol-Managed TECL (Agresivo) is wired to risk-manager exposure_mode:vol_target with the batch-11 winner config (tv=20%, w=20d, cap=1.0)', () => {
    const spec = PRETEST_PORTFOLIOS_TO_SEED.find((p) => p.name === 'Vol-Managed TECL (Agresivo)');
    expect(spec).toBeDefined();
    expect(spec?.plugin_ids).toEqual(['broad-index-hold', 'risk-manager']);
    expect(spec?.plugin_configs['broad-index-hold']).toEqual({ symbols: 'TECL' });
    expect(spec?.plugin_configs['risk-manager']).toEqual({
      exposure_mode: 'vol_target',
      target_vol_pct: 20,
      vol_window_days: 20,
      exposure_cap: 1.0,
      vol_target_benchmark: 'TECL',
    });
    expect(spec?.plugin_configs['__pretest_policy__']).toEqual({
      sizing_pct: 1.0,
      slippage_pct: 0.0005,
      commission_pct: 0,
    });
  });

  it('Vol-Managed SOXL (Agresivo) is wired to risk-manager exposure_mode:vol_target with the batch-11 winner config (tv=20%, w=20d, cap=1.0)', () => {
    const spec = PRETEST_PORTFOLIOS_TO_SEED.find((p) => p.name === 'Vol-Managed SOXL (Agresivo)');
    expect(spec).toBeDefined();
    expect(spec?.plugin_ids).toEqual(['broad-index-hold', 'risk-manager']);
    expect(spec?.plugin_configs['broad-index-hold']).toEqual({ symbols: 'SOXL' });
    expect(spec?.plugin_configs['risk-manager']).toEqual({
      exposure_mode: 'vol_target',
      target_vol_pct: 20,
      vol_window_days: 20,
      exposure_cap: 1.0,
      vol_target_benchmark: 'SOXL',
    });
    expect(spec?.plugin_configs['__pretest_policy__']).toEqual({
      sizing_pct: 1.0,
      slippage_pct: 0.0005,
      commission_pct: 0,
    });
  });
});

// ── Independent idempotency: pretest seeding vs. momentum bootstrap ───────────
//
// CRITICAL regression coverage: the momentum block (universe / execution.real /
// plugin activation) must NEVER re-run on an instance where BOOTSTRAP_APPLIED_KEY
// is already 'true' — even when PRETEST_SEED_KEY is unset. Conversely, pretest
// seeding must run whenever PRETEST_SEED_KEY is unset, REGARDLESS of the momentum
// flag's state. Each flag gates only its own block.

describe('StrategyBootstrapService — pretest seeding is decoupled from the momentum flag', () => {
  it('does NOT re-run the momentum block when BOOTSTRAP_APPLIED_KEY is already set, even if PRETEST_SEED_KEY is unset', async () => {
    const { kv, store, setMock } = makeKv({ [BOOTSTRAP_APPLIED_KEY]: 'true' });
    const { db, updateMany, pretestCreate } = makeDb();
    const { llm } = makeLlm();
    const svc = new StrategyBootstrapService(db, kv, llm);

    await svc.run();

    // No plugin activation/deactivation writes — the momentum block was skipped.
    expect(updateMany).not.toHaveBeenCalled();
    // No execution.real or cycle.universe writes either.
    const executionCalls = setMock.mock.calls.filter((c: unknown[]) => c[0] === 'execution.real');
    const universeCalls = setMock.mock.calls.filter((c: unknown[]) => c[0] === 'cycle.universe');
    expect(executionCalls).toHaveLength(0);
    expect(universeCalls).toHaveLength(0);

    // But pretest portfolios STILL get seeded, and PRETEST_SEED_KEY gets set.
    expect(pretestCreate).toHaveBeenCalledTimes(11);
    expect(store[PRETEST_SEED_KEY]).toBe('true');
  });

  it('still seeds pretest portfolios when the momentum flag is unset (fresh instance gets both)', async () => {
    const { kv, store } = makeKv();
    const { db, pretestCreate } = makeDb();
    const { llm } = makeLlm();
    const svc = new StrategyBootstrapService(db, kv, llm);

    await svc.run();

    expect(store[BOOTSTRAP_APPLIED_KEY]).toBe('true');
    expect(store[PRETEST_SEED_KEY]).toBe('true');
    expect(pretestCreate).toHaveBeenCalledTimes(11);
  });

  it('no-ops pretest seeding when PRETEST_SEED_KEY is already set, independently of the momentum flag', async () => {
    const { kv } = makeKv({ [PRETEST_SEED_KEY]: 'true' });
    const { db, pretestCreate, updateMany } = makeDb();
    const { llm } = makeLlm();
    const svc = new StrategyBootstrapService(db, kv, llm);

    await svc.run();

    expect(pretestCreate).not.toHaveBeenCalled();
    // Momentum flag was unset, so that block still runs normally.
    expect(updateMany).toHaveBeenCalled();
  });

  it('both blocks no-op when both flags are already set', async () => {
    const { kv } = makeKv({
      [BOOTSTRAP_APPLIED_KEY]: 'true',
      [PRETEST_SEED_KEY]: 'true',
    });
    const { db, pretestCreate, updateMany } = makeDb();
    const { llm } = makeLlm();
    const svc = new StrategyBootstrapService(db, kv, llm);

    await svc.run();

    expect(pretestCreate).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });
});

// ── LLM config from env (provider-agnostic) ───────────────────────────────────
//
// Runs on EVERY boot (no version flag) — env is the deployment source of truth
// for backend/model. Provider-agnostic: works for gemini, anthropic, or any
// other backend the operator sets via LLM_BACKEND/LLM_MODEL. Never reads or
// logs any API key — that stays the operator's concern at call time.

describe('StrategyBootstrapService — LLM config from env', () => {
  const ORIGINAL_BACKEND = process.env.LLM_BACKEND;
  const ORIGINAL_MODEL = process.env.LLM_MODEL;

  afterEach(() => {
    if (ORIGINAL_BACKEND === undefined) {
      delete process.env.LLM_BACKEND;
    } else {
      process.env.LLM_BACKEND = ORIGINAL_BACKEND;
    }
    if (ORIGINAL_MODEL === undefined) {
      delete process.env.LLM_MODEL;
    } else {
      process.env.LLM_MODEL = ORIGINAL_MODEL;
    }
  });

  it.each([
    { backend: 'gemini', model: 'gemini-3.5-flash' },
    { backend: 'anthropic', model: 'claude-x' },
  ])(
    'applies env config ($backend/$model) when it differs from the current live config',
    async ({ backend, model }) => {
      process.env.LLM_BACKEND = backend;
      process.env.LLM_MODEL = model;
      const { kv } = makeKv();
      const { db } = makeDb();
      const { llm, patchConfig } = makeLlm({
        currentBackend: 'anthropic',
        currentModel: 'claude-haiku-4-5-20251001',
      });
      const svc = new StrategyBootstrapService(db, kv, llm);

      await svc.run();

      expect(patchConfig).toHaveBeenCalledWith({ backend, model });
    },
  );

  it('is a no-op when the current live config already matches env', async () => {
    process.env.LLM_BACKEND = 'gemini';
    process.env.LLM_MODEL = 'gemini-3.5-flash';
    const { kv } = makeKv();
    const { db } = makeDb();
    const { llm, patchConfig } = makeLlm({
      currentBackend: 'gemini',
      currentModel: 'gemini-3.5-flash',
    });
    const svc = new StrategyBootstrapService(db, kv, llm);

    await svc.run();

    expect(patchConfig).not.toHaveBeenCalled();
  });

  it('skips (no patchConfig) when LLM_BACKEND is unset', async () => {
    delete process.env.LLM_BACKEND;
    process.env.LLM_MODEL = 'gemini-3.5-flash';
    const { kv } = makeKv();
    const { db } = makeDb();
    const { llm, patchConfig } = makeLlm();
    const svc = new StrategyBootstrapService(db, kv, llm);

    await svc.run();

    expect(patchConfig).not.toHaveBeenCalled();
  });

  it('skips (no patchConfig) when LLM_MODEL is unset', async () => {
    process.env.LLM_BACKEND = 'gemini';
    delete process.env.LLM_MODEL;
    const { kv } = makeKv();
    const { db } = makeDb();
    const { llm, patchConfig } = makeLlm();
    const svc = new StrategyBootstrapService(db, kv, llm);

    await svc.run();

    expect(patchConfig).not.toHaveBeenCalled();
  });

  it('skips (no patchConfig) when LLM_BACKEND/LLM_MODEL are blank/whitespace', async () => {
    process.env.LLM_BACKEND = '   ';
    process.env.LLM_MODEL = 'gemini-3.5-flash';
    const { kv } = makeKv();
    const { db } = makeDb();
    const { llm, patchConfig } = makeLlm();
    const svc = new StrategyBootstrapService(db, kv, llm);

    await svc.run();

    expect(patchConfig).not.toHaveBeenCalled();
  });

  it('re-applies on every boot (no version flag) as long as env differs from live config', async () => {
    process.env.LLM_BACKEND = 'gemini';
    process.env.LLM_MODEL = 'gemini-3.5-flash';
    const { kv } = makeKv();
    const { db } = makeDb();
    const { llm, patchConfig } = makeLlm({
      currentBackend: 'anthropic',
      currentModel: 'claude-haiku-4-5-20251001',
    });
    const svc = new StrategyBootstrapService(db, kv, llm);

    await svc.run();
    await svc.run();

    expect(patchConfig).toHaveBeenCalledTimes(2);
  });

  it('is fail-soft when patchConfig throws (never propagates)', async () => {
    process.env.LLM_BACKEND = 'gemini';
    process.env.LLM_MODEL = 'gemini-3.5-flash';
    const { kv, store } = makeKv();
    const { db } = makeDb();
    const { llm } = makeLlm({
      throwOnPatch: true,
      currentBackend: 'anthropic',
      currentModel: 'claude-haiku-4-5-20251001',
    });
    const svc = new StrategyBootstrapService(db, kv, llm);

    await expect(svc.run()).resolves.not.toThrow();
    expect(store[BOOTSTRAP_APPLIED_KEY]).toBe('true');
  });

  it('the momentum bootstrap still runs independently of the LLM env step', async () => {
    process.env.LLM_BACKEND = 'gemini';
    process.env.LLM_MODEL = 'gemini-3.5-flash';
    const { kv, store } = makeKv();
    const { db } = makeDb();
    const { llm } = makeLlm({
      currentBackend: 'anthropic',
      currentModel: 'claude-haiku-4-5-20251001',
    });
    const svc = new StrategyBootstrapService(db, kv, llm);

    await svc.run();

    expect(store[BOOTSTRAP_APPLIED_KEY]).toBe('true');
    expect(store['cycle.universe']).toBe(MOMENTUM_UNIVERSE);
  });

  it('never logs any env value that could be a secret-bearing field name', async () => {
    process.env.LLM_BACKEND = 'gemini';
    process.env.LLM_MODEL = 'gemini-3.5-flash';
    const { kv } = makeKv();
    const { db } = makeDb();
    const { llm } = makeLlm({
      currentBackend: 'anthropic',
      currentModel: 'claude-haiku-4-5-20251001',
    });
    const svc = new StrategyBootstrapService(db, kv, llm);
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    await svc.run();

    for (const call of logSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toMatch(/api[_-]?key/i);
    }
    logSpy.mockRestore();
  });
});
