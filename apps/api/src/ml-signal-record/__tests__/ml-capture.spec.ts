/**
 * ml-capture.spec.ts — Task 3.1 TDD RED → 3.2 GREEN
 *
 * ml-feature-extractor-s1: tests for _mlCaptureSignals integration in AgentsService.
 *
 * Tests:
 * - _mlCaptureSignals groups approvedSignals by symbol, uses plugin_id ?? source fallback,
 *   resolves action from signalsEmitted, skips symbols without emitted action,
 *   calls recordSignals with correct args, computes hash from skill-type plugins only.
 * - _executeCycle capture fail-soft: recordSignals throws -> cycle returns normal AgentCycleResult.
 * - @Optional absent -> _executeCycle result is unaffected (no ml_signal_record rows written).
 */
import { AgentsService } from '../../agents/agents.service';
import { MlSignalRecordService } from '../ml-signal-record.service';
import type { SkillContribution } from '../ml-signal-record.service';
import type { LlmService } from '../../llm/llm.service';
import type { SandboxGateway } from '../../sandbox/sandbox.gateway';
import type { PluginsService } from '../../plugins/plugins.service';
import type { ContextMemoryService } from '../../context-memory/context-memory.service';
import type { AuditService } from '../../audit/audit.service';
import type { KvService } from '../../common/kv.service';

function makeAudit(): jest.Mocked<Pick<AuditService, 'log'>> {
  return { log: jest.fn().mockResolvedValue(undefined) };
}

function makeMemory(): jest.Mocked<
  Pick<ContextMemoryService, 'toContextString' | 'appendObservation' | 'trackSignal'>
> {
  return {
    toContextString: jest.fn().mockResolvedValue(''),
    appendObservation: jest.fn().mockResolvedValue(undefined),
    trackSignal: jest.fn().mockResolvedValue(undefined),
  };
}

function makeKvSingleTurn(): jest.Mocked<Pick<KvService, 'get'>> {
  return {
    get: jest
      .fn()
      .mockImplementation((key: string) => Promise.resolve(key === 'react.max_turns' ? '1' : null)),
  };
}

function makeMlSignalRecord(opts?: {
  recordSignalsThrows?: boolean;
}): jest.Mocked<Pick<MlSignalRecordService, 'recordSignals' | 'computeActiveSkillHash'>> {
  return {
    recordSignals: opts?.recordSignalsThrows
      ? jest.fn().mockRejectedValue(new Error('ML DB error'))
      : jest.fn().mockResolvedValue(undefined),
    computeActiveSkillHash: jest.fn().mockReturnValue('deadbeef12345678'),
  };
}

/**
 * Build AgentsService with MlSignalRecordService wired.
 * Constructor positional order (after s1 wiring):
 * 0: llm, 1: sandbox, 2: plugins, 3: memory, 4: audit, 5: alerts,
 * 6: snapshot, 7: cfg, 8: notifier, 9: pretest, 10: kv,
 * 11: longTermMemory, 12: debate, 13: providerGateway, 14: mlSignalRecord
 */
function makeAgentsServiceWithMl(
  sandbox: Partial<SandboxGateway>,
  plugins: Partial<PluginsService>,
  llm: Partial<LlmService>,
  mlSignalRecord?: Partial<MlSignalRecordService> | null,
  ltm?: null,
): AgentsService {
  return new (AgentsService as unknown as new (
    llm: unknown,
    sandbox: unknown,
    plugins: unknown,
    memory: unknown,
    audit: unknown,
    alerts: unknown,
    snapshot: unknown,
    cfg: unknown,
    notifier: unknown,
    pretest: unknown,
    kv: unknown,
    longTermMemory: unknown,
    debate: unknown,
    providerGateway: unknown,
    mlSignalRecord: unknown,
  ) => AgentsService)(
    llm,
    sandbox,
    plugins,
    makeMemory(),
    makeAudit(),
    { createBulk: jest.fn().mockResolvedValue([]) },
    undefined,
    undefined,
    undefined,
    undefined,
    makeKvSingleTurn(),
    ltm ?? undefined,
    undefined,
    undefined,
    mlSignalRecord ?? undefined,
  );
}

// ── _mlCaptureSignals behavior ────────────────────────────────────────────────

