import * as path from 'path';
import { PluginsService } from './plugins.service';
import type { PluginManifest } from './manifest';
import type { PrismaService } from '../prisma/prisma.service';
import type { PluginEventsService } from './plugin-events.service';
import type { ConfigService } from '@nestjs/config';
import type { KvService } from '../common/kv.service';
import type { AuditService } from '../audit/audit.service';
import type { Plugin } from '@prisma/client';

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

// Mock child_process so git operations are interceptable in update()/install() tests.
jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));
import { execFile as execFileMock } from 'child_process';

// Mock ./manifest so install() tests can control readManifest/validateManifest.
jest.mock('./manifest', () => ({
  readManifest: jest.fn().mockReturnValue(null),
  validateManifest: jest.fn().mockReturnValue([]),
}));
import { readManifest, validateManifest } from './manifest';

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
    get: jest.fn().mockReturnValue('/var/plugins'),
  } as unknown as ConfigService;

  const service = new PluginsService(db, events, cfg);

  // Override getManifest to use the in-memory map.
  service.getManifest = jest.fn().mockImplementation((installedPath: string | null) => {
    if (!installedPath) return null;
    return manifestMap[installedPath] ?? null;
  });

  return service;
}

/** PluginsService factory with KvService + AuditService mocks for writeSkillGuarded / revertSkill tests. */
function makeServiceWithKv(opts: {
  pluginRecord?: {
    id: string;
    installed_path: string | null;
    name: string;
    type: string;
    active: boolean;
  } | null;
  manifest?: PluginManifest | null;
  skillBody?: string | null;
  kvValue?: string | null;
}): {
  service: PluginsService;
  kv: jest.Mocked<Pick<KvService, 'get' | 'set'>>;
  audit: { log: jest.Mock };
  writeSkillContentMock: jest.Mock;
} {
  const plugin = opts.pluginRecord ?? {
    id: 'test-skill',
    installed_path: '/plugins/test-skill',
    name: 'test-skill',
    type: 'skill',
    active: true,
  };

  const db = {
    plugin: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(plugin),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  } as unknown as PrismaService;

  const events = { emit: jest.fn() } as unknown as PluginEventsService;
  const cfg = { get: jest.fn().mockReturnValue('/var/plugins') } as unknown as ConfigService;

  const kv: jest.Mocked<Pick<KvService, 'get' | 'set'>> = {
    get: jest.fn().mockResolvedValue(opts.kvValue ?? null),
    set: jest.fn().mockResolvedValue(undefined),
  };

  const audit = { log: jest.fn().mockResolvedValue(undefined) };

  const service = new PluginsService(
    db,
    events,
    cfg,
    kv as unknown as KvService,
    audit as unknown as import('../audit/audit.service').AuditService,
  );

  // Override getManifest
  service.getManifest = jest.fn().mockReturnValue(opts.manifest ?? null);

  // Spy on loadSkillContent
  jest.spyOn(service, 'loadSkillContent').mockResolvedValue(opts.skillBody ?? null);

  // Mock writeSkillContent to avoid fs I/O
  const writeSkillContentMock = jest.fn().mockResolvedValue(true);
  jest.spyOn(service, 'writeSkillContent').mockImplementation(writeSkillContentMock);

  return { service, kv, audit, writeSkillContentMock };
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
    const service = makeService([{ id: 'some-plugin', installed_path: '/plugins/some-plugin' }], {
      '/plugins/some-plugin': makeManifest('some-plugin') /* no decision */,
    });
    const logSpy = jest.spyOn(service['log'], 'error');

    const result = await service.getActiveDecisionPrompt();

    expect(result).toBeNull();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('returns the decision.prompt verbatim when exactly one plugin has [decision]', async () => {
    const prompt = 'Emit tool_calls as JSON inside <tool_calls></tool_calls> tags.';
    const service = makeService([{ id: 'my-decision', installed_path: '/plugins/my-decision' }], {
      '/plugins/my-decision': makeManifest('my-decision', { prompt }),
    });

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
    (fs.readFileSync as jest.Mock).mockImplementation(
      jest.requireActual<typeof import('fs')>('fs').readFileSync,
    );
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
    (fs.readFileSync as jest.Mock).mockImplementation(
      jest.requireActual<typeof import('fs')>('fs').readFileSync,
    );
  });

  it('prefers prompt over prompt_file when both are present', async () => {
    const prompt = 'Inline prompt wins.';
    const readFileSyncSpy = fs.readFileSync as jest.Mock;

    const service = makeService([{ id: 'both-set', installed_path: '/plugins/both-set' }], {
      '/plugins/both-set': makeManifest('both-set', {
        prompt,
        prompt_file: 'DECISION.md',
      }),
    });

    const result = await service.getActiveDecisionPrompt();

    expect(result).toBe(prompt);
    // readFileSync must NOT be called since prompt wins over prompt_file.
    const calls = readFileSyncSpy.mock.calls as unknown[][];
    const relevantCalls = calls.filter(
      (args) => typeof args[0] === 'string' && args[0].includes('DECISION'),
    );
    expect(relevantCalls).toHaveLength(0);
  });

  it('returns null when prompt_file read throws (never throws)', async () => {
    (fs.readFileSync as jest.Mock).mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const service = makeService([{ id: 'bad-file', installed_path: '/plugins/bad-file' }], {
      '/plugins/bad-file': makeManifest('bad-file', { prompt_file: 'MISSING.md' }),
    });

    const result = await service.getActiveDecisionPrompt();
    expect(result).toBeNull();
    // Restore mock for subsequent tests.
    (fs.readFileSync as jest.Mock).mockImplementation(
      jest.requireActual<typeof import('fs')>('fs').readFileSync,
    );
  });

  // Keep existing test below this line
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

// ── Phase 1.3: PluginManifest.llm_writable type test ─────────────────────────

describe('PluginManifest llm_writable field', () => {
  it('compiles with llm_writable: true and is accessible as boolean | undefined', () => {
    // Compile-time test: tsc will reject this if llm_writable is not on the plugin block.
    const manifest: PluginManifest = {
      plugin: {
        id: 'test-skill',
        name: 'Test Skill',
        version: '1.0.0',
        type: 'skill',
        llm_writable: true,
      },
    };
    // Runtime: the field must be accessible
    const flag: boolean | undefined = manifest.plugin.llm_writable;
    expect(flag).toBe(true);
  });

  it('is undefined when omitted (absent means false)', () => {
    const manifest: PluginManifest = {
      plugin: { id: 'no-flag', name: 'No Flag', version: '1.0.0', type: 'skill' },
    };
    expect(manifest.plugin.llm_writable).toBeUndefined();
  });
});

// ── s2 Task 1.3: PluginManifest.reflection capability block type test ────────

describe('PluginManifest reflection block', () => {
  it('s2-1.3 — compiles with reflection: { prompt } and is accessible as typed optional', () => {
    // Compile-time gate: tsc will reject this if the 'reflection' block is not on PluginManifest.
    const manifest: PluginManifest = {
      plugin: { id: 'reflect-plugin', name: 'Reflector', version: '1.0.0', type: 'skill' },
      reflection: { prompt: 'Analyze your recent decisions.' },
    };
    // Runtime: the field must be accessible
    expect(manifest.reflection?.prompt).toBe('Analyze your recent decisions.');
  });

  it('s2-1.3 — compiles with reflection: { prompt_file } only', () => {
    const manifest: PluginManifest = {
      plugin: { id: 'reflect-file', name: 'Reflector File', version: '1.0.0', type: 'skill' },
      reflection: { prompt_file: 'REFLECT.md' },
    };
    expect(manifest.reflection?.prompt_file).toBe('REFLECT.md');
  });

  it('s2-1.3 — is undefined when omitted (absent means no reflection capability)', () => {
    const manifest: PluginManifest = {
      plugin: { id: 'no-reflect', name: 'No Reflect', version: '1.0.0', type: 'skill' },
    };
    expect(manifest.reflection).toBeUndefined();
  });
});

// ── s2 Task 1.5: PluginsService.getActiveReflectionPrompt tests ───────────────

/** Build PluginsService configured for getActiveReflectionPrompt tests. */
function makeReflectionService(
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
  } as unknown as import('../prisma/prisma.service').PrismaService;

  const events = {
    emit: jest.fn(),
  } as unknown as import('./plugin-events.service').PluginEventsService;
  const cfg = {
    get: jest.fn().mockReturnValue('/var/plugins'),
  } as unknown as import('@nestjs/config').ConfigService;

  const service = new PluginsService(db, events, cfg);

  service.getManifest = jest.fn().mockImplementation((installedPath: string | null) => {
    if (!installedPath) return null;
    return manifestMap[installedPath] ?? null;
  });

  return service;
}

