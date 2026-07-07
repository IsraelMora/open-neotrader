import { ConflictException } from '@nestjs/common';
import { CycleExecutorService } from './cycle-executor.service';
import type { AgentsService, ReflectionTurnResult } from '../agents/agents.service';
import type { SandboxGateway } from '../sandbox/sandbox.gateway';
import type { PluginsService } from '../plugins/plugins.service';
import type { PluginEventsService } from '../plugins/plugin-events.service';
import type { AuditService } from '../audit/audit.service';
import type { PanelService } from '../panel/panel.service';
import type { SnapshotService } from '../snapshot/snapshot.service';

// ── Stubs ─────────────────────────────────────────────────────────────────────

function makeAgentsStub(opts: {
  reflectNowResult?: ReflectionTurnResult;
  reflectNowThrows?: boolean;
  runCycleMock?: jest.Mock;
}): jest.Mocked<Pick<AgentsService, 'runReflectionTurn' | 'runCycle'>> {
  return {
    runReflectionTurn: opts.reflectNowThrows
      ? jest.fn().mockRejectedValue(new Error('reflection failed'))
      : jest
          .fn()
          .mockResolvedValue(
            opts.reflectNowResult ?? { skipped: false, cycle_id: 'ref-001', skills_written: 0 },
          ),
    runCycle:
      opts.runCycleMock ??
      jest.fn().mockResolvedValue({ decisions: [], llm_response: null, llm_text: '' }),
  };
}

function makeSandboxStub(
  opts: {
    runCycleOk?: boolean;
    runCycleError?: string;
  } = {},
): jest.Mocked<Pick<SandboxGateway, 'runCycle'>> {
  return {
    runCycle: jest
      .fn()
      .mockResolvedValue({ ok: opts.runCycleOk ?? true, error: opts.runCycleError }),
  };
}

function makePluginsStub(
  activePlugins: Array<{ id: string }> = [],
): jest.Mocked<Pick<PluginsService, 'findActive'>> {
  return {
    findActive: jest.fn().mockResolvedValue(activePlugins),
  };
}

function makePluginEventsStub(): jest.Mocked<Pick<PluginEventsService, 'emit'>> {
  return { emit: jest.fn() };
}

function makeAuditStub(): jest.Mocked<Pick<AuditService, 'log'>> {
  return { log: jest.fn().mockResolvedValue(undefined) };
}

function makePanelStub(): jest.Mocked<Pick<PanelService, 'appendLog'>> {
  return { appendLog: jest.fn().mockResolvedValue(undefined) };
}

function makeSnapshotStub(
  opts: { takeSnapshotThrows?: boolean } = {},
): jest.Mocked<Pick<SnapshotService, 'takeSnapshot'>> {
  return {
    takeSnapshot: opts.takeSnapshotThrows
      ? jest.fn().mockRejectedValue(new Error('snapshot failed'))
      : jest.fn().mockResolvedValue(null),
  };
}

/**
 * Build a minimal CycleExecutorService for unit tests.
 * We inject only what the tested methods need.
 */
function makeCycleExecutorService(opts: {
  cycleRunning?: boolean;
  agentsStub?: ReturnType<typeof makeAgentsStub>;
  sandboxStub?: ReturnType<typeof makeSandboxStub>;
  pluginsStub?: ReturnType<typeof makePluginsStub>;
  pluginEventsStub?: ReturnType<typeof makePluginEventsStub>;
  auditStub?: ReturnType<typeof makeAuditStub>;
  panelStub?: ReturnType<typeof makePanelStub>;
  snapshotStub?: ReturnType<typeof makeSnapshotStub>;
}): CycleExecutorService {
  const agents = opts.agentsStub ?? makeAgentsStub({});
  const sandbox = opts.sandboxStub ?? makeSandboxStub();
  const plugins = opts.pluginsStub ?? makePluginsStub();
  const pluginEvents = opts.pluginEventsStub ?? makePluginEventsStub();
  const audit = opts.auditStub ?? makeAuditStub();
  const panel = opts.panelStub ?? makePanelStub();
  const snapshot = opts.snapshotStub ?? makeSnapshotStub();

  const service = new (CycleExecutorService as unknown as new (
    agents: unknown,
    sandbox: unknown,
    plugins: unknown,
    pluginEvents: unknown,
    audit: unknown,
    panel: unknown,
    snapshot: unknown,
  ) => CycleExecutorService)(agents, sandbox, plugins, pluginEvents, audit, panel, snapshot);

  // Force runState.running to the desired value via any-cast (private field)
  if (opts.cycleRunning) {
    (service as unknown as { runState: { running: boolean } }).runState.running = true;
  }

  return service;
}