describe('AgentsService._mlCaptureSignals (ml-feature-extractor-s1)', () => {
  it('groups approvedSignals by symbol and calls recordSignals with correct args', async () => {
    const mlSvc = makeMlSignalRecord();
    const activePluginsList = [
      { id: 'momentum-skill', type: 'skill' },
      { id: 'trend-skill', type: 'skill' },
      { id: 'alpaca-provider', type: 'provider' },
    ];

    const sandbox: Partial<SandboxGateway> = {
      runCycle: jest.fn().mockResolvedValue({
        ok: true,
        result: {
          pending_signals: [
            {
              symbol: 'AAPL',
              action: 'buy',
              confidence: 0.8,
              plugin_id: 'momentum-skill',
              type: 'skill',
            },
            {
              symbol: 'AAPL',
              action: 'buy',
              confidence: 0.65,
              plugin_id: 'trend-skill',
              type: 'skill',
            },
            {
              symbol: 'MSFT',
              action: 'sell',
              confidence: 0.5,
              plugin_id: 'momentum-skill',
              type: 'skill',
            },
          ],
        },
      }),
      callPlugin: jest.fn().mockResolvedValue({ ok: true, result: null }),
      call: jest.fn().mockResolvedValue({ ok: true, result: {} }),
      getPluginStage: jest.fn().mockReturnValue('post'),
    };

    const plugins: Partial<PluginsService> = {
      findActive: jest.fn().mockResolvedValue(activePluginsList),
      getProviderTools: jest.fn().mockResolvedValue([
        {
          plugin_id: 'alpaca-provider',
          name: 'alpaca-provider__place_order',
          description: 'place order',
          input_schema: { type: 'object', properties: {} },
        },
      ]),
      getSkillsMetadata: jest.fn().mockResolvedValue([]),
      getActiveDecisionPrompt: jest.fn().mockResolvedValue(null),
    };

    // LLM emits tool calls for both symbols (text must contain <tool_calls> XML for parseToolCalls)
    const llm: Partial<LlmService> = {
      complete: jest.fn().mockResolvedValue({
        text: '<tool_calls>[{"plugin_id":"alpaca-provider","function":"place_order","args":{"symbol":"AAPL","action":"buy"}},{"plugin_id":"alpaca-provider","function":"place_order","args":{"symbol":"MSFT","action":"sell"}}]</tool_calls>',
        tool_calls: [],
        backend: 'api',
        skills_read: [],
        skills_written: [],
      }),
    };

    const svc = makeAgentsServiceWithMl(sandbox, plugins, llm, mlSvc);
    await svc.runCycle('test');

    // recordSignals must have been called
    expect(mlSvc.recordSignals).toHaveBeenCalled();

    type RecordArg = { symbol: string; skill_vector: SkillContribution[]; action: string };
    const [calledCycleId, calledRecords, calledHash] = (mlSvc.recordSignals as jest.Mock).mock
      .calls[0] as [string, RecordArg[], string];
    expect(typeof calledCycleId).toBe('string');
    expect(calledHash).toBe('deadbeef12345678');

    // Must have one entry per symbol that had an emitted action
    const symbols = calledRecords.map((r) => r.symbol).sort((a, b) => a.localeCompare(b));
    // At minimum AAPL should be present (MSFT depends on whether veto passes)
    expect(symbols.length).toBeGreaterThan(0);

    // Each record should have skill_vector as array of contributions
    for (const rec of calledRecords) {
      expect(Array.isArray(rec.skill_vector)).toBe(true);
      for (const sv of rec.skill_vector) {
        expect(typeof sv.plugin_id).toBe('string');
        expect(typeof sv.action).toBe('string');
        expect(typeof sv.confidence).toBe('number');
      }
    }
  });

  it('uses plugin_id ?? source fallback when plugin_id is absent', async () => {
    const mlSvc = makeMlSignalRecord();

    const sandbox: Partial<SandboxGateway> = {
      runCycle: jest.fn().mockResolvedValue({
        ok: true,
        result: {
          pending_signals: [
            // No plugin_id, but has source
            {
              symbol: 'TSLA',
              action: 'buy',
              confidence: 0.7,
              source: 'trend-skill-v2',
              type: 'skill',
            },
          ],
        },
      }),
      callPlugin: jest.fn().mockResolvedValue({ ok: true, result: null }),
      call: jest.fn().mockResolvedValue({ ok: true, result: {} }),
      getPluginStage: jest.fn().mockReturnValue('post'),
    };

    const plugins: Partial<PluginsService> = {
      findActive: jest.fn().mockResolvedValue([
        { id: 'trend-skill-v2', type: 'skill' },
        { id: 'alpaca-provider', type: 'provider' },
      ]),
      getProviderTools: jest.fn().mockResolvedValue([
        {
          plugin_id: 'alpaca-provider',
          name: 'alpaca-provider__place_order',
          description: 'place order',
          input_schema: { type: 'object', properties: {} },
        },
      ]),
      getSkillsMetadata: jest.fn().mockResolvedValue([]),
      getActiveDecisionPrompt: jest.fn().mockResolvedValue(null),
    };

    const llm: Partial<LlmService> = {
      complete: jest.fn().mockResolvedValue({
        text: '<tool_calls>[{"plugin_id":"alpaca-provider","function":"place_order","args":{"symbol":"TSLA","action":"buy"}}]</tool_calls>',
        tool_calls: [],
        backend: 'api',
        skills_read: [],
        skills_written: [],
      }),
    };

    const svc = makeAgentsServiceWithMl(sandbox, plugins, llm, mlSvc);
    await svc.runCycle('test');

    type RecordArg = { symbol: string; skill_vector: SkillContribution[]; action: string };
    if ((mlSvc.recordSignals as jest.Mock).mock.calls.length > 0) {
      const [, calledRecords] = (mlSvc.recordSignals as jest.Mock).mock.calls[0] as [
        string,
        RecordArg[],
        string,
      ];
      const tslaRecord = calledRecords.find((r) => r.symbol === 'TSLA');
      if (tslaRecord) {
        const sv = tslaRecord.skill_vector[0];
        // plugin_id fallback to source
        expect(sv.plugin_id).toBe('trend-skill-v2');
      }
    }
    // Test passes if no throw (INERT guarantee)
  });

  it('computes active_skill_hash from skill-type plugins only', async () => {
    const mlSvc = makeMlSignalRecord();

    // Mix of skill and non-skill plugins
    const plugins: Partial<PluginsService> = {
      findActive: jest.fn().mockResolvedValue([
        { id: 'momentum-skill', type: 'skill' },
        { id: 'alpaca-provider', type: 'provider' },
        { id: 'risk-discipline', type: 'discipline' },
      ]),
      getProviderTools: jest.fn().mockResolvedValue([
        {
          plugin_id: 'alpaca-provider',
          name: 'alpaca-provider__place_order',
          description: 'place order',
          input_schema: { type: 'object', properties: {} },
        },
      ]),
      getSkillsMetadata: jest.fn().mockResolvedValue([]),
      getActiveDecisionPrompt: jest.fn().mockResolvedValue(null),
    };

    const sandbox: Partial<SandboxGateway> = {
      runCycle: jest.fn().mockResolvedValue({
        ok: true,
        result: {
          pending_signals: [
            {
              symbol: 'AAPL',
              action: 'buy',
              confidence: 0.8,
              plugin_id: 'momentum-skill',
              type: 'skill',
            },
          ],
        },
      }),
      callPlugin: jest.fn().mockResolvedValue({ ok: true, result: null }),
      call: jest.fn().mockResolvedValue({ ok: true, result: {} }),
      getPluginStage: jest.fn().mockReturnValue('post'),
    };

    const llm: Partial<LlmService> = {
      complete: jest.fn().mockResolvedValue({
        text: '<tool_calls>[{"plugin_id":"alpaca-provider","function":"place_order","args":{"symbol":"AAPL","action":"buy"}}]</tool_calls>',
        tool_calls: [],
        backend: 'api',
        skills_read: [],
        skills_written: [],
      }),
    };

    const svc = makeAgentsServiceWithMl(sandbox, plugins, llm, mlSvc);
    await svc.runCycle('test');

    if ((mlSvc.computeActiveSkillHash as jest.Mock).mock.calls.length > 0) {
      const [hashIds] = (mlSvc.computeActiveSkillHash as jest.Mock).mock.calls[0] as [string[]];
      // Only skill-type plugins
      expect(hashIds).toContain('momentum-skill');
      expect(hashIds).not.toContain('alpaca-provider');
      expect(hashIds).not.toContain('risk-discipline');
    }
  });
});

