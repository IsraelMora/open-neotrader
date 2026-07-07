/**
 * PanelService unit tests — config, status, chat and remaining facade methods.
 *
 * NOTE: reflectNow / runCycle / executeCycle tests have been MOVED to
 * cycle-executor.service.spec.ts (F5 Slice 2). This file covers what remains
 * in PanelService: config, getStatus, chat, doctor, logs, portfolios, etc.
 *
 * No reflectNow tests remain here — they now live in CycleExecutorService.
 */
import { PanelService } from './panel.service';
import type { PluginsService, ProviderTool } from '../plugins/plugins.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AgentsService } from '../agents/agents.service';
import type { LlmService } from '../llm/llm.service';
import type { SandboxGateway } from '../sandbox/sandbox.gateway';
import type { PluginEventsService } from '../plugins/plugin-events.service';
import type { AuditService } from '../audit/audit.service';
import type { CycleExecutorService } from '../cycle/cycle-executor.service';
import type { ProviderGatewayService } from '../providers/provider-gateway.service';
import { REAL_EXECUTION_HALTED_KEY } from '../common/real-execution-halt.util';

// Placeholder: real tests for getConfig/saveConfig/chat can be added here.
// For now this file confirms the module is importable and the moved tests are gone.

describe('PanelService — remaining facade (post F5 Slice 2)', () => {
  it('PanelService class exists and is a function (importable)', () => {
    expect(typeof PanelService).toBe('function');
  });
});

// ── getSkills() — BUG 1 contract ─────────────────────────────────────────────

function makePluginsStub(tools: ProviderTool[]): PluginsService {
  return {
    getProviderTools: jest.fn().mockResolvedValue(tools),
  } as unknown as PluginsService;
}

function makeSvcForSkills(plugins: PluginsService): PanelService {
  return new PanelService(
    {} as unknown as PrismaService,
    {} as unknown as AgentsService,
    {} as unknown as LlmService,
    {} as unknown as SandboxGateway,
    plugins,
    {} as unknown as PluginEventsService,
    {} as unknown as AuditService,
    { getRunStatus: jest.fn() } as unknown as CycleExecutorService,
    {} as unknown as ProviderGatewayService,
  );
}

describe('PanelService.getSkills() — returns {from_plugins, n_plugins} from provider tools', () => {
  it('transforms provider tools into from_plugins items with {name, plugin, key}', async () => {
    const tools: ProviderTool[] = [
      {
        plugin_id: 'risk-manager',
        name: 'risk-manager__check_risk',
        description: 'Check risk',
        input_schema: { type: 'object', properties: {} },
      },
      {
        plugin_id: 'risk-manager',
        name: 'risk-manager__get_limits',
        description: 'Get limits',
        input_schema: { type: 'object', properties: {} },
      },
      {
        plugin_id: 'news-reader',
        name: 'news-reader__fetch_news',
        description: 'Fetch news',
        input_schema: { type: 'object', properties: {} },
      },
    ];

    const svc = makeSvcForSkills(makePluginsStub(tools));
    const result = await svc.getSkills();

    expect(result).toEqual({
      from_plugins: [
        { name: 'check_risk', plugin: 'risk-manager', key: 'risk-manager.check_risk' },
        { name: 'get_limits', plugin: 'risk-manager', key: 'risk-manager.get_limits' },
        { name: 'fetch_news', plugin: 'news-reader', key: 'news-reader.fetch_news' },
      ],
      n_plugins: 2,
    });
  });

  it('returns empty from_plugins and n_plugins=0 when no active provider tools', async () => {
    const svc = makeSvcForSkills(makePluginsStub([]));
    const result = await svc.getSkills();

    expect(result).toEqual({ from_plugins: [], n_plugins: 0 });
  });

  it('counts n_plugins as distinct plugin_id values, not total tool count', async () => {
    const tools: ProviderTool[] = [
      {
        plugin_id: 'alpha',
        name: 'alpha__fn1',
        description: 'fn1',
        input_schema: { type: 'object', properties: {} },
      },
      {
        plugin_id: 'alpha',
        name: 'alpha__fn2',
        description: 'fn2',
        input_schema: { type: 'object', properties: {} },
      },
      {
        plugin_id: 'alpha',
        name: 'alpha__fn3',
        description: 'fn3',
        input_schema: { type: 'object', properties: {} },
      },
    ];

    const svc = makeSvcForSkills(makePluginsStub(tools));
    const result = await svc.getSkills();

    expect(result.n_plugins).toBe(1);
    expect(result.from_plugins).toHaveLength(3);
  });
});

// ── doctor() — panel-backend-drift Fix 2: real `checks` array ───────────────────

interface DoctorDeps {
  plugins: { active: number; total: number };
  sandboxOk: boolean;
  llmReady: boolean;
  halted?: boolean;
}

