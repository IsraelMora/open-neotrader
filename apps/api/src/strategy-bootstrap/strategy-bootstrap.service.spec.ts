import {
  StrategyBootstrapService,
  MOMENTUM_UNIVERSE,
  PLUGINS_TO_ACTIVATE,
  PLUGINS_TO_DEACTIVATE,
  BOOTSTRAP_APPLIED_KEY,
} from './strategy-bootstrap.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { KvService } from '../common/kv.service';

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

function makeDb(
  missingIds: string[] = [],
  throwingIds: string[] = [],
): {
  db: PrismaService;
  updateMany: jest.Mock;
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
  return { db: { plugin: { updateMany } } as unknown as PrismaService, updateMany };
}

describe('StrategyBootstrapService', () => {
  it('applies the bootstrap once, then no-ops on a second run (idempotency guard)', async () => {
    const { kv, store } = makeKv();
    const { db, updateMany } = makeDb();
    const svc = new StrategyBootstrapService(db, kv);

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
    const svc = new StrategyBootstrapService(db, kv);

    await svc.run();

    expect(store['cycle.universe']).toBe(MOMENTUM_UNIVERSE);
  });

  it('activates the momentum stack plugins and deactivates the noisy/buggy ones', async () => {
    const { kv } = makeKv();
    const { db, updateMany } = makeDb();
    const svc = new StrategyBootstrapService(db, kv);

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
    const svc = new StrategyBootstrapService(db, kv);

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
    const svc = new StrategyBootstrapService(db, kv);

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
    const svc = new StrategyBootstrapService(db, kv);

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
    const svc = new StrategyBootstrapService(db, kv);

    await svc.run();

    const keysInOrder = setMock.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(keysInOrder[keysInOrder.length - 1]).toBe(BOOTSTRAP_APPLIED_KEY);
  });

  it('is fail-soft when a plugin row is missing: continues and still completes the bootstrap', async () => {
    const { kv, store } = makeKv();
    const { db } = makeDb(['momentum-factor-12-1']);
    const svc = new StrategyBootstrapService(db, kv);

    await expect(svc.run()).resolves.not.toThrow();
    expect(store[BOOTSTRAP_APPLIED_KEY]).toBe('true');
    expect(store['cycle.universe']).toBe(MOMENTUM_UNIVERSE);
  });

  it('is fail-soft when a plugin update throws (DB error): continues with the rest', async () => {
    const { kv, store } = makeKv();
    const { db, updateMany } = makeDb([], ['trend-following']);
    const svc = new StrategyBootstrapService(db, kv);

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
    const svc = new StrategyBootstrapService(db, kv);

    await expect(svc.onModuleInit()).resolves.not.toThrow();
  });
});