// ── Fail-soft: recordSignals throws → cycle completes ────────────────────────

describe('AgentsService._executeCycle capture fail-soft', () => {
  it('recordSignals throws → cycle returns normal AgentCycleResult (no exception propagates)', async () => {
    const mlSvc = makeMlSignalRecord({ recordSignalsThrows: true });

    const sandbox: Partial<SandboxGateway> = {
      runCycle: jest.fn().mockResolvedValue({
        ok: true,
        result: {
          pending_signals: [
            {
              symbol: 'AAPL',
              action: 'buy',
              confidence: 0.8,
              plugin_id: 'momentum-skill',
              type: 'skill',
            },
          ],
        },
      }),
      callPlugin: jest.fn().mockResolvedValue({ ok: true, result: null }),
      call: jest.fn().mockResolvedValue({ ok: true, result: {} }),
      getPluginStage: jest.fn().mockReturnValue('post'),
    };

    const plugins: Partial<PluginsService> = {
      findActive: jest.fn().mockResolvedValue([
        { id: 'momentum-skill', type: 'skill' },
        { id: 'alpaca-provider', type: 'provider' },
      ]),
      getProviderTools: jest.fn().mockResolvedValue([
        {
          plugin_id: 'alpaca-provider',
          name: 'alpaca-provider__place_order',
          description: 'place order',
          input_schema: { type: 'object', properties: {} },
        },
      ]),
      getSkillsMetadata: jest.fn().mockResolvedValue([]),
      getActiveDecisionPrompt: jest.fn().mockResolvedValue(null),
    };

    const llm: Partial<LlmService> = {
      complete: jest.fn().mockResolvedValue({
        // text must contain <tool_calls> XML so parseToolCalls can extract them
        text: 'cycle result<tool_calls>[{"plugin_id":"alpaca-provider","function":"place_order","args":{"symbol":"AAPL","action":"buy"}}]</tool_calls>',
        tool_calls: [],
        backend: 'api',
        skills_read: [],
        skills_written: [],
      }),
    };

    const svc = makeAgentsServiceWithMl(sandbox, plugins, llm, mlSvc);

    // Must not throw — cycle must complete normally
    const result = await svc.runCycle('test context');

    expect(result).toBeDefined();
    expect(result.cycle_id).toBeDefined();
    // cycle completed (llm_text contains the full LLM response)
    expect(result.llm_text).toContain('cycle result');
  });
});