function makeReflectionManifest(
  id: string,
  reflectionSection?: PluginManifest['reflection'],
): PluginManifest {
  return {
    plugin: { id, name: id, version: '1.0.0', type: 'extra' },
    reflection: reflectionSection,
  };
}

describe('PluginsService.getActiveReflectionPrompt', () => {
  beforeEach(() => jest.restoreAllMocks());

  it('s2-1.5a — returns null when 0 active plugins declare a [reflection] section', async () => {
    const service = makeReflectionService(
      [{ id: 'some-plugin', installed_path: '/plugins/some-plugin' }],
      { '/plugins/some-plugin': makeManifest('some-plugin') /* no reflection */ },
    );
    const logSpy = jest.spyOn(service['log'], 'error');

    const result = await service.getActiveReflectionPrompt();

    expect(result).toBeNull();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('s2-1.5b — returns reflection.prompt verbatim when exactly 1 plugin has [reflection] with prompt', async () => {
    const prompt = 'Analyze your recent trade decisions and find patterns to improve.';
    const service = makeReflectionService(
      [{ id: 'my-reflector', installed_path: '/plugins/my-reflector' }],
      { '/plugins/my-reflector': makeReflectionManifest('my-reflector', { prompt }) },
    );

    const result = await service.getActiveReflectionPrompt();

    expect(result).toBe(prompt);
  });

  it('s2-1.5c — reads reflection.prompt_file relative to installed_path when prompt is absent', async () => {
    const fileContent = 'Reflection instructions from file.';
    const readFileSyncSpy = (fs.readFileSync as jest.Mock).mockReturnValue(fileContent);

    const service = makeReflectionService(
      [{ id: 'file-reflector', installed_path: '/plugins/file-reflector' }],
      {
        '/plugins/file-reflector': makeReflectionManifest('file-reflector', {
          prompt_file: 'REFLECT.md',
        }),
      },
    );

    const result = await service.getActiveReflectionPrompt();

    expect(result).toBe(fileContent);
    // Must use path.join(installed_path, basename) — no path traversal.
    expect(readFileSyncSpy).toHaveBeenCalledWith(
      path.join('/plugins/file-reflector', 'REFLECT.md'),
      'utf8',
    );
    readFileSyncSpy.mockReset();
    (fs.readFileSync as jest.Mock).mockImplementation(
      jest.requireActual<typeof import('fs')>('fs').readFileSync,
    );
  });

  it('s2-1.5d — returns null and logs CRITICAL when >1 active plugins declare [reflection]', async () => {
    const service = makeReflectionService(
      [
        { id: 'reflector-a', installed_path: '/plugins/reflector-a' },
        { id: 'reflector-b', installed_path: '/plugins/reflector-b' },
      ],
      {
        '/plugins/reflector-a': makeReflectionManifest('reflector-a', { prompt: 'Prompt A' }),
        '/plugins/reflector-b': makeReflectionManifest('reflector-b', { prompt: 'Prompt B' }),
      },
    );
    const logSpy = jest.spyOn(service['log'], 'error');

    const result = await service.getActiveReflectionPrompt();

    expect(result).toBeNull();
    expect(logSpy).toHaveBeenCalledTimes(1);
    const logMessage: string = (logSpy.mock.calls[0] as string[])[0];
    expect(logMessage).toContain('[CRITICAL]');
    expect(logMessage).toContain('reflector-a');
    expect(logMessage).toContain('reflector-b');
  });

  it('s2-1.5e — never throws (returns null when prompt_file read fails)', async () => {
    (fs.readFileSync as jest.Mock).mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const service = makeReflectionService(
      [{ id: 'bad-file', installed_path: '/plugins/bad-file' }],
      { '/plugins/bad-file': makeReflectionManifest('bad-file', { prompt_file: 'MISSING.md' }) },
    );

    const result = await service.getActiveReflectionPrompt();
    expect(result).toBeNull();

    (fs.readFileSync as jest.Mock).mockImplementation(
      jest.requireActual<typeof import('fs')>('fs').readFileSync,
    );
  });

  it('s2-1.5f — prefers reflection.prompt over reflection.prompt_file when both present', async () => {
    const prompt = 'Inline reflection prompt wins.';
    const readFileSyncSpy = fs.readFileSync as jest.Mock;

    const service = makeReflectionService(
      [{ id: 'both-set', installed_path: '/plugins/both-set' }],
      {
        '/plugins/both-set': makeReflectionManifest('both-set', {
          prompt,
          prompt_file: 'REFLECT.md',
        }),
      },
    );

    const result = await service.getActiveReflectionPrompt();

    expect(result).toBe(prompt);
    const calls = readFileSyncSpy.mock.calls as unknown[][];
    const relevantCalls = calls.filter(
      (args) => typeof args[0] === 'string' && args[0].includes('REFLECT'),
    );
    expect(relevantCalls).toHaveLength(0);
  });
});

// ── Phase 2.1: writeSkillGuarded unit tests ───────────────────────────────────

describe('PluginsService.writeSkillGuarded', () => {
  beforeEach(() => jest.restoreAllMocks());

  const writable_manifest: PluginManifest = {
    plugin: {
      id: 'test-skill',
      name: 'Test Skill',
      version: '1.0.0',
      type: 'skill',
      llm_writable: true,
    },
  };

  const non_writable_manifest: PluginManifest = {
    plugin: { id: 'test-skill', name: 'Test Skill', version: '1.0.0', type: 'skill' },
  };

  it('denies when llm_writable is absent → {ok:false, reason:"not_writable"}, audits skill_write_denied, no KV set, no writeSkillContent', async () => {
    const { service, kv, audit, writeSkillContentMock } = makeServiceWithKv({
      manifest: non_writable_manifest,
      skillBody: 'existing body of sufficient length for tests',
    });

    const result = await service.writeSkillGuarded('test-skill', 'a'.repeat(100));

    expect(result).toEqual({ ok: false, reason: 'not_writable' });
    expect(kv.set).not.toHaveBeenCalled();
    expect(writeSkillContentMock).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'skill_write_denied' }),
    );
    // skill_written must NOT be emitted
    const writtenCalls = (audit.log.mock.calls as { event_type: string }[][]).filter(
      (args) => args[0].event_type === 'skill_written',
    );
    expect(writtenCalls).toHaveLength(0);
  });

  it('denies when newBody.trim().length < 50 → {ok:false, reason:"diff_too_large"}', async () => {
    const { service, kv, audit, writeSkillContentMock } = makeServiceWithKv({
      manifest: writable_manifest,
      skillBody: 'existing body',
    });

    const result = await service.writeSkillGuarded('test-skill', 'short');

    expect(result).toEqual({ ok: false, reason: 'diff_too_large' });
    expect(kv.set).not.toHaveBeenCalled();
    expect(writeSkillContentMock).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'skill_write_denied' }),
    );
  });

  it('denies when ratio delta > 0.5 with non-zero oldLen → {ok:false, reason:"diff_too_large"}', async () => {
    const { service, kv, audit, writeSkillContentMock } = makeServiceWithKv({
      manifest: writable_manifest,
      skillBody: 'a'.repeat(200), // oldLen = 200
    });

    // newLen = 350 → delta = 150/200 = 0.75 > 0.5 → rejected
    const result = await service.writeSkillGuarded('test-skill', 'b'.repeat(350));

    expect(result).toEqual({ ok: false, reason: 'diff_too_large' });
    expect(kv.set).not.toHaveBeenCalled();
    expect(writeSkillContentMock).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'skill_write_denied' }),
    );
  });

  it('passes when oldLen === 0 (first write) and newLen >= 50: skips ratio check', async () => {
    const { service, kv, audit, writeSkillContentMock } = makeServiceWithKv({
      manifest: writable_manifest,
      skillBody: null, // empty old body → oldLen=0
      kvValue: null,
    });

    const result = await service.writeSkillGuarded('test-skill', 'a'.repeat(200));

    expect(result.ok).toBe(true);
    expect(writeSkillContentMock).toHaveBeenCalled();
    expect(kv.set).toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'skill_written' }),
    );
  });

  it('happy path: KV.set called BEFORE writeSkillContent; audits skill_written with old_len/new_len; returns {ok:true}', async () => {
    const existingBody = 'a'.repeat(100);
    const newBody = 'b'.repeat(130); // delta = 30/100 = 0.3 ≤ 0.5 → allowed

    const { service, kv, audit, writeSkillContentMock } = makeServiceWithKv({
      manifest: writable_manifest,
      skillBody: existingBody,
      kvValue: null,
    });

    const callOrder: string[] = [];
    kv.set.mockImplementation((_key: string, _val: string) => {
      callOrder.push('kv.set');
      return Promise.resolve();
    });
    writeSkillContentMock.mockImplementation((_name: string, _body: string) => {
      callOrder.push('writeSkillContent');
      return Promise.resolve(true);
    });

    const result = await service.writeSkillGuarded('test-skill', newBody);

    expect(result).toEqual({ ok: true, old_len: 100, new_len: 130 });
    expect(callOrder).toEqual(['kv.set', 'writeSkillContent']);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'skill_written',
        meta: expect.objectContaining({ old_len: 100, new_len: 130 }) as unknown,
      }),
    );
  });

  it('FIFO: after 6 writes, KV array is capped at 5 (oldest shifted)', async () => {
    // Start with 5 existing snapshots
    const existing = ['snap1', 'snap2', 'snap3', 'snap4', 'snap5'];
    const existingBody = 'a'.repeat(100);

    const { service, kv } = makeServiceWithKv({
      manifest: writable_manifest,
      skillBody: existingBody,
      kvValue: JSON.stringify(existing),
    });

    let captured: string | null = null;
    kv.set.mockImplementation((_key: string, val: string) => {
      captured = val;
      return Promise.resolve();
    });

    await service.writeSkillGuarded('test-skill', 'b'.repeat(130));

    expect(captured).not.toBeNull();
    const arr = JSON.parse(captured!) as string[];
    // Should have shifted snap1 and added existingBody → ['snap2','snap3','snap4','snap5', existingBody]
    expect(arr).toHaveLength(5);
    expect(arr[0]).toBe('snap2');
    expect(arr[4]).toBe(existingBody);
  });

  it('malformed KV JSON treated as [], no throw', async () => {
    const { service, writeSkillContentMock } = makeServiceWithKv({
      manifest: writable_manifest,
      skillBody: 'a'.repeat(100),
      kvValue: 'not-valid-json',
    });

    const result = await service.writeSkillGuarded('test-skill', 'b'.repeat(130));

    expect(result.ok).toBe(true);
    expect(writeSkillContentMock).toHaveBeenCalled();
  });

  it('skill not found → {ok:false, reason:"not_found"}, no audit', async () => {
    const db = {
      plugin: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null), // not found
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
    } as unknown as PrismaService;
    const events = { emit: jest.fn() } as unknown as PluginEventsService;
    const cfg = { get: jest.fn().mockReturnValue('/var/plugins') } as unknown as ConfigService;
    const kv: jest.Mocked<Pick<KvService, 'get' | 'set'>> = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
    };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const service = new PluginsService(
      db,
      events,
      cfg,
      kv as unknown as KvService,
      audit as unknown as import('../audit/audit.service').AuditService,
    );

    const result = await service.writeSkillGuarded('missing-skill', 'a'.repeat(100));

    expect(result).toEqual({ ok: false, reason: 'not_found' });
    expect(audit.log).not.toHaveBeenCalled();
  });
});