// ── F4-S2 reflectNow tests — ported from panel.service.spec.ts ───────────────

describe('F4-S2 Phase 3.3 — CycleExecutorService.reflectNow', () => {
  it('3.3a — runState.running===true → throws ConflictException (409)', async () => {
    const service = makeCycleExecutorService({ cycleRunning: true });

    await expect(service.reflectNow()).rejects.toThrow(ConflictException);
  });

  it('3.3b — runState.running===false → calls agents.runReflectionTurn() and returns result', async () => {
    const agentsStub = makeAgentsStub({
      reflectNowResult: { skipped: false, cycle_id: 'ref-123', skills_written: 1 },
    });
    const service = makeCycleExecutorService({ cycleRunning: false, agentsStub });

    const result = await service.reflectNow();

    expect(agentsStub.runReflectionTurn).toHaveBeenCalledTimes(1);
    expect(result.skipped).toBe(false);
    expect(result.cycle_id).toBe('ref-123');
  });
});

describe('F4-S2 Fix #1 — CycleExecutorService.reflectNow holds the running lock during reflection', () => {
  it('3.3c — runState.running is true while runReflectionTurn is in-flight', async () => {
    let runningDuringReflection: boolean | undefined;

    const agentsStub: jest.Mocked<Pick<AgentsService, 'runReflectionTurn' | 'runCycle'>> = {
      runReflectionTurn: jest.fn().mockImplementation(
        () =>
          new Promise<ReflectionTurnResult>((resolve) => {
            runningDuringReflection = (service as unknown as { runState: { running: boolean } })
              .runState.running;
            resolve({ skipped: false, cycle_id: 'ref-lock', skills_written: 0 });
          }),
      ),
      runCycle: jest.fn().mockResolvedValue({ decisions: [], llm_response: null, llm_text: '' }),
    };

    const service = makeCycleExecutorService({ cycleRunning: false, agentsStub });

    await service.reflectNow();

    expect(runningDuringReflection).toBe(true);
  });

  it('3.3d — runState.running is cleared after reflectNow completes (success)', async () => {
    const agentsStub = makeAgentsStub({});
    const service = makeCycleExecutorService({ cycleRunning: false, agentsStub });

    await service.reflectNow();

    const state = (service as unknown as { runState: { running: boolean } }).runState;
    expect(state.running).toBe(false);
  });

  it('3.3e — runState.running is cleared even when runReflectionTurn throws (finally)', async () => {
    const agentsStub = makeAgentsStub({ reflectNowThrows: true });
    const service = makeCycleExecutorService({ cycleRunning: false, agentsStub });

    await expect(service.reflectNow()).rejects.toThrow('reflection failed');

    const state = (service as unknown as { runState: { running: boolean } }).runState;
    expect(state.running).toBe(false);
  });

  it('3.3f — second reflectNow call while first is in-flight → throws ConflictException', async () => {
    let resolveFirst!: (v: ReflectionTurnResult) => void;

    const agentsStub: jest.Mocked<Pick<AgentsService, 'runReflectionTurn' | 'runCycle'>> = {
      runReflectionTurn: jest.fn().mockImplementation(
        () =>
          new Promise<ReflectionTurnResult>((resolve) => {
            resolveFirst = resolve;
          }),
      ),
      runCycle: jest.fn().mockResolvedValue({ decisions: [], llm_response: null, llm_text: '' }),
    };
    const service = makeCycleExecutorService({ cycleRunning: false, agentsStub });

    // Start first call — lock is acquired synchronously before the await inside reflectNow
    const firstCallPromise = service.reflectNow();

    // Lock set synchronously before await — second call sees running===true immediately.
    await expect(service.reflectNow()).rejects.toThrow(ConflictException);

    // Clean up
    resolveFirst({ skipped: false, cycle_id: 'x', skills_written: 0 });
    await firstCallPromise;
  });
});