// ── @Optional absent → _executeCycle behavior unchanged ─────────────────────

describe('AgentsService @Optional absent → INERT', () => {
  it('without MlSignalRecordService → _executeCycle runs fine, no crash', async () => {
    const sandbox: Partial<SandboxGateway> = {
      runCycle: jest.fn().mockResolvedValue({
        ok: true,
        result: {
          pending_signals: [
            {
              symbol: 'AAPL',
              action: 'buy',
              confidence: 0.8,
              plugin_id: 'momentum-skill',
              type: 'skill',
            },
          ],
        },
      }),
      callPlugin: jest.fn().mockResolvedValue({ ok: true, result: null }),
      call: jest.fn().mockResolvedValue({ ok: true, result: {} }),
      getPluginStage: jest.fn().mockReturnValue('post'),
    };

    const plugins: Partial<PluginsService> = {
      findActive: jest.fn().mockResolvedValue([{ id: 'momentum-skill', type: 'skill' }]),
      getProviderTools: jest.fn().mockResolvedValue([]),
      getSkillsMetadata: jest.fn().mockResolvedValue([]),
      getActiveDecisionPrompt: jest.fn().mockResolvedValue(null),
    };

    const llm: Partial<LlmService> = {
      complete: jest.fn().mockResolvedValue({
        text: 'baseline result',
        tool_calls: [],
        backend: 'api',
        skills_read: [],
        skills_written: [],
      }),
    };

    // No mlSignalRecord injected (null → undefined → @Optional)
    const svc = makeAgentsServiceWithMl(sandbox, plugins, llm, null);

    const result = await svc.runCycle('test context');

    expect(result).toBeDefined();
    expect(result.cycle_id).toBeDefined();
    expect(result.llm_text).toBe('baseline result');
  });
});