// ── Phase 2.3: revertSkill unit tests ────────────────────────────────────────

describe('PluginsService.revertSkill', () => {
  beforeEach(() => jest.restoreAllMocks());

  it('no snapshot → {ok:false, reason:"no_snapshot"}, no writeSkillContent', async () => {
    const { service, audit, writeSkillContentMock } = makeServiceWithKv({
      kvValue: null,
      manifest: {
        plugin: {
          id: 'test-skill',
          name: 'Test Skill',
          version: '1.0.0',
          type: 'skill',
          llm_writable: true,
        },
      },
    });

    const result = await service.revertSkill('test-skill');

    expect(result).toEqual({ ok: false, reason: 'no_snapshot' });
    expect(writeSkillContentMock).not.toHaveBeenCalled();
    // audit is NOT called for no_snapshot (only called for skill_write_denied and skill_reverted)
    expect(audit.log).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'skill_reverted' }),
    );
  });

  it('no snapshot (empty JSON array) → {ok:false, reason:"no_snapshot"}', async () => {
    const { service, audit, writeSkillContentMock } = makeServiceWithKv({
      kvValue: JSON.stringify([]),
      manifest: {
        plugin: {
          id: 'test-skill',
          name: 'Test Skill',
          version: '1.0.0',
          type: 'skill',
          llm_writable: true,
        },
      },
    });

    const result = await service.revertSkill('test-skill');

    expect(result).toEqual({ ok: false, reason: 'no_snapshot' });
    expect(writeSkillContentMock).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'skill_reverted' }),
    );
  });

  it('with snapshot: pops latest, calls writeSkillContent with that body, audits skill_reverted, persists shrunken array', async () => {
    const snapshots = ['body-v1', 'body-v2', 'body-v3'];
    const { service, kv, audit, writeSkillContentMock } = makeServiceWithKv({
      kvValue: JSON.stringify(snapshots),
      manifest: {
        plugin: {
          id: 'test-skill',
          name: 'Test Skill',
          version: '1.0.0',
          type: 'skill',
          llm_writable: true,
        },
      },
    });

    let savedArr: string[] | null = null;
    kv.set.mockImplementation((_key: string, val: string) => {
      savedArr = JSON.parse(val) as string[];
      return Promise.resolve();
    });

    const result = await service.revertSkill('test-skill');

    expect(result).toEqual({ ok: true });
    expect(writeSkillContentMock).toHaveBeenCalledWith('test-skill', 'body-v3');
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'skill_reverted' }),
    );
    // Array shrank: 'body-v3' was popped
    expect(savedArr).toEqual(['body-v1', 'body-v2']);
  });

  it('Fix#2 revert allowlist: llm_writable absent → {ok:false, reason:"not_writable"}, audits skill_write_denied, writeSkillContent NOT called', async () => {
    // revertSkill must enforce llm_writable just like writeSkillGuarded (fail-closed)
    const snapshots = ['body-v1', 'body-v2'];
    const { service, audit, writeSkillContentMock } = makeServiceWithKv({
      kvValue: JSON.stringify(snapshots),
      manifest: {
        plugin: { id: 'test-skill', name: 'Test Skill', version: '1.0.0', type: 'skill' },
        // llm_writable absent → fail-closed
      },
    });

    const result = await service.revertSkill('test-skill');

    expect(result).toEqual({ ok: false, reason: 'not_writable' });
    expect(writeSkillContentMock).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'skill_write_denied' }),
    );
  });

  it('Fix#2 revert allowlist: llm_writable:false → {ok:false, reason:"not_writable"}', async () => {
    const snapshots = ['body-v1'];
    const { service, writeSkillContentMock } = makeServiceWithKv({
      kvValue: JSON.stringify(snapshots),
      manifest: {
        plugin: {
          id: 'test-skill',
          name: 'Test Skill',
          version: '1.0.0',
          type: 'skill',
          llm_writable: false,
        },
      },
    });

    const result = await service.revertSkill('test-skill');

    expect(result).toEqual({ ok: false, reason: 'not_writable' });
    expect(writeSkillContentMock).not.toHaveBeenCalled();
  });
});

