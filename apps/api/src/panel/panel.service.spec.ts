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
