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
import type { Alert } from '../alerts/alerts.service';
import type { AlertsService } from '../alerts/alerts.service';
import { REAL_EXECUTION_HALTED_KEY } from '../common/real-execution-halt.util';

function makeAlertsStub(active: Alert[] = []): AlertsService {
  return { getActive: jest.fn().mockResolvedValue(active) } as unknown as AlertsService;
}

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
    makeAlertsStub(),
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
  netns?: { mode: string; active: boolean };
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
    {
      getReadiness: jest.fn().mockReturnValue({ credentialPresent: deps.llmReady }),
    } as unknown as LlmService,
    {
      call: jest.fn().mockResolvedValue(deps.sandboxOk ? { ok: true } : null),
      getIsolationStatus: jest.fn().mockReturnValue(deps.netns ?? { mode: 'auto', active: true }),
    } as unknown as SandboxGateway,
    { findAll: jest.fn().mockResolvedValue(pluginRows) } as unknown as PluginsService,
    {} as unknown as PluginEventsService,
    {} as unknown as AuditService,
    { getRunStatus: jest.fn() } as unknown as CycleExecutorService,
    {} as unknown as ProviderGatewayService,
    makeAlertsStub(),
  );
}

describe('PanelService.doctor() — checks[] contract (panel-backend-drift Fix 2)', () => {
  it('all healthy: every check ok, plugins_active > 0', async () => {
    const svc = makeSvcForDoctor({
      plugins: { active: 2, total: 3 },
      sandboxOk: true,
      llmReady: true,
    });

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
    const svc = makeSvcForDoctor({
      plugins: { active: 1, total: 1 },
      sandboxOk: false,
      llmReady: true,
    });

    const result = await svc.doctor();

    expect(result.sandbox_reachable).toBe(false);
    const byName = Object.fromEntries(result.checks.map((c) => [c.name, c]));
    expect(byName['sandbox_reachable']).toMatchObject({ ok: false, level: 'error' });
  });

  it('llm not ready: check reports error level', async () => {
    const svc = makeSvcForDoctor({
      plugins: { active: 1, total: 1 },
      sandboxOk: true,
      llmReady: false,
    });

    const result = await svc.doctor();

    expect(result.llm_ready).toBe(false);
    const byName = Object.fromEntries(result.checks.map((c) => [c.name, c]));
    expect(byName['llm_ready']).toMatchObject({ ok: false, level: 'error' });
  });

  it('no active plugins (but registered > 0): plugins_active check reports warn level', async () => {
    const svc = makeSvcForDoctor({
      plugins: { active: 0, total: 4 },
      sandboxOk: true,
      llmReady: true,
    });

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

// ── doctor() — sandbox_netns check (panel-honesty Fix 2) ────────────────────────

describe('PanelService.doctor() — sandbox_netns check (panel-honesty Fix 2)', () => {
  it('mode=auto, active=true → ok', async () => {
    const svc = makeSvcForDoctor({
      plugins: { active: 1, total: 1 },
      sandboxOk: true,
      llmReady: true,
      netns: { mode: 'auto', active: true },
    });

    const result = await svc.doctor();
    const byName = Object.fromEntries(result.checks.map((c) => [c.name, c]));
    expect(byName['sandbox_netns']).toMatchObject({ ok: true, level: 'ok' });
  });

  it('mode=auto, active=false → warn (silent degrade, now visible)', async () => {
    const svc = makeSvcForDoctor({
      plugins: { active: 1, total: 1 },
      sandboxOk: true,
      llmReady: true,
      netns: { mode: 'auto', active: false },
    });

    const result = await svc.doctor();
    const byName = Object.fromEntries(result.checks.map((c) => [c.name, c]));
    expect(byName['sandbox_netns']).toMatchObject({ ok: false, level: 'warn' });
  });

  it('mode=off, active=false → ok (explicit operator choice, not a failure)', async () => {
    const svc = makeSvcForDoctor({
      plugins: { active: 1, total: 1 },
      sandboxOk: true,
      llmReady: true,
      netns: { mode: 'off', active: false },
    });

    const result = await svc.doctor();
    const byName = Object.fromEntries(result.checks.map((c) => [c.name, c]));
    expect(byName['sandbox_netns']).toMatchObject({ ok: false, level: 'ok' });
  });

  it('mode=require, active=false → error (defensive — should not actually occur)', async () => {
    const svc = makeSvcForDoctor({
      plugins: { active: 1, total: 1 },
      sandboxOk: true,
      llmReady: true,
      netns: { mode: 'require', active: false },
    });

    const result = await svc.doctor();
    const byName = Object.fromEntries(result.checks.map((c) => [c.name, c]));
    expect(byName['sandbox_netns']).toMatchObject({ ok: false, level: 'error' });
  });

  it('mode=require, active=true → ok', async () => {
    const svc = makeSvcForDoctor({
      plugins: { active: 1, total: 1 },
      sandboxOk: true,
      llmReady: true,
      netns: { mode: 'require', active: true },
    });

    const result = await svc.doctor();
    const byName = Object.fromEntries(result.checks.map((c) => [c.name, c]));
    expect(byName['sandbox_netns']).toMatchObject({ ok: true, level: 'ok' });
  });

  it('preserves every previously-existing check alongside the new sandbox_netns check', async () => {
    const svc = makeSvcForDoctor({
      plugins: { active: 1, total: 1 },
      sandboxOk: true,
      llmReady: true,
      netns: { mode: 'auto', active: true },
    });

    const result = await svc.doctor();
    const cmp = (a: string, b: string) => a.localeCompare(b);
    const names = result.checks.map((c) => c.name).sort(cmp);
    expect(names).toEqual(
      [
        'sandbox_reachable',
        'llm_ready',
        'plugins_active',
        'real_execution_halted',
        'sandbox_netns',
      ].sort(cmp),
    );
  });
});

// ── checkUniverseSymbol() — panel-backend-drift Fix 3: real data verification ──

function makeSvcForUniverse(
  gateway: Partial<Pick<ProviderGatewayService, 'getDefaultProvider' | 'getOhlcv'>>,
  cfgEntries: { key: string; value: string }[] = [],
): PanelService {
  const configEntry = {
    findMany: jest.fn().mockResolvedValue(cfgEntries),
  };

  return new PanelService(
    { configEntry } as unknown as PrismaService,
    {} as unknown as AgentsService,
    {} as unknown as LlmService,
    {} as unknown as SandboxGateway,
    {} as unknown as PluginsService,
    {} as unknown as PluginEventsService,
    {} as unknown as AuditService,
    { getRunStatus: jest.fn() } as unknown as CycleExecutorService,
    gateway as unknown as ProviderGatewayService,
    makeAlertsStub(),
  );
}

describe('PanelService.checkUniverseSymbol() — real OHLCV verification (Fix 3)', () => {
  it('success: fetches OHLCV via the default provider and returns velas/ultimo_cierre/proveedor', async () => {
    const bars = Array.from({ length: 30 }, (_, i) => ({
      ts: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
      open: 100 + i,
      high: 101 + i,
      low: 99 + i,
      close: 100.5 + i,
      volume: 1000,
    }));
    const gateway = {
      getDefaultProvider: jest.fn().mockReturnValue({ plugin: { id: 'alpaca' } }),
      getOhlcv: jest.fn().mockResolvedValue(bars),
    };
    const svc = makeSvcForUniverse(gateway);

    const result = await svc.checkUniverseSymbol('aapl');

    expect(gateway.getDefaultProvider).toHaveBeenCalled();
    expect(gateway.getOhlcv).toHaveBeenCalledWith('alpaca', 'AAPL', '1d', 30);
    expect(result).toMatchObject({
      ok: true,
      symbol: 'AAPL',
      velas: 30,
      ultimo_cierre: bars[29].close,
      proveedor: 'alpaca',
    });
  });

  it('failure: gateway throws → ok:false with detail, never rethrows', async () => {
    const gateway = {
      getDefaultProvider: jest.fn().mockReturnValue({ plugin: { id: 'alpaca' } }),
      getOhlcv: jest.fn().mockRejectedValue(new Error('boom: provider unreachable')),
    };
    const svc = makeSvcForUniverse(gateway);

    const result = await svc.checkUniverseSymbol('MSFT');

    expect(result.ok).toBe(false);
    expect(result.symbol).toBe('MSFT');
    expect(typeof result.detail).toBe('string');
    expect(result.detail).toContain('boom');
  });

  it('failure: gateway returns empty bars → ok:false with detail', async () => {
    const gateway = {
      getDefaultProvider: jest.fn().mockReturnValue({ plugin: { id: 'alpaca' } }),
      getOhlcv: jest.fn().mockResolvedValue([]),
    };
    const svc = makeSvcForUniverse(gateway);

    const result = await svc.checkUniverseSymbol('TSLA');

    expect(result.ok).toBe(false);
    expect(result.symbol).toBe('TSLA');
    expect(typeof result.detail).toBe('string');
  });

  it('failure: no default provider available → ok:false with detail, no crash', async () => {
    const gateway = {
      getDefaultProvider: jest.fn().mockReturnValue(null),
      getOhlcv: jest.fn(),
    };
    const svc = makeSvcForUniverse(gateway);

    const result = await svc.checkUniverseSymbol('BTC');

    expect(result.ok).toBe(false);
    expect(gateway.getOhlcv).not.toHaveBeenCalled();
    expect(typeof result.detail).toBe('string');
  });

  it('preserves existing registered/meta fields from the universe config', async () => {
    const gateway = {
      getDefaultProvider: jest.fn().mockReturnValue({ plugin: { id: 'alpaca' } }),
      getOhlcv: jest.fn().mockResolvedValue([
        {
          ts: '2026-01-01T00:00:00.000Z',
          open: 1,
          high: 1,
          low: 1,
          close: 42,
          volume: 1,
        },
      ]),
    };
    const svc = makeSvcForUniverse(gateway, [
      { key: 'universe', value: JSON.stringify({ AAPL: { kind: 'equity' } }) },
    ]);

    const result = await svc.checkUniverseSymbol('aapl');

    expect(result.registered).toBe(true);
    expect(result.meta).toEqual({ kind: 'equity' });
    expect(result.ok).toBe(true);
  });
});

// ── getNotifications() — surfaces AlertsService active alerts (panel-honesty) ──

function makeAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: 'alert-1',
    ts: new Date('2026-01-01T00:00:00.000Z'),
    type: 'BROKER_DRIFT',
    severity: 'CRITICAL',
    symbol: null,
    message: 'broker drift detected',
    meta: null,
    resolved: false,
    ...overrides,
  };
}

function makeSvcForNotifications(
  alertsSvc: AlertsService,
  cfgNotifs: { level: string; title: string; source: string; body: string; ts: string }[] = [],
): PanelService {
  const configEntry = {
    findUnique: jest.fn().mockImplementation(({ where: { key } }: { where: { key: string } }) => {
      if (key === 'notifications') {
        return Promise.resolve({ key, value: JSON.stringify(cfgNotifs) });
      }
      return Promise.resolve(null);
    }),
  };

  return new PanelService(
    { configEntry } as unknown as PrismaService,
    {} as unknown as AgentsService,
    {
      getReadiness: jest.fn().mockReturnValue({ credentialPresent: true }),
    } as unknown as LlmService,
    {
      call: jest.fn().mockResolvedValue({ ok: true }),
      getIsolationStatus: jest.fn().mockReturnValue({ mode: 'auto', active: true }),
    } as unknown as SandboxGateway,
    {
      findAll: jest.fn().mockResolvedValue([{ id: 'p1', active: true }]),
    } as unknown as PluginsService,
    {} as unknown as PluginEventsService,
    {} as unknown as AuditService,
    { getRunStatus: jest.fn() } as unknown as CycleExecutorService,
    {} as unknown as ProviderGatewayService,
    alertsSvc,
  );
}

describe('PanelService.getNotifications() — surfaces active alerts (panel-honesty)', () => {
  it('maps a CRITICAL active alert to level=error, source=alerts, and counts it in n_errors', async () => {
    const alertsSvc = makeAlertsStub([makeAlert({ severity: 'CRITICAL', message: 'drift!' })]);
    const svc = makeSvcForNotifications(alertsSvc);

    const result = await svc.getNotifications();

    const alertItem = result.items.find((i) => i.source === 'alerts');
    expect(alertItem).toMatchObject({ level: 'error', source: 'alerts', body: 'drift!' });
    expect(result.n_errors).toBeGreaterThanOrEqual(1);
  });

  it('maps a WARN-ish active alert to level=warn and counts it in n_warnings', async () => {
    const alertsSvc = makeAlertsStub([
      makeAlert({ severity: 'WARN' as Alert['severity'], message: 'careful' }),
    ]);
    const svc = makeSvcForNotifications(alertsSvc);

    const result = await svc.getNotifications();

    const alertItem = result.items.find((i) => i.source === 'alerts');
    expect(alertItem).toMatchObject({ level: 'warn', source: 'alerts' });
    expect(result.n_warnings).toBeGreaterThanOrEqual(1);
  });

  it('maps any other severity to level=info', async () => {
    const alertsSvc = makeAlertsStub([makeAlert({ severity: 'LOW', message: 'fyi' })]);
    const svc = makeSvcForNotifications(alertsSvc);

    const result = await svc.getNotifications();

    const alertItem = result.items.find((i) => i.source === 'alerts');
    expect(alertItem).toMatchObject({ level: 'info', source: 'alerts' });
  });

  it('only queries active (unresolved) alerts — never getRecent', async () => {
    const getActive = jest.fn().mockResolvedValue([]);
    const getRecent = jest.fn();
    const alertsSvc = { getActive, getRecent } as unknown as AlertsService;
    const svc = makeSvcForNotifications(alertsSvc);

    await svc.getNotifications();

    expect(getActive).toHaveBeenCalledTimes(1);
    expect(getRecent).not.toHaveBeenCalled();
  });

  it('excludes resolved alerts (getActive never returns resolved=true entries)', async () => {
    const alertsSvc = makeAlertsStub([]);
    const svc = makeSvcForNotifications(alertsSvc);

    const result = await svc.getNotifications();

    expect(result.items.find((i) => i.source === 'alerts')).toBeUndefined();
  });

  it('fail-soft: if AlertsService.getActive throws, getNotifications still returns previous behavior without throwing', async () => {
    const alertsSvc = {
      getActive: jest.fn().mockRejectedValue(new Error('db down')),
    } as unknown as AlertsService;
    const svc = makeSvcForNotifications(alertsSvc);

    const result = await svc.getNotifications();

    expect(result.items.find((i) => i.source === 'alerts')).toBeUndefined();
    expect(typeof result.n_errors).toBe('number');
    expect(typeof result.n_warnings).toBe('number');
  });

  it('does not change the existing item shape ({level, title, source, body, ts})', async () => {
    const alertsSvc = makeAlertsStub([makeAlert()]);
    const svc = makeSvcForNotifications(alertsSvc);

    const result = await svc.getNotifications();
    const alertItem = result.items.find((i) => i.source === 'alerts');

    const cmp = (a: string, b: string) => a.localeCompare(b);
    expect(Object.keys(alertItem!).sort(cmp)).toEqual(
      ['level', 'title', 'source', 'body', 'ts'].sort(cmp),
    );
  });
});