// ── F3-s3 Phase 4: PluginsService.getReputation + trust-report (RED → GREEN) ──

import type { PrismaService as PrismaServiceForPlugins } from '../prisma/prisma.service';

/** Minimal Plugin row shape for reputation/trust tests */
function makePluginRow(
  id: string,
  overrides: {
    reputation_score?: number | null;
    reputation_detail?: string | null;
    scan_result?: string | null;
    smoke_test_result?: string | null;
    trust_score?: number | null;
    content_checksum?: string | null;
    votes_net?: number;
  } = {},
): import('@prisma/client').Plugin {
  return {
    id,
    name: `Plugin ${id}`,
    description: null,
    version: '1.0.0',
    type: 'skill',
    active: false,
    verification: 'unverified',
    author: null,
    source_url: null,
    git_url: null,
    stack_plugins: null,
    skills: null,
    symbols: null,
    config: null,
    installed_path: null,
    scan_result: overrides.scan_result ?? null,
    smoke_test_result: overrides.smoke_test_result ?? null,
    reputation_score: overrides.reputation_score ?? null,
    reputation_detail: overrides.reputation_detail ?? null,
    trust_score: overrides.trust_score ?? null,
    content_checksum: overrides.content_checksum ?? null,
    votes_net: overrides.votes_net ?? 0,
    installed_at: new Date(),
    updated_at: new Date(),
  };
}

