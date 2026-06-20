/**
 * F6-S2 PR2 — No-circular-dependency boot test.
 *
 * Verifies that LongTermMemoryModule + AgentsModule + SnapshotModule compile
 * together in a real NestJS Test.createTestingModule without any circular-dependency
 * warning. LongTermMemoryModule is a leaf (PrismaModule only), so:
 *   AgentsModule → LongTermMemoryModule (leaf)
 *   SnapshotModule → LongTermMemoryModule (leaf)
 * are both leaf edges — no cycle possible.
 *
 * Pattern mirrors cycle-executor.module.boot.spec.ts (F5-s2).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { AgentsModule } from '../../agents/agents.module';
import { SnapshotModule } from '../../snapshot/snapshot.module';
import { LongTermMemoryModule } from '../long-term-memory.module';

import { PrismaService } from '../../prisma/prisma.service';
import { LlmService } from '../../llm/llm.service';
import { SandboxGateway } from '../../sandbox/sandbox.gateway';
import { KvService } from '../../common/kv.service';
import { NotifierBridge } from '../../notifier/notifier-bridge';
import { PluginsService } from '../../plugins/plugins.service';
import { PluginEventsService } from '../../plugins/plugin-events.service';
import { AuditService } from '../../audit/audit.service';
import { LongTermMemoryService } from '../long-term-memory.service';

// ── Leaf mocks ────────────────────────────────────────────────────────────────

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
  navSnapshot: {
    create: jest.fn().mockResolvedValue({}),
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn().mockResolvedValue(null),
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
  $executeRaw: jest.fn().mockResolvedValue(0),
  $queryRaw: jest.fn().mockResolvedValue([]),
  $transaction: jest.fn().mockResolvedValue(undefined),
};

const configSvcMock = {
  get: jest.fn().mockImplementation((_key: string, defaultVal?: unknown) => defaultVal),
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
  getPluginStage: jest.fn().mockReturnValue('post'),
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
  getActiveDecisionPrompt: jest.fn().mockResolvedValue(null),
  onApplicationBootstrap: jest.fn(),
};

const pluginEventsMock = {
  emit: jest.fn(),
  on: jest.fn(),
};

const auditMock = {
  log: jest.fn().mockResolvedValue(undefined),
};

const ltmMock = {
  prefetch: jest.fn().mockResolvedValue([]),
  record: jest.fn().mockResolvedValue(undefined),
  updateOutcome: jest.fn().mockResolvedValue(undefined),
  promote: jest.fn().mockResolvedValue(undefined),
  onModuleInit: jest.fn().mockResolvedValue(undefined),
};

// ── Boot test ─────────────────────────────────────────────────────────────────

describe('F6-S2 PR2 — LTM+Agents+Snapshot module boot (no circular deps)', () => {
  let moduleRef: TestingModule;
  const circularDepWarnings: string[] = [];

  beforeAll(async () => {
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
        LongTermMemoryModule,
        AgentsModule,
        SnapshotModule,
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
      .overrideProvider(LongTermMemoryService)
      .useValue(ltmMock)
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

  it('LongTermMemoryService is resolvable', () => {
    const svc = moduleRef.get(LongTermMemoryService);
    expect(svc).toBeDefined();
  });

  it('no circular-dependency NestJS warnings emitted', () => {
    expect(circularDepWarnings).toHaveLength(0);
  });
});
