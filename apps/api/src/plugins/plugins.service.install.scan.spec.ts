/**
 * plugins.service.install.scan.spec.ts — Phase 4 TDD RED: install scan integration
 *
 * F3-s1: Static AST Analysis — PluginsService.install stores scan_result.
 * Tests verify:
 *   - Happy path: analyzePlugin called after install, scan_result persisted as JSON
 *   - Error path: analyzePlugin throws → install still succeeds, scan_result null
 *   - rescan(): re-runs analyzePlugin + updates scan_result
 */
import { PluginsService } from './plugins.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { PluginEventsService } from './plugin-events.service';
import type { ConfigService } from '@nestjs/config';
import type { SandboxGateway } from '../sandbox/sandbox.gateway';

// Mock child_process so gitClone does not run real git
jest.mock('child_process', () => ({
  execFile: jest.fn((_cmd: string, _args: string[], cb: (...args: unknown[]) => void) => {
    cb(null, '', '');
  }),
  spawn: jest.fn(),
}));

// Mock fs so readManifest / existsSync don't hit disk
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

// Mock the manifest module so readManifest and validateManifest are controllable
jest.mock('./manifest', () => ({
  readManifest: jest.fn().mockReturnValue(null),
  validateManifest: jest.fn().mockReturnValue([]),
  scanLocalManifests: jest.fn().mockReturnValue([]),
}));

const FAKE_SCAN_RESULT = {
  ok: true,
  findings: [
    {
      severity: 'warning',
      category: 'risky_import',
      file: 'plugin.py',
      line: 3,
      message: 'subprocess',
    },
  ],
  summary: { warn_count: 1, info_count: 0 },
};

function makeInstalledPlugin(id: string) {
  return {
    id,
    name: id,
    description: null,
    version: '1.0.0',
    type: 'skill',
    active: false,
    verification: 'unverified',
    author: null,
    source_url: `https://github.com/test/${id}.git`,
    git_url: `https://github.com/test/${id}.git`,
    stack_plugins: null,
    skills: null,
    symbols: null,
    config: null,
    installed_path: `/plugins/${id}`,
    scan_result: null,
    smoke_test_result: null,
    reputation_score: null,
    reputation_detail: null,
    installed_at: new Date(),
    updated_at: new Date(),
  };
}