/** Build PluginsService wired for reputation / trust-report tests */
function makePluginsSvcForReputation(
  pluginRow: import('@prisma/client').Plugin | null,
): PluginsService {
  const db = {
    plugin: {
      findUnique: jest.fn().mockResolvedValue(pluginRow),
      findMany: jest.fn().mockResolvedValue(pluginRow ? [pluginRow] : []),
      findFirst: jest.fn().mockResolvedValue(pluginRow),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  } as unknown as PrismaServiceForPlugins;

  const events = {
    emit: jest.fn(),
  } as unknown as import('./plugin-events.service').PluginEventsService;
  const cfg = {
    get: jest.fn().mockReturnValue('/var/plugins'),
  } as unknown as import('@nestjs/config').ConfigService;

  const svc = new PluginsService(db, events, cfg);
  svc.getManifest = jest.fn().mockReturnValue(null);
  return svc;
}

describe('PluginsService.getReputation (F3-s3 Phase 4)', () => {
  beforeEach(() => jest.restoreAllMocks());

  // 4.1: plugin with reputation_score + reputation_detail → parsed object
  it('4.1 — plugin with reputation_score=53 and JSON detail → returns {reputation_score:53, reputation_detail:obj}', async () => {
    const detail = {
      portfolios_count: 2,
      avg_sharpe: 1.5,
      avg_return_pct: 30,
      worst_dd_pct: 10,
      computed_at: '2026-01-01T00:00:00.000Z',
    };
    const row = makePluginRow('plugin-rated', {
      reputation_score: 53,
      reputation_detail: JSON.stringify(detail),
    });
    const svc = makePluginsSvcForReputation(row);

    const result = await svc.getReputation('plugin-rated');

    expect(result.reputation_score).toBe(53);
    expect(result.reputation_detail).toEqual(detail);
  });

  // 4.2: plugin with null reputation → returns {null, null}
  it('4.2 — plugin with null reputation_score and null detail → returns {reputation_score:null, reputation_detail:null}', async () => {
    const row = makePluginRow('plugin-unrated', {
      reputation_score: null,
      reputation_detail: null,
    });
    const svc = makePluginsSvcForReputation(row);

    const result = await svc.getReputation('plugin-unrated');

    expect(result).toEqual({ reputation_score: null, reputation_detail: null });
  });

  // 4.3: plugin not found → NotFoundException
  it('4.3 — plugin not found → throws NotFoundException', async () => {
    const svc = makePluginsSvcForReputation(null);
    await expect(svc.getReputation('unknown-id')).rejects.toThrow('no encontrado');
  });
});

describe('PluginsService.getTrustReport — F3-s3 reputation_score extension', () => {
  beforeEach(() => jest.restoreAllMocks());

  // 4.4: getTrustReport includes reputation_score from column
  it('4.4 — getTrustReport includes reputation_score field from persisted column', async () => {
    const row = makePluginRow('plugin-trust', {
      scan_result: JSON.stringify({ ok: true, findings: [] }),
      smoke_test_result: JSON.stringify({ ok: true, result: 'passed', checks: [] }),
      reputation_score: 72,
    });
    const svc = makePluginsSvcForReputation(row);

    const report = await svc.getTrustReport('plugin-trust');

    expect(report).toHaveProperty('reputation_score', 72);
    expect(report).toHaveProperty('scan_result');
    expect(report).toHaveProperty('smoke_test_result');
  });

  it('4.4b — getTrustReport returns reputation_score:null when column is null', async () => {
    const row = makePluginRow('plugin-unrated-trust', { reputation_score: null });
    const svc = makePluginsSvcForReputation(row);

    const report = await svc.getTrustReport('plugin-unrated-trust');

    expect(report.reputation_score).toBeNull();
  });
});

// ── F3-s4 Phase 4: RED → GREEN — Integration tests for service wiring ────────

// Private method type for spying on PluginsService internals without `any`.
type SvcPrivate = {
  gitClone: (url: string, dest: string) => Promise<void>;
  _scanOnInstall: (id: string) => Promise<void>;
  _smokeTestOnActivate: (id: string) => Promise<void>;
  log: { warn: (msg: string) => void };
  db: { plugin: { findUnique: jest.Mock; update: jest.Mock } };
};

// Helper: build a PluginsService instance wired for PR2 wiring tests.
function makePluginsSvcForWiring(opts: {
  pluginRow: Plugin | null;
  kv?: Pick<KvService, 'get'>;
  audit?: Pick<AuditService, 'log'>;
  dbUpdateMock?: jest.Mock;
}): {
  svc: PluginsService;
  dbUpdateSpy: jest.Mock;
  dbCreateSpy: jest.Mock;
} {
  const dbUpdateSpy = opts.dbUpdateMock ?? jest.fn().mockResolvedValue(undefined);
  const dbCreateSpy = jest.fn().mockResolvedValue(opts.pluginRow ?? { id: 'p1', version: '1.0.0' });

  const db = {
    plugin: {
      findUnique: jest.fn().mockResolvedValue(opts.pluginRow),
      findMany: jest.fn().mockResolvedValue(opts.pluginRow ? [opts.pluginRow] : []),
      findFirst: jest.fn().mockResolvedValue(opts.pluginRow),
      create: dbCreateSpy,
      update: dbUpdateSpy,
      delete: jest.fn(),
    },
  } as unknown as PrismaServiceForPlugins;

  const events = { emit: jest.fn() } as unknown as PluginEventsService;
  const cfg = {
    get: jest.fn().mockReturnValue('/var/plugins'),
  } as unknown as ConfigService;

  const svc = new PluginsService(
    db,
    events,
    cfg,
    opts.kv as KvService | undefined,
    opts.audit as AuditService | undefined,
  );
  svc.getManifest = jest.fn().mockReturnValue(null);

  return { svc, dbUpdateSpy, dbCreateSpy };
}

// Minimal KV stub returning null (default weights/threshold)
function makeDefaultKv(): Pick<KvService, 'get'> {
  return { get: jest.fn().mockResolvedValue(null) };
}

// Typed call-finder for db.plugin.update mock — avoids unsafe `any` array indexing.
function findUpdateCallWithKey(
  spy: jest.Mock,
  key: string,
): { data: Record<string, unknown> } | undefined {
  return (spy.mock.calls as Array<[{ data: Record<string, unknown> }]>).find(
    (c) => key in c[0].data,
  )?.[0];
}

// ── Task 4.1: install() stores content_checksum ───────────────────────────────

describe('F3-s4 — install() content_checksum wiring', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    (readManifest as unknown as jest.Mock).mockReturnValue(null);
    (validateManifest as unknown as jest.Mock).mockReturnValue([]);
    (execFileMock as unknown as jest.Mock).mockImplementation(
      (
        _cmd: string,
        _args: string[],
        cb: (err: null, result: { stdout: string; stderr: string }) => void,
      ) => {
        cb(null, { stdout: '', stderr: '' });
      },
    );
  });

  it('4.1a — install() calls db.plugin.update with computed content_checksum after create', async () => {
    const row = makePluginRow('my-plugin');
    const { svc, dbUpdateSpy, dbCreateSpy } = makePluginsSvcForWiring({ pluginRow: row });

    (readManifest as unknown as jest.Mock).mockReturnValue({
      plugin: { id: 'my-plugin', name: 'My Plugin', version: '1.0.0', type: 'skill' },
    });
    // No conflict on duplicate check
    (svc as unknown as SvcPrivate).db.plugin.findUnique = jest.fn().mockResolvedValue(null);
    dbCreateSpy.mockResolvedValue(makePluginRow('my-plugin'));
    // Bypass actual git clone and sandbox scan
    jest.spyOn(svc as unknown as SvcPrivate, 'gitClone').mockResolvedValue(undefined);
    jest.spyOn(svc as unknown as SvcPrivate, '_scanOnInstall').mockResolvedValue(undefined);
    jest.spyOn(svc, 'computeContentChecksum').mockReturnValue('abc123hash');

    await svc.install('https://github.com/user/my-plugin.git');

    const call = findUpdateCallWithKey(dbUpdateSpy, 'content_checksum');
    expect(call).toBeDefined();
    expect(call!.data.content_checksum).toBe('abc123hash');
  });

  it('4.1b — install() succeeds even when computeContentChecksum throws', async () => {
    const row = makePluginRow('my-plugin');
    const { svc, dbCreateSpy } = makePluginsSvcForWiring({ pluginRow: row });

    (readManifest as unknown as jest.Mock).mockReturnValue({
      plugin: { id: 'my-plugin', name: 'My Plugin', version: '1.0.0', type: 'skill' },
    });
    (svc as unknown as SvcPrivate).db.plugin.findUnique = jest.fn().mockResolvedValue(null);
    dbCreateSpy.mockResolvedValue(makePluginRow('my-plugin'));
    jest.spyOn(svc as unknown as SvcPrivate, 'gitClone').mockResolvedValue(undefined);
    jest.spyOn(svc as unknown as SvcPrivate, '_scanOnInstall').mockResolvedValue(undefined);
    jest.spyOn(svc, 'computeContentChecksum').mockImplementation(() => {
      throw new Error('disk read failure');
    });

    // install() must NOT throw — neutral-kernel principle
    await expect(svc.install('https://github.com/user/my-plugin.git')).resolves.toBeDefined();
  });

  it('4.1c — install() returned object has content_checksum equal to the computed checksum (not null)', async () => {
    const row = makePluginRow('my-plugin');
    const { svc, dbUpdateSpy, dbCreateSpy } = makePluginsSvcForWiring({ pluginRow: row });

    (readManifest as unknown as jest.Mock).mockReturnValue({
      plugin: { id: 'my-plugin', name: 'My Plugin', version: '1.0.0', type: 'skill' },
    });
    (svc as unknown as SvcPrivate).db.plugin.findUnique = jest.fn().mockResolvedValue(null);
    dbCreateSpy.mockResolvedValue(makePluginRow('my-plugin'));
    // db.plugin.update returns the row with content_checksum populated
    dbUpdateSpy.mockResolvedValue(makePluginRow('my-plugin', { content_checksum: 'abc123hash' }));
    jest.spyOn(svc as unknown as SvcPrivate, 'gitClone').mockResolvedValue(undefined);
    jest.spyOn(svc as unknown as SvcPrivate, '_scanOnInstall').mockResolvedValue(undefined);
    jest.spyOn(svc, 'computeContentChecksum').mockReturnValue('abc123hash');

    const result = await svc.install('https://github.com/user/my-plugin.git');

    expect(result.content_checksum).toBe('abc123hash');
  });
});

// ── Task 4.2: update() checksum change detection ──────────────────────────────