function makeSvcForDoctor(deps: DoctorDeps): PanelService {
  const pluginRows = [
    ...Array.from({ length: deps.plugins.active }, (_, i) => ({
      id: `active-${i}`,
      active: true,
    })),
    ...Array.from({ length: deps.plugins.total - deps.plugins.active }, (_, i) => ({
      id: `inactive-${i}`,
      active: false,
    })),
  ];

  const configEntry = {
    findUnique: jest.fn().mockImplementation(({ where: { key } }: { where: { key: string } }) => {
      if (key === REAL_EXECUTION_HALTED_KEY) {
        return Promise.resolve(
          deps.halted === undefined ? null : { key, value: deps.halted ? 'true' : 'false' },
        );
      }
      return Promise.resolve(null);
    }),
  };

  return new PanelService(
    { configEntry } as unknown as PrismaService,
    {} as unknown as AgentsService,
    { getReadiness: jest.fn().mockReturnValue({ credentialPresent: deps.llmReady }) } as unknown as LlmService,
    {
      call: jest.fn().mockResolvedValue(deps.sandboxOk ? { ok: true } : null),
    } as unknown as SandboxGateway,
    { findAll: jest.fn().mockResolvedValue(pluginRows) } as unknown as PluginsService,
    {} as unknown as PluginEventsService,
    {} as unknown as AuditService,
    { getRunStatus: jest.fn() } as unknown as CycleExecutorService,
    {} as unknown as ProviderGatewayService,
  );
}

describe('PanelService.doctor() — checks[] contract (panel-backend-drift Fix 2)', () => {
  it('all healthy: every check ok, plugins_active > 0', async () => {
    const svc = makeSvcForDoctor({ plugins: { active: 2, total: 3 }, sandboxOk: true, llmReady: true });

    const result = await svc.doctor();

    // Existing fields stay exactly as-is.
    expect(result.ok).toBe(true);
    expect(result.plugins_registered).toBe(3);
    expect(result.plugins_active).toBe(2);
    expect(result.sandbox_reachable).toBe(true);
    expect(result.llm_ready).toBe(true);

    expect(Array.isArray(result.checks)).toBe(true);
    const byName = Object.fromEntries(result.checks.map((c) => [c.name, c]));
    expect(byName['sandbox_reachable']).toMatchObject({ ok: true, level: 'ok' });
    expect(byName['llm_ready']).toMatchObject({ ok: true, level: 'ok' });
    expect(byName['plugins_active']).toMatchObject({ ok: true, level: 'ok' });
  });

  it('sandbox unreachable: check reports error level', async () => {
    const svc = makeSvcForDoctor({ plugins: { active: 1, total: 1 }, sandboxOk: false, llmReady: true });

    const result = await svc.doctor();

    expect(result.sandbox_reachable).toBe(false);
    const byName = Object.fromEntries(result.checks.map((c) => [c.name, c]));
    expect(byName['sandbox_reachable']).toMatchObject({ ok: false, level: 'error' });
  });

  it('llm not ready: check reports error level', async () => {
    const svc = makeSvcForDoctor({ plugins: { active: 1, total: 1 }, sandboxOk: true, llmReady: false });

    const result = await svc.doctor();

    expect(result.llm_ready).toBe(false);
    const byName = Object.fromEntries(result.checks.map((c) => [c.name, c]));
    expect(byName['llm_ready']).toMatchObject({ ok: false, level: 'error' });
  });

  it('no active plugins (but registered > 0): plugins_active check reports warn level', async () => {
    const svc = makeSvcForDoctor({ plugins: { active: 0, total: 4 }, sandboxOk: true, llmReady: true });

    const result = await svc.doctor();

    expect(result.plugins_active).toBe(0);
    const byName = Object.fromEntries(result.checks.map((c) => [c.name, c]));
    expect(byName['plugins_active']).toMatchObject({ ok: false, level: 'warn' });
  });

  it('real_execution.halted=true: check reports warn level with detail', async () => {
    const svc = makeSvcForDoctor({
      plugins: { active: 1, total: 1 },
      sandboxOk: true,
      llmReady: true,
      halted: true,
    });

    const result = await svc.doctor();

    const byName = Object.fromEntries(result.checks.map((c) => [c.name, c]));
    expect(byName['real_execution_halted']).toMatchObject({ ok: false, level: 'warn' });
  });

  it('real_execution.halted=false (default): check reports ok level', async () => {
    const svc = makeSvcForDoctor({
      plugins: { active: 1, total: 1 },
      sandboxOk: true,
      llmReady: true,
      halted: false,
    });

    const result = await svc.doctor();

    const byName = Object.fromEntries(result.checks.map((c) => [c.name, c]));
    expect(byName['real_execution_halted']).toMatchObject({ ok: true, level: 'ok' });
  });
});