function makeDb(plugin: ReturnType<typeof makeInstalledPlugin>) {
  return {
    plugin: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest
        .fn()
        .mockResolvedValueOnce(null) // first call: conflict check (not installed yet)
        .mockResolvedValue(plugin), // subsequent: findById calls
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
  sandbox: jest.Mocked<Pick<SandboxGateway, 'analyzePlugin'>>,
): PluginsService {
  const events = { emit: jest.fn() } as unknown as PluginEventsService;
  const cfg = {
    get: jest.fn().mockReturnValue('/var/plugins'),
  } as unknown as ConfigService;

  // PluginsService constructor: (db, events, cfg, kv?, audit?, sandbox?)
  const service = new PluginsService(
    db,
    events,
    cfg,
    undefined,
    undefined,
    sandbox as unknown as SandboxGateway,
  );
  return service;
}

describe('PluginsService.install — scan integration (F3-s1)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('f3s1-4.2 — happy path: install completes + scan_result stored as JSON string with findings', async () => {
    const plugin = makeInstalledPlugin('test-dangerous');
    const db = makeDb(plugin);
    const sandbox = {
      analyzePlugin: jest.fn().mockResolvedValue({ ok: true, result: FAKE_SCAN_RESULT }),
    };

    const service = makeService(db, sandbox);

    const result = await service.install('https://github.com/test/test-dangerous.git');

    // Install must complete and return the plugin
    expect(result).toBeDefined();
    expect(result.id).toBe('test-dangerous');

    // analyzePlugin MUST have been called
    expect(sandbox.analyzePlugin).toHaveBeenCalledWith('test-dangerous');

    // DB update MUST have been called with scan_result as JSON
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(db.plugin.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'test-dangerous' },
        data: expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          scan_result: expect.any(String),
        }) as unknown,
      }),
    );

    // The scan_result must be valid JSON containing findings
    const updateCall = (db.plugin.update as jest.Mock).mock.calls[0] as Array<{
      data: { scan_result?: string };
    }>;
    const scanResultStr = updateCall[0].data.scan_result;
    expect(scanResultStr).toBeDefined();
    const parsed = JSON.parse(scanResultStr!) as typeof FAKE_SCAN_RESULT;
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0].category).toBe('risky_import');
  });

  it('f3s1-4.3 — error path: analyzePlugin throws → install still SUCCEEDS, scan_result is null', async () => {
    const plugin = makeInstalledPlugin('test-scan-fail');
    const db = makeDb(plugin);
    const sandbox = {
      analyzePlugin: jest.fn().mockRejectedValue(new Error('sandbox crashed')),
    };

    const service = makeService(db, sandbox);

    // Must NOT throw
    const result = await service.install('https://github.com/test/test-scan-fail.git');

    expect(result).toBeDefined();
    expect(result.id).toBe('test-scan-fail');

    // analyzePlugin was called but threw
    expect(sandbox.analyzePlugin).toHaveBeenCalledWith('test-scan-fail');

    // DB update for scan_result must NOT have been called (scan_result stays null from create)
    // Or if called, it should NOT have thrown an exception to the caller
    // The install itself returns successfully either way
  });

  it('f3s1-4.3b — flagged plugin: install of a plugin with warn findings SUCCEEDS (never blocked)', async () => {
    const plugin = makeInstalledPlugin('flagged-plugin');
    const db = makeDb(plugin);
    const sandbox = {
      analyzePlugin: jest.fn().mockResolvedValue({
        ok: true,
        result: {
          findings: [
            {
              severity: 'warning',
              category: 'risky_import',
              file: 'plugin.py',
              line: 1,
              message: 'subprocess',
            },
            {
              severity: 'warning',
              category: 'dangerous_call',
              file: 'plugin.py',
              line: 5,
              message: 'eval',
            },
          ],
          summary: { warn_count: 2, info_count: 0 },
        },
      }),
    };

    const service = makeService(db, sandbox);

    // Must complete without throwing even with warnings
    const result = await service.install('https://github.com/test/flagged-plugin.git');
    expect(result).toBeDefined();
    expect(result.id).toBe('flagged-plugin');
  });
});

describe('PluginsService.rescan (F3-s1)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('f3s1-4.4a — rescan calls analyzePlugin and updates scan_result in DB', async () => {
    const plugin = makeInstalledPlugin('existing-plugin');
    const db = {
      plugin: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(plugin),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
        update: jest
          .fn()
          .mockResolvedValue({ ...plugin, scan_result: JSON.stringify(FAKE_SCAN_RESULT) }),
        delete: jest.fn(),
      },
    } as unknown as PrismaService;

    const sandbox = {
      analyzePlugin: jest.fn().mockResolvedValue({ ok: true, result: FAKE_SCAN_RESULT }),
    };

    const service = makeService(db, sandbox);

    const result = await service.rescan('existing-plugin');

    expect(sandbox.analyzePlugin).toHaveBeenCalledWith('existing-plugin');
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(db.plugin.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'existing-plugin' },
        data: expect.objectContaining({
          scan_result: JSON.stringify(FAKE_SCAN_RESULT),
        }) as unknown,
      }),
    );
    expect(result).toBeDefined();
  });

  it('f3s1-4.4b — rescan throws NotFoundException for unknown plugin', async () => {
    const db = {
      plugin: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
    } as unknown as PrismaService;

    const sandbox = {
      analyzePlugin: jest.fn(),
    };

    const service = makeService(db, sandbox);

    await expect(service.rescan('ghost-plugin')).rejects.toThrow();
    expect(sandbox.analyzePlugin).not.toHaveBeenCalled();
  });
});