describe('F3-s4 — update() checksum change detection', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    (readManifest as unknown as jest.Mock).mockReturnValue(null);
    (execFileMock as unknown as jest.Mock).mockImplementation(
      (
        _cmd: string,
        _args: string[],
        cb: (err: null, result: { stdout: string; stderr: string }) => void,
      ) => {
        cb(null, { stdout: 'Already up to date.', stderr: '' });
      },
    );
  });

  // Helper: build an update-wired service with a git-installed plugin row.
  function makeUpdateSvc(opts: {
    storedChecksum: string | null;
    computedChecksum: string | null;
    auditLogMock?: jest.Mock;
  }): { svc: PluginsService; dbUpdateSpy: jest.Mock; auditLog: jest.Mock } {
    const base = makePluginRow('git-plugin', { content_checksum: opts.storedChecksum });
    // Plugin.git_url and installed_path are not in makePluginRow overrides; cast to extend.
    const row = {
      ...base,
      git_url: 'https://github.com/user/git-plugin.git',
      installed_path: '/plugins/git-plugin',
    } as Plugin;

    const auditLog = opts.auditLogMock ?? jest.fn().mockResolvedValue(undefined);
    const { svc, dbUpdateSpy } = makePluginsSvcForWiring({
      pluginRow: row,
      audit: { log: auditLog },
    });
    jest.spyOn(svc, 'computeContentChecksum').mockReturnValue(opts.computedChecksum);
    return { svc, dbUpdateSpy, auditLog };
  }

  it('4.2a — update() unchanged checksum → no audit.log for content_changed, checksum refreshed', async () => {
    const { svc, dbUpdateSpy, auditLog } = makeUpdateSvc({
      storedChecksum: 'aabbcc',
      computedChecksum: 'aabbcc',
    });

    const result = await svc.update('git-plugin');

    expect(result.ok).toBe(true);
    // unchanged checksum → content_changed event must NOT be logged
    expect(auditLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'plugin_content_changed' }),
    );
    // checksum persisted with same value
    const call = findUpdateCallWithKey(dbUpdateSpy, 'content_checksum');
    expect(call).toBeDefined();
    expect(call!.data.content_checksum).toBe('aabbcc');
  });

  it('4.2b — update() changed checksum → audit plugin_content_changed + new checksum persisted', async () => {
    const auditLog = jest.fn().mockResolvedValue(undefined);
    const { svc, dbUpdateSpy } = makeUpdateSvc({
      storedChecksum: 'old-hash',
      computedChecksum: 'new-hash',
      auditLogMock: auditLog,
    });

    const result = await svc.update('git-plugin');

    expect(result.ok).toBe(true);
    const metaMatcher: unknown = expect.objectContaining({ old: 'old-hash', new: 'new-hash' });
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'plugin_content_changed',
        plugin_id: 'git-plugin',
        meta: metaMatcher,
      }),
    );
    const call = findUpdateCallWithKey(dbUpdateSpy, 'content_checksum');
    expect(call).toBeDefined();
    expect(call!.data.content_checksum).toBe('new-hash');
  });

  it('4.2c — update() computeContentChecksum throws → update still proceeds, no rethrow', async () => {
    const base = makePluginRow('git-plugin', { content_checksum: 'old' });
    const row = {
      ...base,
      git_url: 'https://github.com/user/git-plugin.git',
      installed_path: '/plugins/git-plugin',
    } as Plugin;
    const { svc } = makePluginsSvcForWiring({ pluginRow: row });
    jest.spyOn(svc, 'computeContentChecksum').mockImplementation(() => {
      throw new Error('checksum failure');
    });

    await expect(svc.update('git-plugin')).resolves.toEqual(expect.objectContaining({ ok: true }));
  });

  it('4.2d — update() prev hash + next null (covered files removed) → audit plugin_content_changed fires + null checksum persisted', async () => {
    const auditLog = jest.fn().mockResolvedValue(undefined);
    const { svc, dbUpdateSpy } = makeUpdateSvc({
      storedChecksum: 'prev-hash',
      computedChecksum: null,
      auditLogMock: auditLog,
    });

    const result = await svc.update('git-plugin');

    expect(result.ok).toBe(true);
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'plugin_content_changed',
        plugin_id: 'git-plugin',
        meta: expect.objectContaining({ old: 'prev-hash', new: null }) as unknown,
      }),
    );
    const call = findUpdateCallWithKey(dbUpdateSpy, 'content_checksum');
    expect(call).toBeDefined();
    expect(call!.data.content_checksum).toBeNull();
  });

  it('4.2e — update() prev null + next hash (first-time checksum) → NO audit, new checksum persisted', async () => {
    const auditLog = jest.fn().mockResolvedValue(undefined);
    const { svc, dbUpdateSpy } = makeUpdateSvc({
      storedChecksum: null,
      computedChecksum: 'first-hash',
      auditLogMock: auditLog,
    });

    const result = await svc.update('git-plugin');

    expect(result.ok).toBe(true);
    expect(auditLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'plugin_content_changed' }),
    );
    const call = findUpdateCallWithKey(dbUpdateSpy, 'content_checksum');
    expect(call).toBeDefined();
    expect(call!.data.content_checksum).toBe('first-hash');
  });
});

// ── Task 4.3: getTrustReport() extended (F3-s4) ──────────────────────────────

describe('F3-s4 — getTrustReport() extended with trust_score + badge + breakdown', () => {
  beforeEach(() => jest.restoreAllMocks());

  function makeTrustReportSvc(rowOverrides: Parameters<typeof makePluginRow>[1] = {}): {
    svc: PluginsService;
    dbUpdateSpy: jest.Mock;
  } {
    const row = makePluginRow('p1', rowOverrides);
    const dbUpdateSpy = jest.fn().mockResolvedValue(undefined);
    const { svc } = makePluginsSvcForWiring({
      pluginRow: row,
      kv: makeDefaultKv(),
      dbUpdateMock: dbUpdateSpy,
    });
    return { svc, dbUpdateSpy };
  }

  it('4.3a — row with all 4 signals → report includes trust_score, badge, content_checksum, breakdown', async () => {
    const { svc } = makeTrustReportSvc({
      scan_result: JSON.stringify({ findings: [] }),
      smoke_test_result: JSON.stringify({ result: 'passed' }),
      reputation_score: 80,
      votes_net: 0,
      content_checksum: 'abc123',
    });

    const report = await svc.getTrustReport('p1');

    expect(report).toHaveProperty('trust_score');
    expect(typeof report.trust_score).toBe('number');
    expect(report).toHaveProperty('badge');
    expect(typeof report.badge).toBe('boolean');
    expect(report).toHaveProperty('content_checksum', 'abc123');
    expect(report.breakdown).toHaveProperty('inputs');
    expect(report.breakdown).toHaveProperty('weights_used');
    expect(report.breakdown).toHaveProperty('threshold');
  });

  it('4.3b — stored trust_score differs from computed → db.plugin.update called opportunistically', async () => {
    const { svc, dbUpdateSpy } = makeTrustReportSvc({
      scan_result: JSON.stringify({ findings: [] }),
      smoke_test_result: JSON.stringify({ result: 'passed' }),
      reputation_score: 80,
      votes_net: 0,
      trust_score: 999, // clearly stale → triggers opportunistic persist
    });

    await svc.getTrustReport('p1');

    // Wait for the fire-and-forget promise to settle
    await Promise.resolve();
    const call = findUpdateCallWithKey(dbUpdateSpy, 'trust_score');
    expect(call).toBeDefined();
  });

  it('4.3c — opportunistic db.plugin.update throws → result is still returned, no rethrow', async () => {
    const dbUpdateSpy = jest.fn().mockRejectedValue(new Error('DB write failed'));
    const row = makePluginRow('p1', {
      scan_result: JSON.stringify({ findings: [] }),
      smoke_test_result: JSON.stringify({ result: 'passed' }),
      reputation_score: 80,
      votes_net: 0,
      trust_score: 999, // stale → triggers persist
    });
    const { svc } = makePluginsSvcForWiring({
      pluginRow: row,
      kv: makeDefaultKv(),
      dbUpdateMock: dbUpdateSpy,
    });

    // Must not throw — fire-and-forget
    const report = await svc.getTrustReport('p1');
    expect(report).toHaveProperty('trust_score');
  });

  it('4.3d — new plugin (all null signals) → trust_score=50, badge=false', async () => {
    const { svc } = makeTrustReportSvc({
      scan_result: null,
      smoke_test_result: null,
      reputation_score: null,
      votes_net: 0,
      trust_score: null,
    });

    const report = await svc.getTrustReport('p1');

    expect(report.trust_score).toBe(50);
    expect(report.badge).toBe(false);
  });
});