// ── runCycle characterization tests ──────────────────────────────────────────

describe('CycleExecutorService.runCycle', () => {
  it('accepted-when-idle — returns { accepted: true } when no cycle is running', () => {
    const service = makeCycleExecutorService({ cycleRunning: false });

    const result = service.runCycle(false);

    expect(result.accepted).toBe(true);
  });

  it('accepted-when-idle — sets runState.running to true', () => {
    const pluginEventsStub = makePluginEventsStub();
    const auditStub = makeAuditStub();
    const service = makeCycleExecutorService({
      cycleRunning: false,
      pluginEventsStub,
      auditStub,
    });

    service.runCycle(false);

    // running is set synchronously; executeCycle runs in background
    const state = (service as unknown as { runState: { running: boolean } }).runState;
    expect(state.running).toBe(true);
  });

  it('rejected-when-running — returns { accepted: false, message } when cycle is in progress', () => {
    const service = makeCycleExecutorService({ cycleRunning: true });

    const result = service.runCycle(false);

    expect(result.accepted).toBe(false);
    expect(result.message).toBe('Ya hay un ciclo en curso');
  });

  it('rejected-when-running — does not modify runState.running', () => {
    const service = makeCycleExecutorService({ cycleRunning: true });

    service.runCycle(false);

    const state = (service as unknown as { runState: { running: boolean } }).runState;
    expect(state.running).toBe(true);
  });
});

// ── executeCycle characterization tests ──────────────────────────────────────

