import * as path from 'path';
import { PluginsService } from './plugins.service';
import type { PluginManifest } from './manifest';
import type { PrismaService } from '../prisma/prisma.service';
import type { PluginEventsService } from './plugin-events.service';
import type { ConfigService } from '@nestjs/config';
import type { KvService } from '../common/kv.service';

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

  it('no snapshot → {ok:false, reason:"no_snapshot"}, no writeSkillContent, no audit', async () => {
    const { service, audit, writeSkillContentMock } = makeServiceWithKv({
      kvValue: null,
    });

    const result = await service.revertSkill('test-skill');

    expect(result).toEqual({ ok: false, reason: 'no_snapshot' });
    expect(writeSkillContentMock).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('no snapshot (empty JSON array) → {ok:false, reason:"no_snapshot"}', async () => {
    const { service, audit, writeSkillContentMock } = makeServiceWithKv({
      kvValue: JSON.stringify([]),
    });

    const result = await service.revertSkill('test-skill');

    expect(result).toEqual({ ok: false, reason: 'no_snapshot' });
    expect(writeSkillContentMock).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('with snapshot: pops latest, calls writeSkillContent with that body, audits skill_reverted, persists shrunken array', async () => {
    const snapshots = ['body-v1', 'body-v2', 'body-v3'];
    const { service, kv, audit, writeSkillContentMock } = makeServiceWithKv({
      kvValue: JSON.stringify(snapshots),
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
});