// ── Task 4.4: findAll() surfaces trust_score + badge ─────────────────────────

describe('F3-s4 — findAll() surfaces trust_score + badge per plugin', () => {
  beforeEach(() => jest.restoreAllMocks());

  function makeFindAllSvc(rows: Plugin[], kv: Pick<KvService, 'get'>): PluginsService {
    const db = {
      plugin: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue(rows),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
    } as unknown as PrismaServiceForPlugins;
    const events = { emit: jest.fn() } as unknown as PluginEventsService;
    const cfg = { get: jest.fn().mockReturnValue('/var/plugins') } as unknown as ConfigService;
    const svc = new PluginsService(db, events, cfg, kv as KvService);
    svc.getManifest = jest.fn().mockReturnValue(null);
    return svc;
  }

  it('4.4a — each returned plugin has trust_score + badge computed', async () => {
    const rows = [
      makePluginRow('p1', { scan_result: JSON.stringify({ findings: [] }), reputation_score: 80 }),
      makePluginRow('p2', { scan_result: null, reputation_score: null }),
    ];
    const svc = makeFindAllSvc(rows, makeDefaultKv());

    const plugins = await svc.findAll();

    for (const p of plugins) {
      expect(p).toHaveProperty('trust_score');
      expect(p).toHaveProperty('badge');
    }
  });

  it('4.4b — _readTrustConfig called exactly once per findAll() regardless of list size', async () => {
    const rows = [makePluginRow('p1'), makePluginRow('p2'), makePluginRow('p3')];
    const kvGetSpy = jest.fn().mockResolvedValue(null);
    const svc = makeFindAllSvc(rows, { get: kvGetSpy });

    await svc.findAll();

    // _readTrustConfig calls kv.get exactly twice (trust.weights + trust.badge_threshold)
    // for 3 plugins — single shared call, not per-plugin.
    expect(kvGetSpy).toHaveBeenCalledTimes(2);
  });

  it('4.4c — all-zero weights → trust_score null → badge false', async () => {
    const rows = [makePluginRow('p1', { scan_result: null, reputation_score: null })];
    const kvGet = jest.fn().mockImplementation((key: string) => {
      if (key === 'trust.weights')
        return Promise.resolve(JSON.stringify({ scan: 0, smoke: 0, reputation: 0, votes: 0 }));
      return Promise.resolve(null);
    });
    const svc = makeFindAllSvc(rows, { get: kvGet });

    const plugins = await svc.findAll();

    expect(plugins[0].badge).toBe(false);
  });
});

// ── Task 4.5: "nothing blocks" guard tests ────────────────────────────────────

describe('F3-s4 — "nothing blocks" guard tests (AC-14)', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    (readManifest as unknown as jest.Mock).mockReturnValue(null);
    (validateManifest as unknown as jest.Mock).mockReturnValue([]);
    (execFileMock as unknown as jest.Mock).mockImplementation(
      (
        _cmd: string,
        _args: string[],
        cb: (err: null, result: { stdout: string; stderr: string }) => void,
      ) => {
        cb(null, { stdout: 'ok', stderr: '' });
      },
    );
  });

  it('4.5a — scan all-warn + smoke failed + reputation null → install() still succeeds', async () => {
    const row = makePluginRow('heavy-plugin', {
      scan_result: JSON.stringify({
        findings: Array(11).fill({ severity: 'warning', message: 'bad' }),
      }),
      smoke_test_result: JSON.stringify({ result: 'failed' }),
      reputation_score: null,
    });
    const { svc, dbCreateSpy } = makePluginsSvcForWiring({ pluginRow: row });

    (readManifest as unknown as jest.Mock).mockReturnValue({
      plugin: { id: 'heavy-plugin', name: 'Heavy Plugin', version: '1.0.0', type: 'skill' },
    });
    (svc as unknown as SvcPrivate).db.plugin.findUnique = jest.fn().mockResolvedValue(null);
    dbCreateSpy.mockResolvedValue(makePluginRow('heavy-plugin'));
    jest.spyOn(svc as unknown as SvcPrivate, 'gitClone').mockResolvedValue(undefined);
    jest.spyOn(svc as unknown as SvcPrivate, '_scanOnInstall').mockResolvedValue(undefined);
    jest.spyOn(svc, 'computeContentChecksum').mockReturnValue(null);

    // Must succeed — NEVER blocked by trust/scan/smoke state
    await expect(svc.install('https://github.com/user/heavy-plugin.git')).resolves.toBeDefined();
  });

  it('4.5b — trust_score=0, badge=false → activate() still succeeds', async () => {
    const row = makePluginRow('zero-trust', { trust_score: 0 });
    const { svc } = makePluginsSvcForWiring({ pluginRow: row });
    jest.spyOn(svc as unknown as SvcPrivate, '_smokeTestOnActivate').mockResolvedValue(undefined);

    // activate NEVER gates on trust_score
    await expect(svc.activate('zero-trust')).resolves.toBeDefined();
  });

  it('4.5c — checksum mismatch on update → update() still returns ok', async () => {
    const base = makePluginRow('mismatch-plugin', { content_checksum: 'old' });
    const row = {
      ...base,
      git_url: 'https://github.com/user/mismatch-plugin.git',
      installed_path: '/plugins/mismatch-plugin',
    } as Plugin;
    const { svc } = makePluginsSvcForWiring({
      pluginRow: row,
      audit: { log: jest.fn().mockResolvedValue(undefined) },
    });
    jest.spyOn(svc, 'computeContentChecksum').mockReturnValue('new-hash');

    const result = await svc.update('mismatch-plugin');
    expect(result.ok).toBe(true);
  });
});

// ── Task 4.6: KV weight override applied in getTrustReport ───────────────────

