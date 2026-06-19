import { CycleSchedulerService } from './cycle-scheduler.service';
import type { KvService } from '../common/kv.service';
import type { PanelService } from '../panel/panel.service';
import type { PluginsService } from '../plugins/plugins.service';

// ── Stubs ─────────────────────────────────────────────────────────────────────

function makeKv(
  kvData: Record<string, string | null> = {},
): jest.Mocked<Pick<KvService, 'get' | 'set' | 'delete'>> {
  return {
    get: jest.fn().mockImplementation((key: string) => Promise.resolve(kvData[key] ?? null)),
    set: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  };
}

function makePanel(opts: {
  running?: boolean;
  reflectNowResult?: Record<string, unknown>;
  reflectNowThrows?: boolean;
}): jest.Mocked<Pick<PanelService, 'getRunStatus' | 'runCycle' | 'reflectNow'>> {
  const running = opts.running ?? false;
  return {
    getRunStatus: jest.fn().mockReturnValue({ running, last: null }),
    runCycle: jest.fn().mockReturnValue({ accepted: true, message: 'ok' }),
    reflectNow: opts.reflectNowThrows
      ? jest.fn().mockRejectedValue(new Error('reflection error'))
      : jest
          .fn()
          .mockResolvedValue(
            opts.reflectNowResult ?? { skipped: false, cycle_id: 'reflect-001', skills_written: 0 },
          ),
  };
}

function makePlugins(): jest.Mocked<Pick<PluginsService, 'findActive' | 'getManifest'>> {
  return {
    findActive: jest.fn().mockResolvedValue([]),
    getManifest: jest.fn().mockReturnValue({}),
  };
}

/**
 * Build a CycleSchedulerService and call _maybeReflect directly.
 */
async function callMaybeReflect(service: CycleSchedulerService): Promise<void> {
  return (
    service as unknown as {
      _maybeReflect: () => Promise<void>;
    }
  )._maybeReflect();
}

function makeSchedulerService(
  kv: ReturnType<typeof makeKv>,
  panel: ReturnType<typeof makePanel>,
): CycleSchedulerService {
  return new CycleSchedulerService(
    kv as unknown as KvService,
    panel as unknown as PanelService,
    makePlugins() as unknown as PluginsService,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('F4-S2 Phase 3.1 — CycleSchedulerService._maybeReflect cadence', () => {
  it('3.1a — every_n_cycles=0 → reflectNow never called regardless of counter', async () => {
    const kv = makeKv({
      reflection: JSON.stringify({ every_n_cycles: 0 }),
      'reflection.cycle_counter': '5',
    });
    const panel = makePanel({});
    const service = makeSchedulerService(kv, panel);

    await callMaybeReflect(service);

    expect(panel.reflectNow).not.toHaveBeenCalled();
    // counter must NOT be incremented when disabled
    expect(kv.set).not.toHaveBeenCalledWith('reflection.cycle_counter', expect.any(String));
  });

  it('3.1b — every_n_cycles=3, counter at 2 → counter becomes 3, reflectNow called, counter reset to 0', async () => {
    const kv = makeKv({
      reflection: JSON.stringify({ every_n_cycles: 3 }),
      'reflection.cycle_counter': '2',
    });
    const panel = makePanel({});
    const service = makeSchedulerService(kv, panel);

    await callMaybeReflect(service);

    // reflectNow must have been called
    expect(panel.reflectNow).toHaveBeenCalledTimes(1);
    // counter reset to '0'
    expect(kv.set).toHaveBeenCalledWith('reflection.cycle_counter', '0');
  });

  it('3.1c — every_n_cycles=3, counter at 1 → counter incremented to 2, no reflection call', async () => {
    const kv = makeKv({
      reflection: JSON.stringify({ every_n_cycles: 3 }),
      'reflection.cycle_counter': '1',
    });
    const panel = makePanel({});
    const service = makeSchedulerService(kv, panel);

    await callMaybeReflect(service);

    expect(panel.reflectNow).not.toHaveBeenCalled();
    // counter advanced to '2'
    expect(kv.set).toHaveBeenCalledWith('reflection.cycle_counter', '2');
  });

  it('3.1d — panel.getRunStatus().running===true → skip, counter NOT incremented', async () => {
    const kv = makeKv({
      reflection: JSON.stringify({ every_n_cycles: 3 }),
      'reflection.cycle_counter': '2',
    });
    const panel = makePanel({ running: true });
    const service = makeSchedulerService(kv, panel);

    await callMaybeReflect(service);

    expect(panel.reflectNow).not.toHaveBeenCalled();
    // Counter must NOT be updated when cycle is running
    expect(kv.set).not.toHaveBeenCalled();
  });

  it('3.1e — every_n_cycles absent in KV → defaults to 10; at counter 9 (incremented to 10) → fires', async () => {
    const kv = makeKv({
      // No 'reflection' key — should default to 10
      'reflection.cycle_counter': '9',
    });
    const panel = makePanel({});
    const service = makeSchedulerService(kv, panel);

    await callMaybeReflect(service);

    // counter 9 → 10 → fires (10 >= 10)
    expect(panel.reflectNow).toHaveBeenCalledTimes(1);
    expect(kv.set).toHaveBeenCalledWith('reflection.cycle_counter', '0');
  });
});

describe('F4-S2 Fix #3 — _maybeReflect counter reset only on reflectNow success', () => {
  it('3.1f — reflectNow throws → counter NOT reset to 0 (still at threshold value)', async () => {
    const kv = makeKv({
      reflection: JSON.stringify({ every_n_cycles: 3 }),
      'reflection.cycle_counter': '2',
    });
    const panel = makePanel({ reflectNowThrows: true });
    const service = makeSchedulerService(kv, panel);

    // Should not throw (error is caught + logged)
    await callMaybeReflect(service);

    // reflectNow was called
    expect(panel.reflectNow).toHaveBeenCalledTimes(1);
    // Counter must NOT have been reset to '0'
    expect(kv.set).not.toHaveBeenCalledWith('reflection.cycle_counter', '0');
  });

  it('3.1g — reflectNow succeeds → counter IS reset to 0', async () => {
    const kv = makeKv({
      reflection: JSON.stringify({ every_n_cycles: 3 }),
      'reflection.cycle_counter': '2',
    });
    const panel = makePanel({});
    const service = makeSchedulerService(kv, panel);

    await callMaybeReflect(service);

    expect(panel.reflectNow).toHaveBeenCalledTimes(1);
    expect(kv.set).toHaveBeenCalledWith('reflection.cycle_counter', '0');
  });
});
