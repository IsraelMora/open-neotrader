/**
 * Phase 3 — Module boot test (F5 Slice 2).
 *
 * Verifies that the combined module graph (PanelModule + CycleExecutorModule +
 * CycleSchedulerModule + AgentsModule) compiles and initialises without any
 * NestJS "circular dependency" error.
 *
 * All I/O leaf providers are overridden with trivial mocks so the test is hermetic.
 * Pattern: import real modules, override every leaf service via overrideProvider.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { CycleExecutorModule } from './cycle-executor.module';
import { CycleExecutorService } from './cycle-executor.service';
import { PanelModule } from '../panel/panel.module';
import { CycleSchedulerModule } from '../scheduler/cycle-scheduler.module';
import { AgentsModule } from '../agents/agents.module';

// ── Import all provider classes we need to mock ───────────────────────────────
import { PrismaService } from '../prisma/prisma.service';
import { LlmService } from '../llm/llm.service';
import { SandboxGateway } from '../sandbox/sandbox.gateway';
import { KvService } from '../common/kv.service';
import { NotifierBridge } from '../notifier/notifier-bridge';
import { PluginsService } from '../plugins/plugins.service';
import { PluginEventsService } from '../plugins/plugin-events.service';
import { AuditService } from '../audit/audit.service';
import { AgentsService } from '../agents/agents.service';
import { PanelService } from '../panel/panel.service';
import { CycleSchedulerService } from '../scheduler/cycle-scheduler.service';

// ── Leaf-level service mocks ──────────────────────────────────────────────────

const prismaMock = {
  configEntry: {
    findMany: jest.fn().mockResolvedValue([]),
    findUnique: jest.fn().mockResolvedValue(null),
    upsert: jest.fn().mockResolvedValue({}),
    deleteMany: jest.fn().mockResolvedValue({}),
  },
  portfolio: { findMany: jest.fn().mockResolvedValue([]) },
  plugin: {
    findMany: jest.fn().mockResolvedValue([]),
    findUnique: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({}),
    upsert: jest.fn().mockResolvedValue({}),
    delete: jest.fn().mockResolvedValue({}),
    deleteMany: jest.fn().mockResolvedValue({}),
  },
  auditLog: {
    create: jest.fn().mockResolvedValue({}),
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
  },
  contextEntry: {
    findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({}),
    deleteMany: jest.fn().mockResolvedValue({}),
    count: jest.fn().mockResolvedValue(0),
  },
  alert: {
    findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({}),
    updateMany: jest.fn().mockResolvedValue({}),
    deleteMany: jest.fn().mockResolvedValue({}),
    count: jest.fn().mockResolvedValue(0),
  },
  portfolioSnapshot: {
    findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({}),
    findFirst: jest.fn().mockResolvedValue(null),
    deleteMany: jest.fn().mockResolvedValue({}),
    count: jest.fn().mockResolvedValue(0),
  },
  pretestRun: {
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({}),
    count: jest.fn().mockResolvedValue(0),
  },
  $connect: jest.fn(),
  $disconnect: jest.fn(),
};

const configSvcMock = {
  get: jest.fn().mockImplementation((key: string, defaultVal?: unknown) => defaultVal),
  getOrThrow: jest.fn().mockReturnValue('mock'),
};

const llmMock = {
  complete: jest.fn().mockResolvedValue({
    text: '',
    tool_calls: [],
    backend: 'api',
    skills_read: [],
    skills_written: [],
  }),
};

const sandboxMock = {
  call: jest.fn().mockResolvedValue({ ok: true }),
  runCycle: jest.fn().mockResolvedValue({ ok: true }),
  callPlugin: jest.fn().mockResolvedValue({ ok: true }),
};

const kvMock = {
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
  delete: jest.fn().mockResolvedValue(undefined),
};

const notifierMock = {
  notify: jest.fn().mockResolvedValue(undefined),
  send: jest.fn().mockResolvedValue(undefined),
  notifyText: jest.fn().mockResolvedValue(undefined),
};

const pluginsServiceMock = {
  findActive: jest.fn().mockResolvedValue([]),
  findAll: jest.fn().mockResolvedValue([]),
  getManifest: jest.fn().mockReturnValue({}),
  getSkillsMetadata: jest.fn().mockResolvedValue([]),
  getProviderTools: jest.fn().mockResolvedValue([]),
  onApplicationBootstrap: jest.fn(),
};

const pluginEventsMock = {
  emit: jest.fn(),
  on: jest.fn(),
};

const auditMock = {
  log: jest.fn().mockResolvedValue(undefined),
};

const agentsMock = {
  runCycle: jest.fn().mockResolvedValue({ decisions: [], llm_response: null, llm_text: '' }),
  runReflectionTurn: jest
    .fn()
    .mockResolvedValue({ skipped: false, cycle_id: 'x', skills_written: 0 }),
  runGovernedTurn: jest.fn().mockResolvedValue({ text: '', tool_calls: [], backend: 'api' }),
};

const panelMock = {
  appendLog: jest.fn().mockResolvedValue(undefined),
  getStatus: jest.fn().mockResolvedValue({ active_plugins: [], portfolios: {}, last_run: null }),
  getRunStatus: jest.fn().mockReturnValue({ running: false, last: null }),
  getConfig: jest.fn().mockResolvedValue({}),
  saveConfig: jest.fn().mockResolvedValue({}),
  doctor: jest.fn().mockResolvedValue({ ok: true }),
};

const schedulerMock = {
  getConfig: jest
    .fn()
    .mockResolvedValue({ enabled: false, override_interval_ms: null, run_count: 0 }),
  getStatus: jest.fn().mockResolvedValue({}),
  onModuleInit: jest.fn(),
  onModuleDestroy: jest.fn(),
};

// ── Boot test ─────────────────────────────────────────────────────────────────

describe('CycleExecutorModule — module boot (Phase 3)', () => {
  let moduleRef: TestingModule;
  const circularDepWarnings: string[] = [];

  beforeAll(async () => {
    // Capture NestJS Logger output to detect circular-dependency warnings
    const originalWarn = console.warn.bind(console);
    jest.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      const msg = args.join(' ');
      if (msg.toLowerCase().includes('circular dependency')) {
        circularDepWarnings.push(msg);
      }
      originalWarn(...args);
    });

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        AgentsModule,
        PanelModule,
        CycleExecutorModule,
        CycleSchedulerModule,
      ],
    })
      .overrideProvider(ConfigService)
      .useValue(configSvcMock)
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .overrideProvider(LlmService)
      .useValue(llmMock)
      .overrideProvider(SandboxGateway)
      .useValue(sandboxMock)
      .overrideProvider(KvService)
      .useValue(kvMock)
      .overrideProvider(NotifierBridge)
      .useValue(notifierMock)
      .overrideProvider(PluginsService)
      .useValue(pluginsServiceMock)
      .overrideProvider(PluginEventsService)
      .useValue(pluginEventsMock)
      .overrideProvider(AuditService)
      .useValue(auditMock)
      .overrideProvider(AgentsService)
      .useValue(agentsMock)
      .overrideProvider(PanelService)
      .useValue(panelMock)
      .overrideProvider(CycleSchedulerService)
      .useValue(schedulerMock)
      .compile();
  });

  afterAll(async () => {
    if (moduleRef) {
      await moduleRef.close();
    }
    jest.restoreAllMocks();
  });

  it('module compiles without error', () => {
    expect(moduleRef).toBeDefined();
  });

  it('CycleExecutorService is resolvable from the module', () => {
    const service = moduleRef.get(CycleExecutorService);
    expect(service).toBeDefined();
    expect(service).toBeInstanceOf(CycleExecutorService);
  });

  it('CycleExecutorService.getRunStatus() returns initial state', () => {
    const service = moduleRef.get(CycleExecutorService);
    const status = service.getRunStatus();
    expect(status.running).toBe(false);
    expect(status.last).toBeNull();
  });

  it('no circular-dependency NestJS warnings were emitted', () => {
    // NestJS emits a "circular dependency" warning when forwardRef is missing.
    // Properly wired forwardRef pairs compile silently.
    expect(circularDepWarnings).toHaveLength(0);
  });
});
