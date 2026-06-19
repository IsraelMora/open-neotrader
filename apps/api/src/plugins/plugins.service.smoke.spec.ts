/**
 * plugins.service.smoke.spec.ts — F3-s2 TDD: smoke test + activate integration
 *
 * Tests (tasks 3.3–3.10):
 *   3.3  activate stores smoke_test_result (passed result)
 *   3.4  activate STILL succeeds even if smoke result='failed' (NEVER blocks)
 *   3.5  smokeTestPlugin throws → activate still succeeds, smoke_test_result null
 *   3.6  smoke runs BEFORE db.update({active:true}) (ordering)
 *   3.9  getTrustReport returns {scan_result, smoke_test_result} (both parsed)
 */
import { PluginsService } from './plugins.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { PluginEventsService } from './plugin-events.service';
import type { ConfigService } from '@nestjs/config';
import type { SandboxGateway } from '../sandbox/sandbox.gateway';

// Mock child_process (git, etc.)
jest.mock('child_process', () => ({
  execFile: jest.fn((_cmd: string, _args: string[], cb: (...args: unknown[]) => void) => {
    cb(null, '', '');
  }),
  spawn: jest.fn(),
}));

// Mock fs so readManifest / existsSync do not hit disk
jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: jest.fn().mockReturnValue(false),
    mkdirSync: jest.fn(),
    readFileSync: jest.fn(actual.readFileSync),
    writeFileSync: actual.writeFileSync,
  };
});

// Mock manifest module
jest.mock('./manifest', () => ({
  readManifest: jest.fn().mockReturnValue(null),
  validateManifest: jest.fn().mockReturnValue([]),
  scanLocalManifests: jest.fn().mockReturnValue([]),
}));

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const FAKE_SMOKE_PASSED = {
  ok: true,
  result: 'passed',
  checks: [
    { name: 'manifest', status: 'passed', detail: 'ok' },
    { name: 'on_activate', status: 'passed', detail: 'no hook' },
  ],
};

const FAKE_SMOKE_FAILED = {
  ok: true,
  result: 'failed',
  checks: [
    { name: 'manifest', status: 'passed', detail: 'ok' },
    { name: 'my-plugin.my_fn', status: 'failed', detail: 'fn not defined' },
  ],
};

const FAKE_SCAN_RESULT = {
  ok: true,
  findings: [],
  summary: { warn_count: 0 },
};

function makePlugin(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    description: null as string | null,
    version: '1.0.0',
    type: 'skill',
    active: false,
    verification: 'unverified',
    author: null as string | null,
    source_url: null as string | null,
    git_url: null as string | null,
    stack_plugins: null as string | null,
    skills: null as string | null,
    symbols: null as string | null,
    config: null as string | null,
    installed_path: `/plugins/${id}` as string | null,
    scan_result: JSON.stringify(FAKE_SCAN_RESULT) as string | null,
    smoke_test_result: null as string | null,
    installed_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeDb(plugin: ReturnType<typeof makePlugin>) {
  return {
    plugin: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(plugin),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(plugin),
      update: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ ...plugin, ...data }),
        ),
      delete: jest.fn(),
    },
  } as unknown as PrismaService;
}