describe('F3-s4 — KV weight override in getTrustReport (AC-6)', () => {
  beforeEach(() => jest.restoreAllMocks());

  it('4.6a — custom KV weights override default weights → trust_score uses new weights', async () => {
    // KV weights: scan=0.5, smoke=0.3, reputation=0.2, votes=0
    // Plugin: scan 0 warnings → 100; smoke passed → 100; reputation 80; votes weight=0 (excluded)
    // Expected: denom=1.0, raw = 0.5*100 + 0.3*100 + 0.2*80 = 96
    const row = makePluginRow('kv-plugin', {
      scan_result: JSON.stringify({ findings: [] }),
      smoke_test_result: JSON.stringify({ result: 'passed' }),
      reputation_score: 80,
      votes_net: 0,
      trust_score: null,
    });
    const kvGet = jest.fn().mockImplementation((key: string) => {
      if (key === 'trust.weights')
        return Promise.resolve(
          JSON.stringify({ scan: 0.5, smoke: 0.3, reputation: 0.2, votes: 0 }),
        );
      if (key === 'trust.badge_threshold') return Promise.resolve('80');
      return Promise.resolve(null);
    });
    const { svc } = makePluginsSvcForWiring({ pluginRow: row, kv: { get: kvGet } });

    const report = await svc.getTrustReport('kv-plugin');

    expect(report.trust_score).toBeCloseTo(96, 0);
    expect(report.badge).toBe(true);
    expect(report.breakdown.weights_used).not.toHaveProperty('votes');
  });
});

// ── F6-S3 Task A4.1: PluginsService.getActiveDebateRoles tests ───────────────

import type { DebateRole } from '../agents/debate.types';

/** Build a PluginsService instance configured for getActiveDebateRoles tests. */
function makeDebateService(
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
  } as unknown as import('../prisma/prisma.service').PrismaService;

  const events = { emit: jest.fn() } as unknown as import('./plugin-events.service').PluginEventsService;
  const cfg = {
    get: jest.fn().mockReturnValue('/var/plugins'),
  } as unknown as import('@nestjs/config').ConfigService;

  const service = new PluginsService(db, events, cfg);

  service.getManifest = jest.fn().mockImplementation((installedPath: string | null) => {
    if (!installedPath) return null;
    return manifestMap[installedPath] ?? null;
  });

  return service;
}

const THREE_DEBATE_ROLES: PluginManifest['debate'] = {
  roles: [
    { name: 'bull', prompt: 'You are bullish.', block: false },
    { name: 'bear', prompt: 'You are bearish.', block: false },
    { name: 'risk-auditor', prompt: 'You are the auditor.', block: true },
  ],
};

describe('PluginsService.getActiveDebateRoles', () => {
  beforeEach(() => jest.restoreAllMocks());

  it('f6s3-a4.1a — returns null when 0 active plugins declare a [debate] section', async () => {
    const service = makeDebateService(
      [{ id: 'no-debate-plugin', installed_path: '/plugins/no-debate-plugin' }],
      {
        '/plugins/no-debate-plugin': {
          plugin: { id: 'no-debate-plugin', name: 'No Debate', version: '1.0.0', type: 'extra' },
        },
      },
    );
    const logSpy = jest.spyOn(service['log'], 'error');

    const result = await service.getActiveDebateRoles();

    expect(result).toBeNull();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('f6s3-a4.1b — returns 3 DebateRole objects when exactly 1 active plugin has [debate]', async () => {
    const service = makeDebateService(
      [{ id: 'debate-plugin', installed_path: '/plugins/debate-plugin' }],
      {
        '/plugins/debate-plugin': {
          plugin: { id: 'debate-plugin', name: 'Debate Plugin', version: '1.0.0', type: 'extra' },
          debate: THREE_DEBATE_ROLES,
        },
      },
    );

    const result = await service.getActiveDebateRoles();

    expect(result).not.toBeNull();
    expect(result).toHaveLength(3);
    const auditor = result!.find((r: DebateRole) => r.name === 'risk-auditor');
    expect(auditor?.block).toBe(true);
  });

  it('f6s3-a4.1c — returns null and logs CRITICAL when >1 active plugins declare [debate]', async () => {
    const service = makeDebateService(
      [
        { id: 'debate-a', installed_path: '/plugins/debate-a' },
        { id: 'debate-b', installed_path: '/plugins/debate-b' },
      ],
      {
        '/plugins/debate-a': {
          plugin: { id: 'debate-a', name: 'Debate A', version: '1.0.0', type: 'extra' },
          debate: THREE_DEBATE_ROLES,
        },
        '/plugins/debate-b': {
          plugin: { id: 'debate-b', name: 'Debate B', version: '1.0.0', type: 'extra' },
          debate: THREE_DEBATE_ROLES,
        },
      },
    );
    const logSpy = jest.spyOn(service['log'], 'error');

    const result = await service.getActiveDebateRoles();

    expect(result).toBeNull();
    expect(logSpy).toHaveBeenCalledTimes(1);
    const logMessage: string = (logSpy.mock.calls[0] as string[])[0];
    expect(logMessage).toContain('[CRITICAL]');
    expect(logMessage).toContain('debate-a');
    expect(logMessage).toContain('debate-b');
  });

  it('f6s3-a4.1d — inline prompt wins over prompt_file when both are present', async () => {
    const service = makeDebateService(
      [{ id: 'inline-wins', installed_path: '/plugins/inline-wins' }],
      {
        '/plugins/inline-wins': {
          plugin: { id: 'inline-wins', name: 'Inline Wins', version: '1.0.0', type: 'extra' },
          debate: {
            roles: [{ name: 'bull', prompt: 'Inline prompt!', prompt_file: 'BULL.md', block: false }],
          },
        },
      },
    );
    // Intercept fs.readFileSync so we can verify it's NOT called for prompt_file
    const readFileSyncSpy = fs.readFileSync as jest.Mock;

    const result = await service.getActiveDebateRoles();

    expect(result).not.toBeNull();
    expect(result![0].prompt).toBe('Inline prompt!');
    // readFileSync should NOT be called for BULL.md when prompt is present
    const bullCalls = (readFileSyncSpy.mock.calls as unknown[][]).filter(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes('BULL'),
    );
    expect(bullCalls).toHaveLength(0);
  });

  it('f6s3-a4.1e — path traversal in prompt_file is rejected (basename-only guard)', async () => {
    const readFileSyncSpy = (fs.readFileSync as jest.Mock).mockReturnValue('safe content');

    const service = makeDebateService(
      [{ id: 'traversal-test', installed_path: '/plugins/traversal-test' }],
      {
        '/plugins/traversal-test': {
          plugin: { id: 'traversal-test', name: 'Traversal Test', version: '1.0.0', type: 'extra' },
          debate: {
            roles: [{ name: 'bear', prompt_file: '../../etc/passwd', block: false }],
          },
        },
      },
    );

    await service.getActiveDebateRoles();

    // Must have used path.join('/plugins/traversal-test', 'passwd') — basename only
    const traversalCalls = (readFileSyncSpy.mock.calls as unknown[][]).filter(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes('etc/passwd'),
    );
    expect(traversalCalls).toHaveLength(0);

    readFileSyncSpy.mockReset();
    (fs.readFileSync as jest.Mock).mockImplementation(
      jest.requireActual<typeof import('fs')>('fs').readFileSync,
    );
  });

  it('f6s3-a4.1f — never throws', async () => {
    const service = makeDebateService(
      [{ id: 'throws-plugin', installed_path: '/plugins/throws-plugin' }],
      {
        '/plugins/throws-plugin': {
          plugin: { id: 'throws-plugin', name: 'Throws', version: '1.0.0', type: 'extra' },
          debate: THREE_DEBATE_ROLES,
        },
      },
    );
    // Override findActive to throw
    jest.spyOn(service, 'findActive').mockRejectedValue(new Error('DB error'));

    await expect(service.getActiveDebateRoles()).resolves.toBeNull();
  });
});
