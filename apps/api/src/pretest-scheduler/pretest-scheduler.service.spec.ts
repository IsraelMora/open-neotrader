import { PretestSchedulerService } from './pretest-scheduler.service';
import type { KvService } from '../common/kv.service';
import type { PretestService } from '../pretest/pretest.service';

function makeKv(
  kvData: Record<string, string | null> = {},
): jest.Mocked<Pick<KvService, 'get' | 'set' | 'delete'>> {
  return {
    get: jest.fn().mockImplementation((key: string) => Promise.resolve(kvData[key] ?? null)),
    set: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  };
}

function makePretest(
  impl?: () => Promise<Array<{ id: string; name: string; ok: boolean; error?: string }>>,
): jest.Mocked<Pick<PretestService, 'runAllActive'>> {
  return {
    runAllActive: impl
      ? jest.fn(impl)
      : jest.fn().mockResolvedValue([{ id: 'p1', name: 'P1', ok: true }]),
  };
}

function makeService(
  kv: ReturnType<typeof makeKv>,
  pretest: ReturnType<typeof makePretest>,
): PretestSchedulerService {
  return new PretestSchedulerService(
    kv as unknown as KvService,
    pretest as unknown as PretestService,
  );
}

/** Invokes the private tick() method directly (no real timers). */
async function callTick(service: PretestSchedulerService): Promise<void> {
  return (service as unknown as { tick: () => Promise<void> }).tick();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PretestSchedulerService — interval + defaults', () => {
  it('runs pretest.runAllActive() when the configured interval has elapsed', async () => {
    const kv = makeKv({ 'pretest.scheduler_interval_ms': '60000' });
    const pretest = makePretest();
    const service = makeService(kv, pretest);

    // Force lastRunAt into the past so the first tick is due.
    (service as unknown as { lastRunAt: number | null }).lastRunAt = Date.now() - 61_000;

    await callTick(service);

    expect(pretest.runAllActive).toHaveBeenCalledTimes(1);
  });

  it('defaults to a 60-minute interval when KV is unset', async () => {
    const kv = makeKv();
    const pretest = makePretest();
    const service = makeService(kv, pretest);

    (service as unknown as { lastRunAt: number | null }).lastRunAt = Date.now() - 1000;

    await callTick(service);

    // 1000ms elapsed is nowhere near the 60-min default → must NOT run yet.
    expect(pretest.runAllActive).not.toHaveBeenCalled();
  });

  it('does NOT run before the interval has elapsed', async () => {
    const kv = makeKv({ 'pretest.scheduler_interval_ms': '60000' });
    const pretest = makePretest();
    const service = makeService(kv, pretest);

    (service as unknown as { lastRunAt: number | null }).lastRunAt = Date.now();

    await callTick(service);

    expect(pretest.runAllActive).not.toHaveBeenCalled();
  });

  it('interval <= 0 disables the scheduler entirely', async () => {
    const kv = makeKv({ 'pretest.scheduler_interval_ms': '0' });
    const pretest = makePretest();
    const service = makeService(kv, pretest);

    (service as unknown as { lastRunAt: number | null }).lastRunAt = Date.now() - 10 * 3600_000;

    await callTick(service);

    expect(pretest.runAllActive).not.toHaveBeenCalled();
  });

  it('a negative interval also disables the scheduler', async () => {
    const kv = makeKv({ 'pretest.scheduler_interval_ms': '-5' });
    const pretest = makePretest();
    const service = makeService(kv, pretest);

    (service as unknown as { lastRunAt: number | null }).lastRunAt = Date.now() - 10 * 3600_000;

    await callTick(service);

    expect(pretest.runAllActive).not.toHaveBeenCalled();
  });
});

describe('PretestSchedulerService — overlap guard', () => {
  it('skips a tick while a previous run is still in flight', async () => {
    const kv = makeKv({ 'pretest.scheduler_interval_ms': '60000' });
    let resolveRun!: () => void;
    const inFlight = new Promise<Array<{ id: string; name: string; ok: boolean }>>((resolve) => {
      resolveRun = () => resolve([{ id: 'p1', name: 'P1', ok: true }]);
    });
    const pretest = makePretest(() => inFlight);
    const service = makeService(kv, pretest);
    (service as unknown as { lastRunAt: number | null }).lastRunAt = Date.now() - 61_000;

    const firstTick = callTick(service);
    // Second tick arrives while the first is still awaiting runAllActive.
    await callTick(service);

    expect(pretest.runAllActive).toHaveBeenCalledTimes(1);

    resolveRun();
    await firstTick;
  });

  it('the running flag is released after completion, allowing a later tick to run again', async () => {
    const kv = makeKv({ 'pretest.scheduler_interval_ms': '60000' });
    const pretest = makePretest();
    const service = makeService(kv, pretest);
    (service as unknown as { lastRunAt: number | null }).lastRunAt = Date.now() - 61_000;

    await callTick(service);
    expect(pretest.runAllActive).toHaveBeenCalledTimes(1);

    (service as unknown as { lastRunAt: number | null }).lastRunAt = Date.now() - 61_000;
    await callTick(service);
    expect(pretest.runAllActive).toHaveBeenCalledTimes(2);
  });
});

describe('PretestSchedulerService — fail-soft', () => {
  it('never throws out of tick() when runAllActive rejects, and releases the running flag', async () => {
    const kv = makeKv({ 'pretest.scheduler_interval_ms': '60000' });
    const pretest = makePretest(() => Promise.reject(new Error('boom')));
    const service = makeService(kv, pretest);
    (service as unknown as { lastRunAt: number | null }).lastRunAt = Date.now() - 61_000;

    await expect(callTick(service)).resolves.not.toThrow();

    // Running flag must have been released — a subsequent due tick can run again.
    (service as unknown as { lastRunAt: number | null }).lastRunAt = Date.now() - 61_000;
    const pretest2 = makePretest();
    (service as unknown as { pretest: unknown }).pretest = pretest2;
    await callTick(service);
    expect(pretest2.runAllActive).toHaveBeenCalledTimes(1);
  });

  it('never throws out of tick() when the KV read rejects', async () => {
    const kv = {
      get: jest.fn().mockRejectedValue(new Error('kv down')),
      set: jest.fn(),
      delete: jest.fn(),
    } as unknown as KvService;
    const pretest = makePretest();
    const service = makeService(kv as unknown as ReturnType<typeof makeKv>, pretest);

    await expect(callTick(service)).resolves.not.toThrow();
    expect(pretest.runAllActive).not.toHaveBeenCalled();
  });
});

describe('PretestSchedulerService — lifecycle', () => {
  it('onModuleInit does NOT run immediately — first run happens one interval later', () => {
    jest.useFakeTimers();
    try {
      const kv = makeKv({ 'pretest.scheduler_interval_ms': '60000' });
      const pretest = makePretest();
      const service = makeService(kv, pretest);

      service.onModuleInit();

      expect(pretest.runAllActive).not.toHaveBeenCalled();
      service.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('onModuleDestroy clears the interval timer', () => {
    jest.useFakeTimers();
    try {
      const clearSpy = jest.spyOn(global, 'clearInterval');
      const kv = makeKv();
      const pretest = makePretest();
      const service = makeService(kv, pretest);

      service.onModuleInit();
      service.onModuleDestroy();

      expect(clearSpy).toHaveBeenCalled();
      clearSpy.mockRestore();
    } finally {
      jest.useRealTimers();
    }
  });
});