describe('CycleExecutorService.executeCycle (via runCycle)', () => {
  it('dryRun=true → calls sandbox.runCycle, not agents.runCycle', async () => {
    const sandboxStub = makeSandboxStub({ runCycleOk: true });
    const agentsStub = makeAgentsStub({});
    const pluginsStub = makePluginsStub([{ id: 'plugin-1' }]);
    const service = makeCycleExecutorService({
      cycleRunning: false,
      agentsStub,
      sandboxStub,
      pluginsStub,
    });

    service.runCycle(true);

    // Let the background async settle
    await new Promise((r) => setTimeout(r, 10));

    expect(sandboxStub.runCycle).toHaveBeenCalledTimes(1);
    expect(agentsStub.runCycle).not.toHaveBeenCalled();
  });

  it('dryRun=false → calls agents.runCycle, not sandbox.runCycle', async () => {
    const sandboxStub = makeSandboxStub();
    const agentsStub = makeAgentsStub({});
    const service = makeCycleExecutorService({
      cycleRunning: false,
      agentsStub,
      sandboxStub,
    });

    service.runCycle(false);

    await new Promise((r) => setTimeout(r, 10));

    expect(agentsStub.runCycle).toHaveBeenCalledTimes(1);
    expect(sandboxStub.runCycle).not.toHaveBeenCalled();
  });

  it('audit receives cycle_start then cycle_complete on success', async () => {
    const auditStub = makeAuditStub();
    const service = makeCycleExecutorService({
      cycleRunning: false,
      auditStub,
    });

    service.runCycle(false);

    await new Promise((r) => setTimeout(r, 10));

    expect(auditStub.log).toHaveBeenCalledTimes(2);
    const eventTypes = auditStub.log.mock.calls.map(
      (call: unknown[]) => (call[0] as { event_type: string }).event_type,
    );
    expect(eventTypes).toContain('cycle_start');
    expect(eventTypes).toContain('cycle_complete');
  });

  it('audit receives cycle_fail on executeCycle throw', async () => {
    const auditStub = makeAuditStub();
    const agentsStub = makeAgentsStub({
      runCycleMock: jest.fn().mockRejectedValue(new Error('agent error')),
    });
    const service = makeCycleExecutorService({
      cycleRunning: false,
      agentsStub,
      auditStub,
    });

    service.runCycle(false);

    await new Promise((r) => setTimeout(r, 10));

    const eventTypes = auditStub.log.mock.calls.map(
      (call: unknown[]) => (call[0] as { event_type: string }).event_type,
    );
    expect(eventTypes).toContain('cycle_fail');
  });

  it('pluginEvents receives cycle.started then cycle.completed on success', async () => {
    const pluginEventsStub = makePluginEventsStub();
    const service = makeCycleExecutorService({
      cycleRunning: false,
      pluginEventsStub,
    });

    service.runCycle(false);

    await new Promise((r) => setTimeout(r, 10));

    const emittedEvents = pluginEventsStub.emit.mock.calls.map(
      (call: unknown[]) => call[0] as string,
    );
    expect(emittedEvents).toContain('cycle.started');
    expect(emittedEvents).toContain('cycle.completed');
  });

  it('finally clears runState.running on success', async () => {
    const service = makeCycleExecutorService({ cycleRunning: false });

    service.runCycle(false);

    await new Promise((r) => setTimeout(r, 10));

    const state = (service as unknown as { runState: { running: boolean } }).runState;
    expect(state.running).toBe(false);
  });

  it('finally clears runState.running on throw (cycle_fail path)', async () => {
    const agentsStub = makeAgentsStub({
      runCycleMock: jest.fn().mockRejectedValue(new Error('agent error')),
    });
    const service = makeCycleExecutorService({
      cycleRunning: false,
      agentsStub,
    });

    service.runCycle(false);

    await new Promise((r) => setTimeout(r, 10));

    const state = (service as unknown as { runState: { running: boolean } }).runState;
    expect(state.running).toBe(false);
  });
});

// ── NAV snapshot wiring (nav-data-collection F1) ─────────────────────────────

describe('CycleExecutorService.executeCycle — NAV snapshot wiring', () => {
  it('calls snapshotService.takeSnapshot exactly once per completed cycle, with the cycle id', async () => {
    const snapshotStub = makeSnapshotStub();
    const service = makeCycleExecutorService({ cycleRunning: false, snapshotStub });

    service.runCycle(false);
    await new Promise((r) => setTimeout(r, 10));

    expect(snapshotStub.takeSnapshot).toHaveBeenCalledTimes(1);
    const [calledCycleId] = snapshotStub.takeSnapshot.mock.calls[0] as [string];
    expect(typeof calledCycleId).toBe('string');
    expect(calledCycleId.length).toBeGreaterThan(0);
  });

  it('fail-soft: snapshotService.takeSnapshot rejecting does not fail the cycle', async () => {
    const snapshotStub = makeSnapshotStub({ takeSnapshotThrows: true });
    const auditStub = makeAuditStub();
    const service = makeCycleExecutorService({ cycleRunning: false, snapshotStub, auditStub });

    service.runCycle(false);
    await new Promise((r) => setTimeout(r, 10));

    // Cycle result is unaffected by the snapshot rejection.
    const state = (
      service as unknown as { runState: { running: boolean; last: { ok: boolean } | null } }
    ).runState;
    expect(state.running).toBe(false);
    expect(state.last?.ok).toBe(true);

    // No cycle_fail audit event was recorded because of the snapshot error.
    const eventTypes = auditStub.log.mock.calls.map(
      (call: unknown[]) => (call[0] as { event_type: string }).event_type,
    );
    expect(eventTypes).not.toContain('cycle_fail');
    expect(eventTypes).toContain('cycle_complete');
  });
});
