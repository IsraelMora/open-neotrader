import * as path from 'path';
import { PluginsService } from './plugins.service';
import type { PluginManifest } from './manifest';
import type { PrismaService } from '../prisma/prisma.service';
import type { PluginEventsService } from './plugin-events.service';
import type { ConfigService } from '@nestjs/config';

// Mock fs so readFileSync is interceptable in all tests.
jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    readFileSync: jest.fn(actual.readFileSync),
    writeFileSync: actual.writeFileSync,
    existsSync: actual.existsSync,
    mkdirSync: actual.mkdirSync,
  };
});
import * as fs from 'fs';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal PluginsService with only the dependencies needed for getActiveDecisionPrompt. */
function makeService(
  activePlugins: { id: string; installed_path: string | null }[],
  manifestMap: Record<string, PluginManifest | null>,
): PluginsService {
  const db = {
    plugin: {
      findMany: jest.fn().mockImplementation(({ where }: { where?: { active?: boolean } }) => {
        if (where?.active === true) return Promise.resolve(activePlugins);
        return Promise.resolve([]);
      }),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  } as unknown as PrismaService;

  const events = {
    emit: jest.fn(),
  } as unknown as PluginEventsService;

  const cfg = {
    get: jest.fn().mockReturnValue('/tmp/plugins'),
  } as unknown as ConfigService;

  const service = new PluginsService(db, events, cfg);

  // Override getManifest to use the in-memory map.
  service.getManifest = jest.fn().mockImplementation((installedPath: string | null) => {
    if (!installedPath) return null;
    return manifestMap[installedPath] ?? null;
  });

  return service;
}

function makeManifest(id: string, decisionSection?: PluginManifest['decision']): PluginManifest {
  return {
    plugin: { id, name: id, version: '1.0.0', type: 'extra' },
    decision: decisionSection,
  };
}

// ── Phase 5 Tests — getActiveDecisionPrompt ───────────────────────────────────

describe('PluginsService.getActiveDecisionPrompt', () => {
  beforeEach(() => jest.restoreAllMocks());

  it('returns null when no active plugin declares a [decision] section', async () => {
    const service = makeService(
      [{ id: 'some-plugin', installed_path: '/plugins/some-plugin' }],
      { '/plugins/some-plugin': makeManifest('some-plugin') /* no decision */ },
    );
    const logSpy = jest.spyOn(service['log'], 'error');

    const result = await service.getActiveDecisionPrompt();

    expect(result).toBeNull();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('returns the decision.prompt verbatim when exactly one plugin has [decision]', async () => {
    const prompt = 'Emit tool_calls as JSON inside <tool_calls></tool_calls> tags.';
    const service = makeService(
      [{ id: 'my-decision', installed_path: '/plugins/my-decision' }],
      { '/plugins/my-decision': makeManifest('my-decision', { prompt }) },
    );

    const result = await service.getActiveDecisionPrompt();

    expect(result).toBe(prompt);
  });

  it('reads decision.prompt_file relative to installed_path when prompt is absent', async () => {
    const fileContent = 'Decision instructions from file.';
    const readFileSyncSpy = (fs.readFileSync as jest.Mock).mockReturnValue(fileContent);

    const service = makeService(
      [{ id: 'file-decision', installed_path: '/plugins/file-decision' }],
      {
        '/plugins/file-decision': makeManifest('file-decision', {
          prompt_file: 'DECISION.md',
        }),
      },
    );

    const result = await service.getActiveDecisionPrompt();

    expect(result).toBe(fileContent);
    // Must use path.join(installed_path, basename) — no path traversal.
    expect(readFileSyncSpy).toHaveBeenCalledWith(
      path.join('/plugins/file-decision', 'DECISION.md'),
      'utf8',
    );
    readFileSyncSpy.mockReset();
    (fs.readFileSync as jest.Mock).mockImplementation(jest.requireActual<typeof import('fs')>('fs').readFileSync);
  });

  it('basenames the prompt_file path to prevent traversal', async () => {
    const fileContent = 'Safe content.';
    const readFileSyncSpy = (fs.readFileSync as jest.Mock).mockReturnValue(fileContent);

    const service = makeService(
      [{ id: 'traversal-test', installed_path: '/plugins/traversal-test' }],
      {
        '/plugins/traversal-test': makeManifest('traversal-test', {
          prompt_file: '../../etc/passwd',
        }),
      },
    );

    await service.getActiveDecisionPrompt();

    // Must resolve to basename only: 'passwd' — under installed_path, not /etc/passwd.
    expect(readFileSyncSpy).toHaveBeenCalledWith(
      path.join('/plugins/traversal-test', 'passwd'),
      'utf8',
    );
    readFileSyncSpy.mockReset();
    (fs.readFileSync as jest.Mock).mockImplementation(jest.requireActual<typeof import('fs')>('fs').readFileSync);
  });

  it('prefers prompt over prompt_file when both are present', async () => {
    const prompt = 'Inline prompt wins.';
    const readFileSyncSpy = fs.readFileSync as jest.Mock;

    const service = makeService(
      [{ id: 'both-set', installed_path: '/plugins/both-set' }],
      {
        '/plugins/both-set': makeManifest('both-set', {
          prompt,
          prompt_file: 'DECISION.md',
        }),
      },
    );

    const result = await service.getActiveDecisionPrompt();

    expect(result).toBe(prompt);
    // readFileSync must NOT be called since prompt wins over prompt_file.
    const calls = readFileSyncSpy.mock.calls as unknown[][];
    const relevantCalls = calls.filter(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes('DECISION'),
    );
    expect(relevantCalls).toHaveLength(0);
  });

  it('returns null when prompt_file read throws (never throws)', async () => {
    (fs.readFileSync as jest.Mock).mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const service = makeService(
      [{ id: 'bad-file', installed_path: '/plugins/bad-file' }],
      {
        '/plugins/bad-file': makeManifest('bad-file', { prompt_file: 'MISSING.md' }),
      },
    );

    const result = await service.getActiveDecisionPrompt();
    expect(result).toBeNull();
    // Restore mock for subsequent tests.
    (fs.readFileSync as jest.Mock).mockImplementation(jest.requireActual<typeof import('fs')>('fs').readFileSync);
  });

  it('returns null and logs CRITICAL (as error) when >1 active plugins declare [decision]', async () => {
    const service = makeService(
      [
        { id: 'decision-plugin-a', installed_path: '/plugins/decision-plugin-a' },
        { id: 'decision-plugin-b', installed_path: '/plugins/decision-plugin-b' },
      ],
      {
        '/plugins/decision-plugin-a': makeManifest('decision-plugin-a', {
          prompt: 'Prompt A',
        }),
        '/plugins/decision-plugin-b': makeManifest('decision-plugin-b', {
          prompt: 'Prompt B',
        }),
      },
    );
    const logSpy = jest.spyOn(service['log'], 'error');

    const result = await service.getActiveDecisionPrompt();

    expect(result).toBeNull();
    expect(logSpy).toHaveBeenCalledTimes(1);
    const logMessage: string = (logSpy.mock.calls[0] as string[])[0];
    expect(logMessage).toContain('[CRITICAL]');
    expect(logMessage).toContain('decision-plugin-a');
    expect(logMessage).toContain('decision-plugin-b');
  });
});
