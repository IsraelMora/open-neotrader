import { ConflictException } from '@nestjs/common';
import { PanelService } from './panel.service';
import type { AgentsService } from '../agents/agents.service';
import type { ReflectionTurnResult } from '../agents/agents.service';

// ── Stubs ─────────────────────────────────────────────────────────────────────

function makeAgentsStub(opts: {
  reflectNowResult?: ReflectionTurnResult;
  reflectNowThrows?: boolean;
}): jest.Mocked<Pick<AgentsService, 'runReflectionTurn'>> {
  return {
    runReflectionTurn: opts.reflectNowThrows
      ? jest.fn().mockRejectedValue(new Error('reflection failed'))
      : jest
          .fn()
          .mockResolvedValue(
            opts.reflectNowResult ?? { skipped: false, cycle_id: 'ref-001', skills_written: 0 },
          ),
  };
}

/**
 * Build a minimal PanelService for reflectNow tests.
 * We inject only what reflectNow needs: agents (for runReflectionTurn) and
 * internal runState (set via the private setter or by driving runCycle).
 */
function makePanelService(opts: {
  cycleRunning?: boolean;
  agentsStub?: ReturnType<typeof makeAgentsStub>;
}): PanelService {
  const agents = opts.agentsStub ?? makeAgentsStub({});

  const service = new (PanelService as unknown as new (
    db: unknown,
    agents: unknown,
    llm: unknown,
    sandbox: unknown,
    plugins: unknown,
    pluginEvents: unknown,
    audit: unknown,
  ) => PanelService)(
    {},
    agents,
    {},
    {},
    {},
    { emit: jest.fn() },
    { log: jest.fn().mockResolvedValue(undefined) },
  );

  // Force runState.running to the desired value via any-cast (private field)
  if (opts.cycleRunning) {
    (service as unknown as { runState: { running: boolean } }).runState.running = true;
  }

  return service;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('F4-S2 Phase 3.3 — PanelService.reflectNow', () => {
  it('3.3a — runState.running===true → throws ConflictException (409)', async () => {
    const service = makePanelService({ cycleRunning: true });

    await expect(service.reflectNow()).rejects.toThrow(ConflictException);
  });

  it('3.3b — runState.running===false → calls agents.runReflectionTurn() and returns result', async () => {
    const agentsStub = makeAgentsStub({
      reflectNowResult: { skipped: false, cycle_id: 'ref-123', skills_written: 1 },
    });
    const service = makePanelService({ cycleRunning: false, agentsStub });

    const result = await service.reflectNow();

    expect(agentsStub.runReflectionTurn).toHaveBeenCalledTimes(1);
    expect(result.skipped).toBe(false);
    expect(result.cycle_id).toBe('ref-123');
  });
});

describe('F4-S2 Fix #1 — reflectNow holds the running lock during reflection', () => {
  it('3.3c — runState.running is true while runReflectionTurn is in-flight', async () => {
    let runningDuringReflection: boolean | undefined;

    // Stub that captures runState.running mid-execution
    const agentsStub: jest.Mocked<Pick<AgentsService, 'runReflectionTurn'>> = {
      runReflectionTurn: jest.fn().mockImplementation(
        () =>
          new Promise<ReflectionTurnResult>((resolve) => {
            // runState.running must be true at this point (lock held)
            runningDuringReflection = (service as unknown as { runState: { running: boolean } })
              .runState.running;
            resolve({ skipped: false, cycle_id: 'ref-lock', skills_written: 0 });
          }),
      ),
    };

    const service = makePanelService({ cycleRunning: false, agentsStub });

    await service.reflectNow();

    expect(runningDuringReflection).toBe(true);
  });

  it('3.3d — runState.running is cleared after reflectNow completes (success)', async () => {
    const agentsStub = makeAgentsStub({});
    const service = makePanelService({ cycleRunning: false, agentsStub });

    await service.reflectNow();

    const state = (service as unknown as { runState: { running: boolean } }).runState;
    expect(state.running).toBe(false);
  });

  it('3.3e — runState.running is cleared even when runReflectionTurn throws (finally)', async () => {
    const agentsStub = makeAgentsStub({ reflectNowThrows: true });
    const service = makePanelService({ cycleRunning: false, agentsStub });

    await expect(service.reflectNow()).rejects.toThrow('reflection failed');

    const state = (service as unknown as { runState: { running: boolean } }).runState;
    expect(state.running).toBe(false);
  });

  it('3.3f — second reflectNow call while first is in-flight → throws ConflictException', async () => {
    let resolveFirst!: (v: ReflectionTurnResult) => void;

    const agentsStub: jest.Mocked<Pick<AgentsService, 'runReflectionTurn'>> = {
      runReflectionTurn: jest.fn().mockImplementation(
        () =>
          new Promise<ReflectionTurnResult>((resolve) => {
            resolveFirst = resolve;
          }),
      ),
    };
    const service = makePanelService({ cycleRunning: false, agentsStub });

    // Start first call — lock is acquired synchronously before the await inside reflectNow
    const firstCallPromise = service.reflectNow();

    // The event loop hasn't been given a chance to settle yet, but because the
    // lock is set synchronously (before the await in the fixed implementation),
    // the second call must see running===true immediately.
    await expect(service.reflectNow()).rejects.toThrow(ConflictException);

    // Clean up
    resolveFirst({ skipped: false, cycle_id: 'x', skills_written: 0 });
    await firstCallPromise;
  });
});