function makeService(
  db: PrismaService,
  sandbox: jest.Mocked<Pick<SandboxGateway, 'smokeTestPlugin' | 'analyzePlugin'>>,
): PluginsService {
  const events = { emit: jest.fn() } as unknown as PluginEventsService;
  const cfg = {
    get: jest.fn().mockReturnValue('/var/plugins'),
  } as unknown as ConfigService;

  return new PluginsService(
    db,
    events,
    cfg,
    undefined,
    undefined,
    sandbox as unknown as SandboxGateway,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PluginsService.activate — smoke test integration (F3-s2)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('f3s2-3.3 — activate stores smoke_test_result as JSON when smoke returns passed', async () => {
    const plugin = makePlugin('test-plugin');
    const db = makeDb(plugin);
    const sandbox = {
      smokeTestPlugin: jest.fn().mockResolvedValue({ ok: true, result: FAKE_SMOKE_PASSED }),
      analyzePlugin: jest.fn(),
    };

    const service = makeService(db, sandbox);
    await service.activate('test-plugin');

    expect(sandbox.smokeTestPlugin).toHaveBeenCalledWith('test-plugin');

    // db.update must have been called with smoke_test_result as a JSON string
    const updateCalls = (db.plugin.update as jest.Mock).mock.calls as Array<
      [{ where: { id: string }; data: Record<string, unknown> }]
    >;
    const smokeUpdateCall = updateCalls.find(([args]) => 'smoke_test_result' in args.data);
    expect(smokeUpdateCall).toBeDefined();
    const smokeJson = smokeUpdateCall![0].data['smoke_test_result'] as string;
    expect(typeof smokeJson).toBe('string');
    const parsed = JSON.parse(smokeJson) as typeof FAKE_SMOKE_PASSED;
    expect(parsed.result).toBe('passed');
  });

  it("f3s2-3.4 — activate STILL sets active=true even when smoke result='failed' (never blocks)", async () => {
    const plugin = makePlugin('failed-smoke-plugin');
    const db = makeDb(plugin);
    const sandbox = {
      smokeTestPlugin: jest.fn().mockResolvedValue({ ok: true, result: FAKE_SMOKE_FAILED }),
      analyzePlugin: jest.fn(),
    };

    const service = makeService(db, sandbox);

    // Must NOT throw
    await expect(service.activate('failed-smoke-plugin')).resolves.toBeDefined();

    // active=true must be set
    const updateCalls = (db.plugin.update as jest.Mock).mock.calls as Array<
      [{ where: { id: string }; data: Record<string, unknown> }]
    >;
    const activeUpdateCall = updateCalls.find(([args]) => args.data['active'] === true);
    expect(activeUpdateCall).toBeDefined();

    // smoke_test_result must store the failed JSON
    const smokeUpdateCall = updateCalls.find(([args]) => 'smoke_test_result' in args.data);
    expect(smokeUpdateCall).toBeDefined();
    const smokeJson = smokeUpdateCall![0].data['smoke_test_result'] as string;
    const parsed = JSON.parse(smokeJson) as typeof FAKE_SMOKE_FAILED;
    expect(parsed.result).toBe('failed');
  });

  it('f3s2-3.5 — smokeTestPlugin throws → activate STILL succeeds (active=true), smoke_test_result null, no rethrow', async () => {
    const plugin = makePlugin('throw-plugin');
    const db = makeDb(plugin);
    const sandbox = {
      smokeTestPlugin: jest.fn().mockRejectedValue(new Error('sandbox crashed')),
      analyzePlugin: jest.fn(),
    };

    const service = makeService(db, sandbox);

    // Must NOT throw
    await expect(service.activate('throw-plugin')).resolves.toBeDefined();

    // active=true must still be set
    const updateCalls = (db.plugin.update as jest.Mock).mock.calls as Array<
      [{ where: { id: string }; data: Record<string, unknown> }]
    >;
    const activeUpdateCall = updateCalls.find(([args]) => args.data['active'] === true);
    expect(activeUpdateCall).toBeDefined();

    // smoke_test_result update must NOT have been called (stays null from catch branch)
    const smokeUpdateCall = updateCalls.find(([args]) => 'smoke_test_result' in args.data);
    expect(smokeUpdateCall).toBeUndefined();
  });

  it('f3s2-3.6 — smokeTestPlugin is called BEFORE db.update({active:true}) (ordering)', async () => {
    const plugin = makePlugin('order-plugin');
    const db = makeDb(plugin);
    const sandbox = {
      smokeTestPlugin: jest.fn().mockResolvedValue({ ok: true, result: FAKE_SMOKE_PASSED }),
      analyzePlugin: jest.fn(),
    };

    const service = makeService(db, sandbox);
    const callOrder: string[] = [];

    sandbox.smokeTestPlugin.mockImplementation(() => {
      callOrder.push('smoke');
      return Promise.resolve({ ok: true, result: FAKE_SMOKE_PASSED });
    });

    (db.plugin.update as jest.Mock).mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => {
        if (data['active'] === true) {
          callOrder.push('active=true');
        } else if ('smoke_test_result' in data) {
          callOrder.push('smoke_result_store');
        }
        return Promise.resolve({ ...plugin, ...data });
      },
    );

    await service.activate('order-plugin');

    // smoke must appear before active=true
    const smokeIdx = callOrder.indexOf('smoke');
    const activeIdx = callOrder.indexOf('active=true');
    expect(smokeIdx).toBeGreaterThanOrEqual(0);
    expect(activeIdx).toBeGreaterThanOrEqual(0);
    expect(smokeIdx).toBeLessThan(activeIdx);
  });
});

describe('PluginsService.getTrustReport (F3-s2 AC-7)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('f3s2-3.9a — returns both scan_result and smoke_test_result (both parsed)', async () => {
    const smokeData = { ok: true, result: 'passed', checks: [] };
    const plugin = makePlugin('trust-plugin', {
      scan_result: JSON.stringify(FAKE_SCAN_RESULT),
      smoke_test_result: JSON.stringify(smokeData),
    });
    const db = makeDb(plugin);
    const sandbox = {
      smokeTestPlugin: jest.fn(),
      analyzePlugin: jest.fn(),
    };
    const service = makeService(db, sandbox);

    const report = await service.getTrustReport('trust-plugin');

    expect(report).toHaveProperty('scan_result');
    expect(report).toHaveProperty('smoke_test_result');
    expect(report.scan_result).toEqual(FAKE_SCAN_RESULT);
    expect(report.smoke_test_result).toEqual(smokeData);
  });

  it('f3s2-3.9b — smoke_test_result is null when column is null (not yet smoke-tested)', async () => {
    const plugin = makePlugin('not-smoked', { smoke_test_result: null });
    const db = makeDb(plugin);
    const sandbox = {
      smokeTestPlugin: jest.fn(),
      analyzePlugin: jest.fn(),
    };
    const service = makeService(db, sandbox);

    const report = await service.getTrustReport('not-smoked');

    expect(report.smoke_test_result).toBeNull();
  });

  it('f3s2-3.9c — scan_result is null when column is null', async () => {
    const plugin = makePlugin('not-scanned', { scan_result: null });
    const db = makeDb(plugin);
    const sandbox = {
      smokeTestPlugin: jest.fn(),
      analyzePlugin: jest.fn(),
    };
    const service = makeService(db, sandbox);

    const report = await service.getTrustReport('not-scanned');

    expect(report.scan_result).toBeNull();
  });
});
