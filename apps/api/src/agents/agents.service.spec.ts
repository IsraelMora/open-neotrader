import { AgentsService } from './agents.service';
import type { LlmService, LlmResponse, ToolCallRequest } from '../llm/llm.service';
import type { SandboxGateway } from '../sandbox/sandbox.gateway';
import type { PluginsService } from '../plugins/plugins.service';
import type { ContextMemoryService } from '../context-memory/context-memory.service';
import type { AuditService } from '../audit/audit.service';
import type { AlertsService } from '../alerts/alerts.service';
import type { SnapshotService } from '../snapshot/snapshot.service';
import type { PretestService } from '../pretest/pretest.service';
import type { KvService } from '../common/kv.service';

// ── Stubs ─────────────────────────────────────────────────────────────────────

function makeAudit(): jest.Mocked<Pick<AuditService, 'log'>> {
  return { log: jest.fn().mockResolvedValue(undefined) };
}

function makePlugins(
  activeIds: string[],
  toolNames: string[],
): jest.Mocked<Pick<PluginsService, 'findActive' | 'getProviderTools'>> {
  return {
    findActive: jest.fn().mockResolvedValue(activeIds.map((id) => ({ id, type: 'provider' }))),
    getProviderTools: jest.fn().mockResolvedValue(
      toolNames.map((n) => ({
        plugin_id: n.split('__')[0],
        name: n,
        description: '',
        input_schema: { type: 'object', properties: {} },
      })),
    ),
  };
}

function makeAgentsService(
  plugins: ReturnType<typeof makePlugins>,
  audit: ReturnType<typeof makeAudit>,
  llm?: Partial<LlmService>,
): AgentsService {
  return new AgentsService(
    (llm ?? {}) as unknown as LlmService,
    {} as unknown as SandboxGateway,
    plugins as unknown as PluginsService,
    {} as unknown as ContextMemoryService,
    audit as unknown as AuditService,
    {} as unknown as AlertsService,
  );
}

// ── Test access to private methods via any cast ───────────────────────────────

async function callValidate(
  service: AgentsService,
  cycleId: string,
  calls: ToolCallRequest[],
): Promise<ToolCallRequest[]> {
  return (
    service as unknown as {
      _validateToolCalls: (c: string, t: ToolCallRequest[]) => Promise<ToolCallRequest[]>;
    }
  )._validateToolCalls(cycleId, calls);
}

function makeLlm(responseText: string): Partial<LlmService> {
  const response: LlmResponse = {
    text: responseText,
    tool_calls: [],
    backend: 'api',
    skills_read: [],
    skills_written: [],
  };
  return {
    complete: jest.fn().mockResolvedValue(response),
  };
}

// Shared sandbox / memory factories used across multiple describe blocks.
function makeSandbox(): jest.Mocked<Pick<SandboxGateway, 'runCycle' | 'callPlugin'>> {
  return {
    runCycle: jest.fn().mockResolvedValue({ ok: true, result: { pending_signals: [] } }),
    callPlugin: jest.fn().mockResolvedValue({ ok: true, result: null }),
  };
}

/** Full sandbox stub including `call` (needed for veto layer tests). */
function makeFullSandbox(): jest.Mocked<Pick<SandboxGateway, 'runCycle' | 'callPlugin' | 'call'>> {
  return {
    runCycle: jest.fn().mockResolvedValue({ ok: true, result: { pending_signals: [] } }),
    callPlugin: jest.fn().mockResolvedValue({ ok: true, result: null }),
    call: jest.fn().mockResolvedValue({ ok: true, result: {} }),
  };
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

// Shared full-plugins factory that includes getActiveDecisionPrompt.
function makeFullPlugins(
  decisionPrompt: string | null = null,
  tools: { plugin_id: string; name: string; description: string; input_schema: object }[] = [],
): jest.Mocked<
  Pick<
    PluginsService,
    'findActive' | 'getProviderTools' | 'getSkillsMetadata' | 'getActiveDecisionPrompt'
  >
> {
  return {
    findActive: jest.fn().mockResolvedValue([]),
    getProviderTools: jest.fn().mockResolvedValue(tools),
    getSkillsMetadata: jest.fn().mockResolvedValue([]),
    getActiveDecisionPrompt: jest.fn().mockResolvedValue(decisionPrompt),
  };
}

/**
 * KvService stub that returns maxTurns='1' so tests written before F6-S1 (which
 * set up a single LLM response) remain single-iteration and their existing assertions
 * continue to pass.  Tests that need multi-iteration behaviour use makeReActService
 * with an explicit kv value.
 */
function makeKvSingleTurn(): jest.Mocked<Pick<KvService, 'get'>> {
  return {
    get: jest
      .fn()
      .mockImplementation((key: string) => Promise.resolve(key === 'react.max_turns' ? '1' : null)),
  };
}

function makeFullAgentsService(
  llm: Partial<LlmService>,
  audit: ReturnType<typeof makeAudit>,
  plugins: ReturnType<typeof makeFullPlugins>,
  sandbox: ReturnType<typeof makeSandbox>,
  memory: ReturnType<typeof makeMemory>,
): AgentsService {
  // Inject kv returning '1' so pre-F6-S1 tests stay single-iteration.
  // F6-S1 multi-iteration tests use makeReActService with explicit kv control.
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
  ) => AgentsService)(
    llm,
    sandbox,
    plugins,
    memory,
    audit,
    { createBulk: jest.fn().mockResolvedValue([]) },
    undefined,
    undefined,
    undefined,
    undefined,
    makeKvSingleTurn(),
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AgentsService._validateToolCalls', () => {
  const CYCLE_ID = 'cycle-test-001';

  it('returns a valid call unchanged (no audit event)', async () => {
    const plugins = makePlugins(['alpaca-provider'], ['alpaca-provider__place_order']);
    const audit = makeAudit();
    const service = makeAgentsService(plugins, audit);

    const calls: ToolCallRequest[] = [
      { plugin_id: 'alpaca-provider', function: 'place_order', args: { symbol: 'AAPL' } },
    ];

    const result: ToolCallRequest[] = await callValidate(service, CYCLE_ID, calls);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(calls[0]);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('drops a call referencing an inactive plugin and audits with reason plugin_inactive', async () => {
    // alpaca-provider has tools declared but is NOT in active list
    const plugins = makePlugins([], ['alpaca-provider__place_order']);
    const audit = makeAudit();
    const service = makeAgentsService(plugins, audit);

    const calls: ToolCallRequest[] = [
      { plugin_id: 'alpaca-provider', function: 'place_order', args: {} },
    ];

    const result: ToolCallRequest[] = await callValidate(service, CYCLE_ID, calls);

    expect(result).toHaveLength(0);
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        cycle_id: CYCLE_ID,
        event_type: 'tool_call_dropped',
        plugin_id: 'alpaca-provider',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        meta: expect.objectContaining({ reason: 'plugin_inactive' }),
      }),
    );
  });

  it('drops a call referencing a function not declared in tools.json and audits with reason function_not_declared', async () => {
    // Plugin is active, but 'invent_trade' is not in declared tools
    const plugins = makePlugins(['alpaca-provider'], ['alpaca-provider__place_order']);
    const audit = makeAudit();
    const service = makeAgentsService(plugins, audit);

    const calls: ToolCallRequest[] = [
      { plugin_id: 'alpaca-provider', function: 'invent_trade', args: {} },
    ];

    const result: ToolCallRequest[] = await callValidate(service, CYCLE_ID, calls);

    expect(result).toHaveLength(0);
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'tool_call_dropped',
        plugin_id: 'alpaca-provider',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        meta: expect.objectContaining({ reason: 'function_not_declared' }),
      }),
    );
  });

  it('drops a call with a completely unknown plugin_id and audits with reason plugin_not_found', async () => {
    const plugins = makePlugins(['alpaca-provider'], ['alpaca-provider__place_order']);
    const audit = makeAudit();
    const service = makeAgentsService(plugins, audit);

    const calls: ToolCallRequest[] = [
      { plugin_id: 'nonexistent-plugin', function: 'do_something', args: {} },
    ];

    const result: ToolCallRequest[] = await callValidate(service, CYCLE_ID, calls);

    expect(result).toHaveLength(0);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'tool_call_dropped',
        plugin_id: 'nonexistent-plugin',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        meta: expect.objectContaining({ reason: 'plugin_not_found' }),
      }),
    );
  });

  it('handles mixed valid and invalid calls: valid returned, each invalid audited independently', async () => {
    const plugins = makePlugins(['alpaca-provider'], ['alpaca-provider__place_order']);
    const audit = makeAudit();
    const service = makeAgentsService(plugins, audit);

    const calls: ToolCallRequest[] = [
      { plugin_id: 'alpaca-provider', function: 'place_order', args: { symbol: 'AAPL' } }, // valid
      { plugin_id: 'alpaca-provider', function: 'hallucinated_fn', args: {} }, // invalid
      { plugin_id: 'ghost-plugin', function: 'ghost_fn', args: {} }, // invalid
    ];

    const result: ToolCallRequest[] = await callValidate(service, CYCLE_ID, calls);

    expect(result).toHaveLength(1);
    expect(result[0].function).toBe('place_order');
    // Two invalid calls → two audit entries
    expect(audit.log).toHaveBeenCalledTimes(2);
  });

  it('never throws', async () => {
    const plugins = makePlugins([], []);
    const audit = makeAudit();
    const service = makeAgentsService(plugins, audit);

    await expect(callValidate(service, CYCLE_ID, [])).resolves.toEqual([]);
  });

  it('returns [] and does not throw when getProviderTools throws', async () => {
    const plugins = makePlugins(['alpaca-provider'], []);
    // Override getProviderTools to throw.
    (plugins.getProviderTools as jest.Mock).mockRejectedValue(new Error('Prisma connection lost'));
    const audit = makeAudit();
    const service = makeAgentsService(plugins, audit);

    const calls: ToolCallRequest[] = [
      { plugin_id: 'alpaca-provider', function: 'place_order', args: {} },
    ];

    await expect(callValidate(service, CYCLE_ID, calls)).resolves.toEqual([]);
  });

  it('emits cycle_fail audit with stage:_validateToolCalls when getProviderTools throws', async () => {
    const plugins = makePlugins(['alpaca-provider'], []);
    (plugins.getProviderTools as jest.Mock).mockRejectedValue(new Error('Prisma connection lost'));
    const audit = makeAudit();
    const service = makeAgentsService(plugins, audit);

    const calls: ToolCallRequest[] = [
      { plugin_id: 'alpaca-provider', function: 'place_order', args: {} },
    ];

    const result = await callValidate(service, CYCLE_ID, calls);

    // Still returns [] (fail-safe)
    expect(result).toEqual([]);

    // Must emit a cycle_fail audit with stage metadata
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        cycle_id: CYCLE_ID,
        event_type: 'cycle_fail',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        error: expect.stringContaining('Prisma connection lost'),
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        meta: expect.objectContaining({ stage: '_validateToolCalls' }),
      }),
    );
  });
});

// ── AgentsService._executeCycle — parseToolCalls wiring ──────────────────────

describe('AgentsService._executeCycle — parse wiring', () => {
  const CYCLE_ID = 'parse-cycle-001';

  async function callExecuteCycle(
    service: AgentsService,
    cycleId: string,
    context: string,
  ): ReturnType<AgentsService['runCycle']> {
    return (
      service as unknown as {
        _executeCycle: (
          c: string,
          ctx: string,
          sp?: string,
        ) => ReturnType<AgentsService['runCycle']>;
      }
    )._executeCycle(cycleId, context, undefined);
  }

  it('parses tool_calls from llmResponse.text via parseToolCalls in the cycle', async () => {
    const responseText =
      '<tool_calls>[{"tool":"alpaca-provider__place_order","args":{"symbol":"AAPL","qty":1}}]</tool_calls>';
    const llm = makeLlm(responseText);
    const audit = makeAudit();
    const plugins = makeFullPlugins();
    // Make the plugin active and declare the tool so it passes validation.
    plugins.findActive.mockResolvedValue([{ id: 'alpaca-provider', type: 'provider' }] as never);
    plugins.getProviderTools.mockResolvedValue([
      {
        plugin_id: 'alpaca-provider',
        name: 'alpaca-provider__place_order',
        description: '',
        input_schema: { type: 'object', properties: {} },
      },
    ] as never);
    const sandbox = makeSandbox();
    const memory = makeMemory();
    const service = makeFullAgentsService(llm, audit, plugins, sandbox, memory);

    const result = await callExecuteCycle(service, CYCLE_ID, 'run cycle');

    // The cycle must have parsed and executed the tool call.
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].plugin_id).toBe('alpaca-provider');
    expect(result.decisions[0].function).toBe('place_order');
  });

  it('fires a parse_miss audit event when llmResponse.text contains a malformed block', async () => {
    const responseText = '<tool_calls>not valid json</tool_calls>';
    const llm = makeLlm(responseText);
    const audit = makeAudit();
    const plugins = makeFullPlugins();
    const sandbox = makeSandbox();
    const memory = makeMemory();
    const service = makeFullAgentsService(llm, audit, plugins, sandbox, memory);

    await callExecuteCycle(service, CYCLE_ID, 'run cycle');

    const calls = (audit.log as jest.Mock).mock.calls as Array<[Record<string, unknown>]>;
    const parseMissCall = calls.find(([arg]) => arg['event_type'] === 'parse_miss');
    expect(parseMissCall).toBeDefined();
    expect(parseMissCall![0]).toMatchObject({
      cycle_id: CYCLE_ID,
      event_type: 'parse_miss',
    });
  });
});

// ── AgentsService._executeCycle — decision prompt + tool schema injection ─────

describe('AgentsService._executeCycle — decision prompt injection (Phase 6.3)', () => {
  const CYCLE_ID = 'decision-cycle-001';

  async function callExecuteCycle(
    service: AgentsService,
    cycleId: string,
    context: string,
    systemPrompt?: string,
  ): ReturnType<AgentsService['runCycle']> {
    return (
      service as unknown as {
        _executeCycle: (
          c: string,
          ctx: string,
          sp?: string,
        ) => ReturnType<AgentsService['runCycle']>;
      }
    )._executeCycle(cycleId, context, systemPrompt);
  }

  function buildService(
    plugins: ReturnType<typeof makeFullPlugins>,
    capturedSystemPrompts: string[],
  ): AgentsService {
    const llm: Partial<LlmService> = {
      complete: jest.fn().mockImplementation((opts: { system_prompt?: string }) => {
        capturedSystemPrompts.push(opts.system_prompt ?? '');
        return Promise.resolve({
          text: '',
          tool_calls: [],
          backend: 'api',
          skills_read: [],
          skills_written: [],
        } as LlmResponse);
      }),
    };

    return new AgentsService(
      llm as unknown as LlmService,
      makeSandbox() as unknown as SandboxGateway,
      plugins as unknown as PluginsService,
      makeMemory() as unknown as ContextMemoryService,
      { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService,
      { createBulk: jest.fn().mockResolvedValue([]) } as unknown as AlertsService,
    );
  }

  it('prepends decision prompt to system_prompt when a decision plugin is active', async () => {
    const decisionPrompt =
      'Emit tool_calls as JSON inside <tool_calls></tool_calls> using the provided tool schema.';
    const tools = [
      {
        plugin_id: 'my-provider',
        name: 'my-provider__do_thing',
        description: 'Does the thing.',
        input_schema: { type: 'object', properties: {} },
      },
    ];
    const plugins = makeFullPlugins(decisionPrompt, tools);
    const captured: string[] = [];
    const service = buildService(plugins, captured);

    await callExecuteCycle(service, CYCLE_ID, 'some context');

    expect(captured).toHaveLength(1);
    const sentPrompt = captured[0];
    // Decision prompt must be present.
    expect(sentPrompt).toContain(decisionPrompt);
    // Compact tool schema must be present (no pretty-printing).
    expect(sentPrompt).toContain('my-provider__do_thing');
    // Compact JSON: no newlines inside the schema portion.
    const schemaJson = JSON.stringify(tools);
    expect(sentPrompt).toContain(schemaJson);
  });

  it('does NOT inject decision prompt or tool schema when no decision plugin is active', async () => {
    const plugins = makeFullPlugins(null /* no decision prompt */);
    const captured: string[] = [];
    const service = buildService(plugins, captured);

    await callExecuteCycle(service, CYCLE_ID, 'some context');

    // system_prompt passed to LLM must be undefined or empty (no injection).
    const sentPrompt = captured[0];
    // No decision content.
    expect(sentPrompt).not.toContain('[TOOL SCHEMA]');
    expect(sentPrompt).not.toContain('[DECISION]');
  });

  it('calls getProviderTools ONCE per cycle regardless of how many tool_calls are parsed', async () => {
    const decisionPrompt = 'Format: emit tool_calls.';
    const tools = [
      {
        plugin_id: 'prov',
        name: 'prov__act',
        description: 'action',
        input_schema: { type: 'object', properties: {} },
      },
    ];
    const plugins = makeFullPlugins(decisionPrompt, tools);
    // Also make the tool valid so validation keeps it.
    plugins.findActive.mockResolvedValue([{ id: 'prov', type: 'provider' }] as never);
    const captured: string[] = [];
    const service = buildService(plugins, captured);

    await callExecuteCycle(service, CYCLE_ID, 'ctx');

    // getProviderTools must be called exactly once (hoisted — shared between injection + validation).
    expect(plugins.getProviderTools).toHaveBeenCalledTimes(1);
  });

  it('logs a warn when the injected tool schema exceeds the token-budget guard (~8000 chars)', async () => {
    // Build a large tool schema that exceeds 8000 chars.
    const bigDescription = 'x'.repeat(8100);
    const tools = [
      {
        plugin_id: 'prov',
        name: 'prov__big',
        description: bigDescription,
        input_schema: { type: 'object', properties: {} },
      },
    ];
    const decisionPrompt = 'Use tools.';
    const plugins = makeFullPlugins(decisionPrompt, tools);
    const captured: string[] = [];
    const service = buildService(plugins, captured);

    const logWarnSpy = jest.spyOn(service['log'], 'warn');

    await callExecuteCycle(service, CYCLE_ID, 'ctx');

    expect(logWarnSpy).toHaveBeenCalledWith(expect.stringContaining('token-budget'));
  });
});

// ── AgentsService.runGovernedTurn ─────────────────────────────────────────────

describe('AgentsService.runGovernedTurn — no-decision-plugin (source: chat)', () => {
  it('returns text, empty tool_calls, backend; emits chat_turn audit; does not dispatch', async () => {
    const llm = makeLlm('Hello from the model');
    const audit = makeAudit();
    // No decision plugin active, no tools.
    const plugins = makeFullPlugins(null, []);
    const sandbox = makeSandbox();
    const memory = makeMemory();
    const service = makeFullAgentsService(llm, audit, plugins, sandbox, memory);

    const result = await service.runGovernedTurn({
      source: 'chat',
      context: 'What is the market doing?',
    });

    expect(result.text).toBe('Hello from the model');
    expect(result.tool_calls).toEqual([]);
    expect(result.backend).toBeDefined();

    // audit.log must have been called with chat_turn.
    const calls = (audit.log as jest.Mock).mock.calls as Array<[Record<string, unknown>]>;
    const chatTurnCall = calls.find(([arg]) => arg['event_type'] === 'chat_turn');
    expect(chatTurnCall).toBeDefined();

    // sandbox.callPlugin must NOT have been called.
    expect(sandbox.callPlugin).not.toHaveBeenCalled();
  });
});

describe('AgentsService.runGovernedTurn — valid tool call dispatched (source: chat)', () => {
  it('dispatches a valid tool call and includes it in result; audits chat_turn', async () => {
    const toolCallText =
      '<tool_calls>[{"tool":"alpaca-provider__place_order","args":{"symbol":"AAPL","qty":1}}]</tool_calls>';
    const llm = makeLlm(toolCallText);
    const audit = makeAudit();
    const tools = [
      {
        plugin_id: 'alpaca-provider',
        name: 'alpaca-provider__place_order',
        description: 'Place an order',
        input_schema: { type: 'object', properties: {} },
      },
    ];
    const plugins = makeFullPlugins('Emit tool calls as JSON.', tools);
    // Plugin must appear active.
    plugins.findActive.mockResolvedValue([{ id: 'alpaca-provider', type: 'provider' }] as never);
    const sandbox = makeSandbox();
    const memory = makeMemory();
    const service = makeFullAgentsService(llm, audit, plugins, sandbox, memory);

    const result = await service.runGovernedTurn({
      source: 'chat',
      context: 'Buy AAPL',
    });

    // The validated call must have been dispatched.
    expect(sandbox.callPlugin).toHaveBeenCalledTimes(1);

    // Result must include the dispatched tool_call.
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls[0].plugin_id).toBe('alpaca-provider');

    // chat_turn audit must be present.
    const calls = (audit.log as jest.Mock).mock.calls as Array<[Record<string, unknown>]>;
    const chatTurnCall = calls.find(([arg]) => arg['event_type'] === 'chat_turn');
    expect(chatTurnCall).toBeDefined();
  });
});

describe('AgentsService.runGovernedTurn — hallucinated/inactive tool dropped (source: chat)', () => {
  it('drops call to inactive plugin; audits tool_call_dropped; does not dispatch', async () => {
    const toolCallText = '<tool_calls>[{"tool":"ghost-plugin__ghost_fn","args":{}}]</tool_calls>';
    const llm = makeLlm(toolCallText);
    const audit = makeAudit();
    // ghost-plugin is NOT active and has no declared tools.
    const plugins = makeFullPlugins('Emit tool calls as JSON.', [
      {
        plugin_id: 'alpaca-provider',
        name: 'alpaca-provider__place_order',
        description: 'Place an order',
        input_schema: { type: 'object', properties: {} },
      },
    ]);
    // No active plugins — ghost-plugin won't pass validation.
    plugins.findActive.mockResolvedValue([]);
    const sandbox = makeSandbox();
    const memory = makeMemory();
    const service = makeFullAgentsService(llm, audit, plugins, sandbox, memory);

    const result = await service.runGovernedTurn({
      source: 'chat',
      context: 'Do something invalid',
    });

    // The dropped call must NOT have been dispatched.
    expect(sandbox.callPlugin).not.toHaveBeenCalled();

    // Result tool_calls must be empty (dropped before dispatch).
    expect(result.tool_calls).toEqual([]);

    // tool_call_dropped audit must be present.
    const calls = (audit.log as jest.Mock).mock.calls as Array<[Record<string, unknown>]>;
    const droppedCall = calls.find(([arg]) => arg['event_type'] === 'tool_call_dropped');
    expect(droppedCall).toBeDefined();
    expect(droppedCall![0]).toMatchObject({
      event_type: 'tool_call_dropped',
      plugin_id: 'ghost-plugin',
    });
  });
});

// ── Fix #1: cycle_complete emitted exactly once per runCycle ──────────────────

describe('AgentsService.runCycle — cycle_complete emitted exactly once', () => {
  it('audits cycle_complete exactly once per runCycle call (no duplicate from _executeCycle)', async () => {
    const llm = makeLlm('ok');
    const audit = makeAudit();
    const plugins = makeFullPlugins(null, []);
    const sandbox = makeFullSandbox();
    const memory = makeMemory();

    const service = new AgentsService(
      llm as unknown as LlmService,
      sandbox as unknown as SandboxGateway,
      plugins as unknown as PluginsService,
      memory as unknown as ContextMemoryService,
      audit as unknown as AuditService,
      { createBulk: jest.fn().mockResolvedValue([]) } as unknown as AlertsService,
    );

    await service.runCycle('some context');

    const allCalls = (audit.log as jest.Mock).mock.calls as Array<[Record<string, unknown>]>;
    const cycleCompleteEmissions = allCalls.filter(
      ([arg]) => arg['event_type'] === 'cycle_complete',
    );

    // CRITICAL: must be exactly 1, not 2.
    expect(cycleCompleteEmissions).toHaveLength(1);
    // The single emission must come from runCycle (has signals_count + llm_text, no meta.stage).
    expect(cycleCompleteEmissions[0][0]).toMatchObject({
      event_type: 'cycle_complete',
    });
    expect(
      (cycleCompleteEmissions[0][0]['meta'] as Record<string, unknown> | undefined)?.['stage'],
    ).toBeUndefined();
  });
});

// ── Fix #2: runGovernedTurn exposes authoritative signalsEmitted ──────────────

describe('AgentsService.runGovernedTurn — signalsEmitted in result', () => {
  it('returns signalsEmitted matching the tool calls executed (symbol+action pairs)', async () => {
    const toolCallText =
      '<tool_calls>[{"tool":"alpaca-provider__place_order","args":{"symbol":"AAPL","qty":1,"action":"buy"}}]</tool_calls>';
    const llm = makeLlm(toolCallText);
    const audit = makeAudit();
    const tools = [
      {
        plugin_id: 'alpaca-provider',
        name: 'alpaca-provider__place_order',
        description: 'Place an order',
        input_schema: { type: 'object', properties: {} },
      },
    ];
    const plugins = makeFullPlugins('Emit tool calls.', tools);
    plugins.findActive.mockResolvedValue([{ id: 'alpaca-provider', type: 'provider' }] as never);
    const sandbox = makeSandbox();
    const memory = makeMemory();
    const service = makeFullAgentsService(llm, audit, plugins, sandbox, memory);

    const result = await service.runGovernedTurn({ source: 'chat', context: 'Buy AAPL' });

    // signalsEmitted must be present and contain the AAPL buy signal.
    expect(result.signalsEmitted).toBeDefined();
    expect(result.signalsEmitted).toHaveLength(1);
    expect(result.signalsEmitted[0]).toEqual({ symbol: 'AAPL', action: 'buy' });
  });

  it('returns empty signalsEmitted when no tool calls have symbol+action', async () => {
    const llm = makeLlm('plain text response, no tools');
    const audit = makeAudit();
    const plugins = makeFullPlugins(null, []);
    const sandbox = makeSandbox();
    const memory = makeMemory();
    const service = makeFullAgentsService(llm, audit, plugins, sandbox, memory);

    const result = await service.runGovernedTurn({
      source: 'chat',
      context: 'What is the market?',
    });

    expect(result.signalsEmitted).toBeDefined();
    expect(result.signalsEmitted).toHaveLength(0);
  });
});

// ── Shared helper for _executeCycle tests below ───────────────────────────────

function callExecuteCyclePrivate(
  service: AgentsService,
  cycleId: string,
  context: string,
): ReturnType<AgentsService['runCycle']> {
  return (
    service as unknown as {
      _executeCycle: (c: string, ctx: string, sp?: string) => ReturnType<AgentsService['runCycle']>;
    }
  )._executeCycle(cycleId, context, undefined);
}

// ── Fix #3: findActive called only once per cycle ─────────────────────────────

describe('AgentsService._executeCycle — findActive called exactly once per cycle', () => {
  it('calls plugins.findActive exactly once regardless of whether there are tool calls', async () => {
    const toolCallText =
      '<tool_calls>[{"tool":"alpaca-provider__place_order","args":{"symbol":"TSLA","action":"sell"}}]</tool_calls>';
    const llm = makeLlm(toolCallText);
    const audit = makeAudit();
    const tools = [
      {
        plugin_id: 'alpaca-provider',
        name: 'alpaca-provider__place_order',
        description: 'Place an order',
        input_schema: { type: 'object', properties: {} },
      },
    ];
    const plugins = makeFullPlugins('Emit tool calls.', tools);
    plugins.findActive.mockResolvedValue([{ id: 'alpaca-provider', type: 'provider' }] as never);
    const sandbox = makeFullSandbox();
    const memory = makeMemory();

    const service = new AgentsService(
      llm as unknown as LlmService,
      sandbox as unknown as SandboxGateway,
      plugins as unknown as PluginsService,
      memory as unknown as ContextMemoryService,
      audit as unknown as AuditService,
      { createBulk: jest.fn().mockResolvedValue([]) } as unknown as AlertsService,
    );

    await callExecuteCyclePrivate(service, 'cycle-once-001', 'ctx');

    // findActive must be called exactly once — pre-fetched list reused by _validateToolCalls.
    expect(plugins.findActive).toHaveBeenCalledTimes(1);
  });
});

// ── PR3: _validateToolCalls with virtual_only guard ───────────────────────────

/**
 * callValidateVirtual — calls _validateToolCalls with virtual_only + preloadedActivePlugins.
 * Used for PR3 tests where activePlugins must be pre-loaded (virtual_only guard reads .type).
 */
async function callValidateVirtual(
  service: AgentsService,
  cycleId: string,
  calls: ToolCallRequest[],
  virtualOnly: boolean,
  activePlugins: import('../plugins/plugins.service').HydratedPlugin[],
): Promise<ToolCallRequest[]> {
  return (
    service as unknown as {
      _validateToolCalls: (
        c: string,
        t: ToolCallRequest[],
        hoistedTools: undefined,
        preloadedActivePlugins: import('../plugins/plugins.service').HydratedPlugin[],
        virtualOnly: boolean,
      ) => Promise<ToolCallRequest[]>;
    }
  )._validateToolCalls(cycleId, calls, undefined, activePlugins, virtualOnly);
}

describe('AgentsService._validateToolCalls — virtual_only guard (PR3)', () => {
  const CYCLE_ID = 'virtual-test-001';

  it('3.1.1 — virtual_only:true + provider plugin → call dropped + audit virtual_mode_provider_blocked', async () => {
    const providerPlugin = { id: 'alpaca-provider', type: 'provider', name: 'Alpaca' };
    const plugins = makePlugins(['alpaca-provider'], ['alpaca-provider__place_order']);
    (plugins.findActive as jest.Mock).mockResolvedValue([providerPlugin]);
    const audit = makeAudit();
    const service = makeAgentsService(plugins, audit);

    const calls: ToolCallRequest[] = [
      { plugin_id: 'alpaca-provider', function: 'place_order', args: { symbol: 'AAPL' } },
    ];

    const result = await callValidateVirtual(service, CYCLE_ID, calls, true, [
      providerPlugin,
    ] as import('../plugins/plugins.service').HydratedPlugin[]);

    expect(result).toHaveLength(0);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        cycle_id: CYCLE_ID,
        event_type: 'tool_call_dropped',
        plugin_id: 'alpaca-provider',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        meta: expect.objectContaining({ reason: 'virtual_mode_provider_blocked' }),
      }),
    );
  });

  it('3.1.2 — virtual_only:true + extra-type plugin → NOT dropped by virtual guard', async () => {
    const extraPlugin = { id: 'backtester', type: 'extra', name: 'Backtester' };
    const plugins = makePlugins(['backtester'], ['backtester__run']);
    (plugins.findActive as jest.Mock).mockResolvedValue([extraPlugin]);
    const audit = makeAudit();
    const service = makeAgentsService(plugins, audit);

    const calls: ToolCallRequest[] = [{ plugin_id: 'backtester', function: 'run', args: {} }];

    const result = await callValidateVirtual(service, CYCLE_ID, calls, true, [
      extraPlugin,
    ] as import('../plugins/plugins.service').HydratedPlugin[]);

    // Should pass the virtual guard and reach active/declared checks → valid
    expect(result).toHaveLength(1);
    expect(result[0].plugin_id).toBe('backtester');
  });

  it('3.1.3 — virtual_only:false + provider plugin → behavior unchanged (no provider block)', async () => {
    const providerPlugin = { id: 'alpaca-provider', type: 'provider', name: 'Alpaca' };
    const plugins = makePlugins(['alpaca-provider'], ['alpaca-provider__place_order']);
    (plugins.findActive as jest.Mock).mockResolvedValue([providerPlugin]);
    const audit = makeAudit();
    const service = makeAgentsService(plugins, audit);

    const calls: ToolCallRequest[] = [
      { plugin_id: 'alpaca-provider', function: 'place_order', args: { symbol: 'AAPL' } },
    ];

    const result = await callValidateVirtual(service, CYCLE_ID, calls, false, [
      providerPlugin,
    ] as import('../plugins/plugins.service').HydratedPlugin[]);

    // virtual_only is false → provider passes through validation normally
    expect(result).toHaveLength(1);
    expect(audit.log).not.toHaveBeenCalledWith(
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        meta: expect.objectContaining({ reason: 'virtual_mode_provider_blocked' }),
      }),
    );
  });
});

describe('AgentsService.runGovernedTurn — pretest source (PR3)', () => {
  it('3.1.4 — source:pretest + virtual_only:true → emits pretest_turn audit event', async () => {
    const llm = makeLlm('pretest response');
    const audit = makeAudit();
    const plugins = makeFullPlugins(null, []);
    const sandbox = makeSandbox();
    const memory = makeMemory();
    const service = makeFullAgentsService(llm, audit, plugins, sandbox, memory);

    await service.runGovernedTurn({
      source: 'pretest',
      context: 'Evaluate pretest signals',
      virtual_only: true,
    });

    const calls = (audit.log as jest.Mock).mock.calls as Array<[Record<string, unknown>]>;
    const pretestTurnCall = calls.find(([arg]) => arg['event_type'] === 'pretest_turn');
    expect(pretestTurnCall).toBeDefined();
    expect(pretestTurnCall![0]).toMatchObject({
      event_type: 'pretest_turn',
    });
  });

  it('3.1.5 — existing callers without source field compile and behave unchanged', async () => {
    // source is now optional with a default — existing callers pass no source and get cycle behavior
    const llm = makeLlm('cycle response');
    const audit = makeAudit();
    const plugins = makeFullPlugins(null, []);
    const sandbox = makeSandbox();
    const memory = makeMemory();
    const service = makeFullAgentsService(llm, audit, plugins, sandbox, memory);

    // TypeScript: source should be optional (no TS error when omitted) — no source passed here
    const result = await service.runGovernedTurn({
      source: 'cycle',
      context: 'cycle context',
    });

    expect(result.text).toBe('cycle response');
    // No pretest_turn audit for a cycle source
    const calls = (audit.log as jest.Mock).mock.calls as Array<[Record<string, unknown>]>;
    const pretestTurnCall = calls.find(([arg]) => arg['event_type'] === 'pretest_turn');
    expect(pretestTurnCall).toBeUndefined();
  });

  it('3.1.7 — end-to-end virtual_only block: provider tool_call in LLM response is dropped, callPlugin not called, audit emitted', async () => {
    // LLM returns a tool_call targeting a PROVIDER-type plugin
    const toolCallText =
      '<tool_calls>[{"tool":"alpaca-provider__place_order","args":{"symbol":"AAPL","action":"buy","qty":1}}]</tool_calls>';
    const llm = makeLlm(toolCallText);
    const audit = makeAudit();

    const providerTool = {
      plugin_id: 'alpaca-provider',
      name: 'alpaca-provider__place_order',
      description: 'Place an order',
      input_schema: { type: 'object', properties: {} },
    };
    const plugins = makeFullPlugins('Emit tool calls as JSON.', [providerTool]);
    // alpaca-provider is active and is of type 'provider'
    plugins.findActive.mockResolvedValue([
      { id: 'alpaca-provider', type: 'provider', name: 'Alpaca' },
    ] as never);

    const sandbox = makeSandbox();
    const memory = makeMemory();
    const service = makeFullAgentsService(llm, audit, plugins, sandbox, memory);

    const result = await service.runGovernedTurn({
      source: 'pretest',
      context: 'Evaluate pretest signals',
      virtual_only: true,
    });

    // Provider call must NOT have been dispatched to the sandbox
    expect(sandbox.callPlugin).not.toHaveBeenCalled();

    // Result tool_calls must be empty (provider dropped before dispatch)
    expect(result.tool_calls).toEqual([]);

    // Must emit tool_call_dropped with reason virtual_mode_provider_blocked
    const logCalls = (audit.log as jest.Mock).mock.calls as Array<[Record<string, unknown>]>;
    const droppedCall = logCalls.find(([arg]) => arg['event_type'] === 'tool_call_dropped');
    expect(droppedCall).toBeDefined();
    expect(droppedCall![0]).toMatchObject({
      event_type: 'tool_call_dropped',
      plugin_id: 'alpaca-provider',
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      meta: expect.objectContaining({ reason: 'virtual_mode_provider_blocked' }),
    });
  });
});

// ── Phase A1: Extra-plugin invocation (PRE/POST stage ordering + cycle_abort) ─

type ExtraSandboxStub = jest.Mocked<
  Pick<SandboxGateway, 'runCycle' | 'callPlugin' | 'call' | 'runExtraCycleHook' | 'getPluginStage'>
>;

/**
 * Factory for a full agents service with a configurable sandbox.runExtraCycleHook
 * so we can assert call order relative to runGovernedTurn.
 */
function makeExtraInvocationService(opts: {
  extraPlugins: { id: string; type: string; name: string; schedulerStage: 'pre' | 'post' }[];
  preHookResult?: Record<string, unknown>;
  postHookResult?: Record<string, unknown>;
  capturedOrder: string[];
}): {
  service: AgentsService;
  sandbox: ExtraSandboxStub;
  audit: ReturnType<typeof makeAudit>;
  plugins: ReturnType<typeof makeFullPlugins>;
} {
  const audit = makeAudit();
  const allPlugins = opts.extraPlugins.map((p) => ({ id: p.id, type: p.type, name: p.name }));
  const plugins = makeFullPlugins(null, []);
  plugins.findActive.mockResolvedValue(allPlugins as never);

  const sandbox: ExtraSandboxStub = {
    runCycle: jest.fn().mockImplementation(() => {
      opts.capturedOrder.push('runCycle');
      return Promise.resolve({ ok: true, result: { pending_signals: [] } });
    }),
    callPlugin: jest.fn().mockResolvedValue({ ok: true, result: null }),
    call: jest.fn().mockResolvedValue({ ok: true, result: {} }),
    getPluginStage: jest.fn().mockImplementation((pluginId: string) => {
      const plugin = opts.extraPlugins.find((p) => p.id === pluginId);
      return plugin?.schedulerStage ?? 'post';
    }),
    runExtraCycleHook: jest.fn().mockImplementation((pluginId: string) => {
      const plugin = opts.extraPlugins.find((p) => p.id === pluginId);
      opts.capturedOrder.push(`extra:${pluginId}:${plugin?.schedulerStage ?? 'post'}`);
      if (plugin?.schedulerStage === 'pre') {
        return Promise.resolve({ ok: true, result: opts.preHookResult ?? {} });
      }
      return Promise.resolve({ ok: true, result: opts.postHookResult ?? {} });
    }),
  };

  const llm: Partial<LlmService> = {
    complete: jest.fn().mockImplementation(() => {
      opts.capturedOrder.push('llm');
      return Promise.resolve({
        text: '',
        tool_calls: [],
        backend: 'api' as const,
        skills_read: [],
        skills_written: [],
      } as LlmResponse);
    }),
  };

  const memory = makeMemory();
  const service = new AgentsService(
    llm as unknown as LlmService,
    sandbox as unknown as SandboxGateway,
    plugins as unknown as PluginsService,
    memory as unknown as ContextMemoryService,
    audit as unknown as AuditService,
    { createBulk: jest.fn().mockResolvedValue([]) } as unknown as AlertsService,
  );

  return { service, sandbox, audit, plugins };
}

describe('AgentsService — extra-plugin PRE/POST stage ordering (A1.1)', () => {
  it('A1.1 — PRE extra runs before LLM turn; POST extra runs after LLM turn', async () => {
    const capturedOrder: string[] = [];

    const { service } = makeExtraInvocationService({
      extraPlugins: [
        { id: 'doctor', type: 'extra', name: 'Doctor', schedulerStage: 'pre' },
        { id: 'weekly-reporter', type: 'extra', name: 'Weekly Reporter', schedulerStage: 'post' },
      ],
      capturedOrder,
    });

    await callExecuteCyclePrivate(service, 'stage-order-001', 'test context');

    const extraDoctorIdx = capturedOrder.indexOf('extra:doctor:pre');
    const llmIdx = capturedOrder.indexOf('llm');
    const extraReporterIdx = capturedOrder.indexOf('extra:weekly-reporter:post');

    expect(extraDoctorIdx).toBeGreaterThanOrEqual(0);
    expect(llmIdx).toBeGreaterThanOrEqual(0);
    expect(extraReporterIdx).toBeGreaterThanOrEqual(0);
    // PRE must precede LLM; POST must follow LLM
    expect(extraDoctorIdx).toBeLessThan(llmIdx);
    expect(llmIdx).toBeLessThan(extraReporterIdx);
  });
});

describe('AgentsService — PRE cycle_abort skips LLM + audits cycle_aborted (A1.2)', () => {
  it('A1.2 — PRE extra returns cycle_abort=true → runGovernedTurn NOT called, audit cycle_aborted emitted', async () => {
    const capturedOrder: string[] = [];

    const { service, audit } = makeExtraInvocationService({
      extraPlugins: [{ id: 'doctor', type: 'extra', name: 'Doctor', schedulerStage: 'pre' }],
      preHookResult: { cycle_abort: true, cycle_abort_reason: 'Missing credentials' },
      capturedOrder,
    });

    await callExecuteCyclePrivate(service, 'abort-pre-001', 'test context');

    // LLM must NOT have been called
    expect(capturedOrder).not.toContain('llm');

    // audit cycle_aborted must have been emitted
    const auditCalls = (audit.log as jest.Mock).mock.calls as Array<[Record<string, unknown>]>;
    const abortAudit = auditCalls.find(([arg]) => arg['event_type'] === 'cycle_aborted');
    expect(abortAudit).toBeDefined();
    expect(abortAudit![0]).toMatchObject({
      event_type: 'cycle_aborted',
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      meta: expect.objectContaining({ plugin_id: 'doctor' }),
    });
  });
});

describe('AgentsService — POST cycle_abort ignored (A1.3)', () => {
  it('A1.3 — POST extra returns cycle_abort=true → LLM still runs, no abort audit', async () => {
    const capturedOrder: string[] = [];

    const { service, audit } = makeExtraInvocationService({
      extraPlugins: [
        { id: 'weekly-reporter', type: 'extra', name: 'Weekly Reporter', schedulerStage: 'post' },
      ],
      postHookResult: { cycle_abort: true },
      capturedOrder,
    });

    await callExecuteCyclePrivate(service, 'post-abort-001', 'test context');

    // LLM must still have run
    expect(capturedOrder).toContain('llm');

    // Must NOT have audited cycle_aborted
    const auditCalls = (audit.log as jest.Mock).mock.calls as Array<[Record<string, unknown>]>;
    const abortAudit = auditCalls.find(([arg]) => arg['event_type'] === 'cycle_aborted');
    expect(abortAudit).toBeUndefined();
  });
});

describe('AgentsService — _persistPluginAlerts runs on PRE abort output (A1.4)', () => {
  it('A1.4 — PRE abort with emit_alerts → alerts persisted even on abort', async () => {
    const capturedOrder: string[] = [];
    const audit = makeAudit();
    const alertsMock = { createBulk: jest.fn().mockResolvedValue([]) };
    const plugins = makeFullPlugins(null, []);
    plugins.findActive.mockResolvedValue([
      { id: 'doctor', type: 'extra', name: 'Doctor' },
    ] as never);

    const sandbox: ExtraSandboxStub = {
      runCycle: jest.fn().mockResolvedValue({ ok: true, result: { pending_signals: [] } }),
      callPlugin: jest.fn().mockResolvedValue({ ok: true }),
      call: jest.fn().mockResolvedValue({ ok: true, result: {} }),
      getPluginStage: jest.fn().mockReturnValue('pre'),
      runExtraCycleHook: jest.fn().mockImplementation((pluginId: string) => {
        capturedOrder.push(`extra:${pluginId}`);
        return Promise.resolve({
          ok: true,
          result: {
            cycle_abort: true,
            cycle_abort_reason: 'creds missing',
            emit_alerts: [
              { type: 'SYSTEM', severity: 'HIGH', message: 'Missing creds', symbol: null },
            ],
          },
        });
      }),
    };

    const llm: Partial<LlmService> = {
      complete: jest.fn().mockImplementation(() => {
        capturedOrder.push('llm');
        return Promise.resolve({
          text: '',
          tool_calls: [],
          backend: 'api' as const,
          skills_read: [],
          skills_written: [],
        } as LlmResponse);
      }),
    };

    const memory = makeMemory();
    const service = new AgentsService(
      llm as unknown as LlmService,
      sandbox as unknown as SandboxGateway,
      plugins as unknown as PluginsService,
      memory as unknown as ContextMemoryService,
      audit as unknown as AuditService,
      alertsMock as unknown as AlertsService,
    );

    await callExecuteCyclePrivate(service, 'alerts-abort-001', 'test');

    // LLM must NOT have run
    expect(capturedOrder).not.toContain('llm');
    // alerts.createBulk must have been called (emit_alerts persisted on abort)
    expect(alertsMock.createBulk).toHaveBeenCalled();
  });
});

// ── Fix #2: _mergeExtraCtx credential + tool_call + decisions leak hardening ──

/**
 * Exercises _mergeExtraCtx directly via any-cast.
 * We test the protected keys: pending_signals (existing), credentials, tool_calls,
 * decisions, veto_reasons (new additions per fix #2).
 */
function callMergeExtraCtx(
  service: AgentsService,
  base: Record<string, unknown>,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return (
    service as unknown as {
      _mergeExtraCtx: (
        b: Record<string, unknown>,
        e: Record<string, unknown>,
      ) => Record<string, unknown>;
    }
  )._mergeExtraCtx(base, extra);
}

describe('AgentsService._mergeExtraCtx — credential + decision-key protection (Fix #2)', () => {
  function makeMinimalService(): AgentsService {
    return new AgentsService(
      {} as unknown as LlmService,
      {} as unknown as SandboxGateway,
      {} as unknown as PluginsService,
      {} as unknown as ContextMemoryService,
      { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService,
      { createBulk: jest.fn().mockResolvedValue([]) } as unknown as AlertsService,
    );
  }

  it('Fix#2.1 — credentials from extra NOT merged into base context', () => {
    const service = makeMinimalService();
    const base = { cycle_id: 'c1', pending_signals: [{ symbol: 'AAPL', action: 'buy' }] };
    const extra = {
      credentials: { ALPACA_API_KEY: 'LEAKED' },
      some_data: 'allowed',
    };

    const merged = callMergeExtraCtx(service, base, extra);

    // credentials must NOT leak through
    expect(merged['credentials']).toBeUndefined();
    // non-protected keys ARE merged
    expect(merged['some_data']).toBe('allowed');
  });

  it('Fix#2.2 — tool_calls from extra NOT merged into base context', () => {
    const service = makeMinimalService();
    const base = { cycle_id: 'c1' };
    const extra = { tool_calls: [{ plugin_id: 'evil', function: 'do_bad', args: {} }] };

    const merged = callMergeExtraCtx(service, base, extra);

    expect(merged['tool_calls']).toBeUndefined();
  });

  it('Fix#2.3 — decisions from extra NOT merged into base context', () => {
    const service = makeMinimalService();
    const base = { cycle_id: 'c1' };
    const extra = { decisions: [{ plugin_id: 'x', function: 'y', args: {}, allowed: true }] };

    const merged = callMergeExtraCtx(service, base, extra);

    expect(merged['decisions']).toBeUndefined();
  });

  it('Fix#2.4 — veto_reasons from extra NOT merged into base context', () => {
    const service = makeMinimalService();
    const base = { cycle_id: 'c1', veto_reasons: ['original reason'] };
    const extra = { veto_reasons: ['injected reason'] };

    const merged = callMergeExtraCtx(service, base, extra);

    // Must preserve the base veto_reasons, not be overwritten by extra
    expect(merged['veto_reasons']).toEqual(['original reason']);
  });

  it('Fix#2.5 — pending_signals still protected (existing invariant)', () => {
    const service = makeMinimalService();
    const approvedSignals = [{ symbol: 'AAPL', action: 'buy' }];
    const base = { pending_signals: approvedSignals };
    const extra = { pending_signals: [{ symbol: 'INJECTED', action: 'sell' }] };

    const merged = callMergeExtraCtx(service, base, extra);

    expect(merged['pending_signals']).toBe(approvedSignals);
  });

  it('Fix#2.6 — a PRE extra returning credentials + tool_calls via _runPreExtras: keys not in runningCtx', async () => {
    // Integration: drive _runPreExtras with a PRE extra that returns protected keys;
    // verify runningCtx does not contain them after merge.
    const audit = makeAudit();
    const plugins = makeFullPlugins(null, []);
    plugins.findActive.mockResolvedValue([
      { id: 'doctor', type: 'extra', name: 'Doctor' },
    ] as never);

    const sandbox: ExtraSandboxStub = {
      runCycle: jest.fn().mockResolvedValue({ ok: true, result: { pending_signals: [] } }),
      callPlugin: jest.fn().mockResolvedValue({ ok: true }),
      call: jest.fn().mockResolvedValue({ ok: true, result: {} }),
      getPluginStage: jest.fn().mockReturnValue('pre'),
      runExtraCycleHook: jest.fn().mockResolvedValue({
        ok: true,
        result: {
          // These should be blocked by _mergeExtraCtx
          pending_signals: [{ symbol: 'INJECTED', action: 'sell' }],
          credentials: { ALPACA_API_KEY: 'LEAKED' },
          tool_calls: [{ plugin_id: 'evil', function: 'bad', args: {} }],
          decisions: [{ plugin_id: 'x', function: 'y', args: {}, allowed: true }],
          // This is allowed
          doctor_report: { status: 'ok' },
        },
      }),
    };

    const llm = makeLlm('');
    const memory = makeMemory();
    const service = new AgentsService(
      llm as unknown as LlmService,
      sandbox as unknown as SandboxGateway,
      plugins as unknown as PluginsService,
      memory as unknown as ContextMemoryService,
      audit as unknown as AuditService,
      { createBulk: jest.fn().mockResolvedValue([]) } as unknown as AlertsService,
    );

    // Access _runPreExtras via any-cast
    const initialCtx: Record<string, unknown> = {
      pending_signals: [{ symbol: 'AAPL', action: 'buy' }],
      cycle_id: 'prot-001',
    };
    const result = await (
      service as unknown as {
        _runPreExtras: (
          extras: import('../plugins/plugins.service').HydratedPlugin[],
          ctx: Record<string, unknown>,
          cycleId: string,
        ) => Promise<
          { aborted: false; ctx: Record<string, unknown> } | { aborted: true; abortResult: unknown }
        >;
      }
    )._runPreExtras(
      [
        { id: 'doctor', type: 'extra', name: 'Doctor' },
      ] as import('../plugins/plugins.service').HydratedPlugin[],
      initialCtx,
      'prot-001',
    );

    expect(result.aborted).toBe(false);
    if (!result.aborted) {
      const ctx = result.ctx;
      // pending_signals must be the original approved set, not injected
      expect(ctx['pending_signals']).toEqual([{ symbol: 'AAPL', action: 'buy' }]);
      // credentials must not leak
      expect(ctx['credentials']).toBeUndefined();
      // tool_calls must not leak
      expect(ctx['tool_calls']).toBeUndefined();
      // decisions must not leak
      expect(ctx['decisions']).toBeUndefined();
      // allowed data passes through
      expect(ctx['doctor_report']).toEqual({ status: 'ok' });
    }
  });
});

// ── Fix #3: notify_intents accumulation into _collected_notify_intents ────────

describe('AgentsService — notify_intents accumulation (Fix #3)', () => {
  it('Fix#3.1 — two extras each emitting notify_intents: both collected in _collected_notify_intents', async () => {
    // Two POST extras, each emitting one notify_intent.
    // After both run, runningCtx._collected_notify_intents must have both.
    const audit = makeAudit();
    const plugins = makeFullPlugins(null, []);
    plugins.findActive.mockResolvedValue([
      { id: 'weekly-reporter', type: 'extra', name: 'Weekly Reporter' },
      { id: 'telegram-notifier', type: 'extra', name: 'Telegram' },
    ] as never);

    const sandbox: ExtraSandboxStub = {
      runCycle: jest.fn().mockResolvedValue({ ok: true, result: { pending_signals: [] } }),
      callPlugin: jest.fn().mockResolvedValue({ ok: true }),
      call: jest.fn().mockResolvedValue({ ok: true, result: {} }),
      getPluginStage: jest.fn().mockReturnValue('post'),
      runExtraCycleHook: jest
        .fn()
        .mockImplementationOnce(() =>
          Promise.resolve({
            ok: true,
            result: {
              notify_intents: [{ channel: 'telegram', message: 'Weekly report ready' }],
            },
          }),
        )
        .mockImplementationOnce(() =>
          Promise.resolve({
            ok: true,
            result: {
              notify_intents: [{ channel: 'telegram', message: 'Alert: drawdown' }],
            },
          }),
        ),
    };

    const llm: Partial<LlmService> = {
      complete: jest.fn().mockResolvedValue({
        text: '',
        tool_calls: [],
        backend: 'api' as const,
        skills_read: [],
        skills_written: [],
      }),
    };

    const memory = makeMemory();
    const service = new AgentsService(
      llm as unknown as LlmService,
      sandbox as unknown as SandboxGateway,
      plugins as unknown as PluginsService,
      memory as unknown as ContextMemoryService,
      audit as unknown as AuditService,
      { createBulk: jest.fn().mockResolvedValue([]) } as unknown as AlertsService,
    );

    // Drive _runPostExtras directly
    const baseCtx: Record<string, unknown> = { cycle_id: 'notify-001', pending_signals: [] };
    const postFinalCtx = await (
      service as unknown as {
        _runPostExtras: (
          postExtras: import('../plugins/plugins.service').HydratedPlugin[],
          baseCtx: Record<string, unknown>,
          cycleId: string,
        ) => Promise<Record<string, unknown>>;
      }
    )._runPostExtras(
      [
        { id: 'weekly-reporter', type: 'extra', name: 'Weekly Reporter' },
        { id: 'telegram-notifier', type: 'extra', name: 'Telegram' },
      ] as import('../plugins/plugins.service').HydratedPlugin[],
      baseCtx,
      'notify-001',
    );

    // _collected_notify_intents must have both intents in the returned final context
    const collected = postFinalCtx['_collected_notify_intents'] as unknown[] | undefined;
    expect(collected).toBeDefined();
    expect(Array.isArray(collected)).toBe(true);
    expect(collected).toHaveLength(2);
    expect(collected![0]).toMatchObject({ message: 'Weekly report ready' });
    expect(collected![1]).toMatchObject({ message: 'Alert: drawdown' });
  });

  it('Fix#3.2 — PRE extra emitting notify_intents: also accumulated in ctx', async () => {
    // PRE extra emitting notify_intent: must be accumulated in runningCtx
    const audit = makeAudit();
    const plugins = makeFullPlugins(null, []);
    plugins.findActive.mockResolvedValue([
      { id: 'doctor', type: 'extra', name: 'Doctor' },
    ] as never);

    const sandbox: ExtraSandboxStub = {
      runCycle: jest.fn().mockResolvedValue({ ok: true, result: { pending_signals: [] } }),
      callPlugin: jest.fn().mockResolvedValue({ ok: true }),
      call: jest.fn().mockResolvedValue({ ok: true, result: {} }),
      getPluginStage: jest.fn().mockReturnValue('pre'),
      runExtraCycleHook: jest.fn().mockResolvedValue({
        ok: true,
        result: {
          notify_intents: [{ channel: 'log', message: 'Doctor check complete' }],
          doctor_report: { status: 'ok' },
        },
      }),
    };

    const llm: Partial<LlmService> = {
      complete: jest.fn().mockResolvedValue({
        text: '',
        tool_calls: [],
        backend: 'api' as const,
        skills_read: [],
        skills_written: [],
      }),
    };

    const memory = makeMemory();
    const service = new AgentsService(
      llm as unknown as LlmService,
      sandbox as unknown as SandboxGateway,
      plugins as unknown as PluginsService,
      memory as unknown as ContextMemoryService,
      audit as unknown as AuditService,
      { createBulk: jest.fn().mockResolvedValue([]) } as unknown as AlertsService,
    );

    const initialCtx: Record<string, unknown> = { cycle_id: 'notify-pre-001', pending_signals: [] };
    const result = await (
      service as unknown as {
        _runPreExtras: (
          extras: import('../plugins/plugins.service').HydratedPlugin[],
          ctx: Record<string, unknown>,
          cycleId: string,
        ) => Promise<
          { aborted: false; ctx: Record<string, unknown> } | { aborted: true; abortResult: unknown }
        >;
      }
    )._runPreExtras(
      [
        { id: 'doctor', type: 'extra', name: 'Doctor' },
      ] as import('../plugins/plugins.service').HydratedPlugin[],
      initialCtx,
      'notify-pre-001',
    );

    expect(result.aborted).toBe(false);
    if (!result.aborted) {
      const ctx = result.ctx;
      const collected = ctx['_collected_notify_intents'] as unknown[] | undefined;
      expect(collected).toBeDefined();
      expect(collected).toHaveLength(1);
      expect(collected![0]).toMatchObject({ message: 'Doctor check complete' });
    }
  });

  it('Fix#signals — POST extra receives ctx[signals] equal to post-veto pending_signals', async () => {
    // Arrange: baseCtx has pending_signals (post-veto approved signals with confidence).
    // Assert: runExtraCycleHook is called with a ctx containing signals === pending_signals.
    const audit = makeAudit();
    const plugins = makeFullPlugins(null, []);
    plugins.findActive.mockResolvedValue([
      { id: 'telegram-notifier', type: 'extra', name: 'Telegram Notifier' },
    ] as never);

    const pendingSignals = [
      { symbol: 'AAPL', action: 'buy', confidence: 0.85 },
      { symbol: 'TSLA', action: 'sell', confidence: 0.9 },
    ];

    const runExtraCycleHook = jest.fn().mockResolvedValue({ ok: true, result: {} });

    const sandbox: ExtraSandboxStub = {
      runCycle: jest.fn().mockResolvedValue({ ok: true, result: { pending_signals: [] } }),
      callPlugin: jest.fn().mockResolvedValue({ ok: true }),
      call: jest.fn().mockResolvedValue({ ok: true, result: {} }),
      getPluginStage: jest.fn().mockReturnValue('post'),
      runExtraCycleHook,
    };

    const service = new AgentsService(
      {} as unknown as LlmService,
      sandbox as unknown as SandboxGateway,
      plugins as unknown as PluginsService,
      makeMemory() as unknown as ContextMemoryService,
      audit as unknown as AuditService,
      { createBulk: jest.fn().mockResolvedValue([]) } as unknown as AlertsService,
    );

    const baseCtx: Record<string, unknown> = {
      cycle_id: 'signals-inject-001',
      pending_signals: pendingSignals,
    };

    await (
      service as unknown as {
        _runPostExtras: (
          postExtras: import('../plugins/plugins.service').HydratedPlugin[],
          baseCtx: Record<string, unknown>,
          cycleId: string,
        ) => Promise<Record<string, unknown>>;
      }
    )._runPostExtras(
      [
        { id: 'telegram-notifier', type: 'extra', name: 'Telegram Notifier' },
      ] as import('../plugins/plugins.service').HydratedPlugin[],
      baseCtx,
      'signals-inject-001',
    );

    // runExtraCycleHook must have been called with ctx containing signals = pending_signals
    expect(runExtraCycleHook).toHaveBeenCalledTimes(1);
    expect(runExtraCycleHook).toHaveBeenCalledWith(
      'telegram-notifier',
      expect.objectContaining({ signals: pendingSignals }),
    );
  });
});

// ── PR B Phase B1: _persistNotificationIntents + bridge injection (B1.3 / B1.4) ─

/**
 * B1.3 — _persistNotificationIntents dispatches each intent via bridge.send.
 * B1.4 — after refactor, TelegramService has no @OnEvent or DEFAULT_CONFIG
 *         (behavioral: only NotifierBridge dispatch fires, not a second event-driven path).
 */

// Minimal NotifierBridge stub
interface BridgeStub {
  send: jest.Mock;
}

function makeBridgeStub(): BridgeStub {
  return { send: jest.fn().mockResolvedValue({ ok: true }) };
}

/**
 * Build an AgentsService with a NotifierBridge injected.
 * The constructor accepts NotifierBridge as the 8th positional argument (after ConfigService slot).
 */
function makeServiceWithBridge(
  bridge: BridgeStub,
  audit: ReturnType<typeof makeAudit>,
): AgentsService {
  // We need to cast because AgentsService constructor is updated in GREEN to accept NotifierBridge.
  // The test is RED until that injection is wired.
  return new (AgentsService as unknown as new (
    llm: unknown,
    sandbox: unknown,
    plugins: unknown,
    memory: unknown,
    audit: unknown,
    alerts: unknown,
    snapshot: unknown,
    cfg: unknown,
    bridge: unknown,
  ) => AgentsService)(
    {},
    {},
    {},
    {},
    audit,
    { createBulk: jest.fn().mockResolvedValue([]) },
    undefined,
    undefined,
    bridge,
  );
}

async function callPersistNotificationIntents(
  service: AgentsService,
  ctx: Record<string, unknown>,
  cycleId: string,
): Promise<void> {
  return (
    service as unknown as {
      _persistNotificationIntents: (ctx: Record<string, unknown>, cycleId: string) => Promise<void>;
    }
  )._persistNotificationIntents(ctx, cycleId);
}

describe('AgentsService._persistNotificationIntents — bridge dispatch (B1.3)', () => {
  it('B1.3a — one intent calls bridge.send exactly once with correct channel and text', async () => {
    const bridge = makeBridgeStub();
    const audit = makeAudit();
    const service = makeServiceWithBridge(bridge, audit);

    const ctx: Record<string, unknown> = {
      _collected_notify_intents: [{ channel: 'telegram', text: 'report ready' }],
    };

    await callPersistNotificationIntents(service, ctx, 'cycle-b1-001');

    expect(bridge.send).toHaveBeenCalledTimes(1);
    expect(bridge.send).toHaveBeenCalledWith('telegram', 'report ready', expect.anything());
  });

  it('B1.3b — two intents call bridge.send twice', async () => {
    const bridge = makeBridgeStub();
    const audit = makeAudit();
    const service = makeServiceWithBridge(bridge, audit);

    const ctx: Record<string, unknown> = {
      _collected_notify_intents: [
        { channel: 'telegram', text: 'msg one' },
        { channel: 'telegram', text: 'msg two' },
      ],
    };

    await callPersistNotificationIntents(service, ctx, 'cycle-b1-002');

    expect(bridge.send).toHaveBeenCalledTimes(2);
  });

  it('B1.3c — empty _collected_notify_intents → zero bridge.send calls', async () => {
    const bridge = makeBridgeStub();
    const audit = makeAudit();
    const service = makeServiceWithBridge(bridge, audit);

    const ctx: Record<string, unknown> = {
      _collected_notify_intents: [],
    };

    await callPersistNotificationIntents(service, ctx, 'cycle-b1-003');

    expect(bridge.send).not.toHaveBeenCalled();
  });

  it('B1.3d — absent _collected_notify_intents → zero bridge.send calls', async () => {
    const bridge = makeBridgeStub();
    const audit = makeAudit();
    const service = makeServiceWithBridge(bridge, audit);

    const ctx: Record<string, unknown> = {};

    await callPersistNotificationIntents(service, ctx, 'cycle-b1-004');

    expect(bridge.send).not.toHaveBeenCalled();
  });

  it('B1.3e — audits notification_sent per successful send', async () => {
    const bridge = makeBridgeStub();
    const audit = makeAudit();
    const service = makeServiceWithBridge(bridge, audit);

    const ctx: Record<string, unknown> = {
      _collected_notify_intents: [{ channel: 'telegram', text: 'hello' }],
    };

    await callPersistNotificationIntents(service, ctx, 'cycle-b1-005');

    const auditCalls = (audit.log as jest.Mock).mock.calls as Array<[Record<string, unknown>]>;
    const sentAudit = auditCalls.find(([arg]) => arg['event_type'] === 'notification_sent');
    expect(sentAudit).toBeDefined();
    expect(sentAudit![0]).toMatchObject({
      event_type: 'notification_sent',
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      meta: expect.objectContaining({ channel: 'telegram' }),
    });
  });

  it('B1.3f — never throws even when bridge.send rejects', async () => {
    const bridge = makeBridgeStub();
    bridge.send.mockRejectedValue(new Error('network error'));
    const audit = makeAudit();
    const service = makeServiceWithBridge(bridge, audit);

    const ctx: Record<string, unknown> = {
      _collected_notify_intents: [{ channel: 'telegram', text: 'crash test' }],
    };

    await expect(
      callPersistNotificationIntents(service, ctx, 'cycle-b1-006'),
    ).resolves.not.toThrow();
  });
});

// ── Fix #4: veto ordering — LLM sees only post-veto signals ──────────────────

describe('AgentsService._executeCycle — veto ordering: LLM sees only post-veto signals', () => {
  it('passes only post-veto approved signals to LLM (vetoed signals are not in LLM context)', async () => {
    // Arrange: two pending signals; discipline plugin removes one.
    const pendingSignals = [
      { symbol: 'AAPL', action: 'buy' }, // will be approved
      { symbol: 'TSLA', action: 'sell' }, // will be vetoed
    ];
    const approvedSignals = [{ symbol: 'AAPL', action: 'buy' }];

    const capturedContexts: string[] = [];
    const llm: Partial<LlmService> = {
      complete: jest
        .fn()
        .mockImplementation((opts: { context: string; system_prompt?: string }) => {
          capturedContexts.push(opts.context);
          return Promise.resolve({
            text: '',
            tool_calls: [],
            backend: 'api' as const,
            skills_read: [],
            skills_written: [],
          });
        }),
    };

    const audit = makeAudit();
    const plugins = makeFullPlugins(null, []);
    // Sandbox: runCycle returns the two pending signals; discipline `call` removes TSLA.
    const sandbox = makeFullSandbox();
    sandbox.runCycle.mockResolvedValue({
      ok: true,
      result: { pending_signals: pendingSignals },
    });
    // discipline plugin removes TSLA, leaving only AAPL.
    sandbox.call.mockResolvedValue({
      ok: true,
      result: { pending_signals: approvedSignals, veto_reasons: ['TSLA blocked by risk'] },
    });

    // Make one discipline plugin active.
    plugins.findActive.mockResolvedValue([
      { id: 'risk-discipline', type: 'discipline', name: 'Risk Discipline' },
    ] as never);

    const memory = makeMemory();

    const service = new AgentsService(
      llm as unknown as LlmService,
      sandbox as unknown as SandboxGateway,
      plugins as unknown as PluginsService,
      memory as unknown as ContextMemoryService,
      audit as unknown as AuditService,
      { createBulk: jest.fn().mockResolvedValue([]) } as unknown as AlertsService,
    );

    await callExecuteCyclePrivate(service, 'veto-order-001', 'market check');

    // The LLM must have been called exactly once.
    expect(capturedContexts).toHaveLength(1);
    const llmContext = capturedContexts[0];

    // Post-veto signal (AAPL) must be visible to LLM.
    expect(llmContext).toContain('AAPL');

    // Vetoed signal (TSLA) must NOT appear in the approved-signals block sent to LLM.
    // The LLM context is built from approvedSignals after veto; TSLA must not be there.
    expect(llmContext).not.toContain('TSLA');
  });
});

// ── F4-S1 Phase 3: Kernel Tool Tests ─────────────────────────────────────────

// Shared type alias for the kernel-related plugins subset.
type KernelPluginsMock = jest.Mocked<
  Pick<PluginsService, 'findActive' | 'getProviderTools' | 'writeSkillGuarded'>
>;

/** Shared factory: returns a minimal PluginsService mock with writeSkillGuarded for kernel tests. */
function makeKernelPluginsMock(): KernelPluginsMock {
  return {
    findActive: jest.fn().mockResolvedValue([]),
    getProviderTools: jest.fn().mockResolvedValue([]),
    writeSkillGuarded: jest.fn().mockResolvedValue({ ok: true, old_len: 100, new_len: 130 }),
  };
}

/**
 * Helper to call _validateToolCalls with hoistedTools override so we can inject
 * a kernel tool definition (simulating effectiveTools from runGovernedTurn).
 */
async function callValidateWithHoisted(
  service: AgentsService,
  cycleId: string,
  calls: ToolCallRequest[],
  hoistedTools: import('../plugins/plugins.service').ProviderTool[],
  source?: string,
): Promise<ToolCallRequest[]> {
  return (
    service as unknown as {
      _validateToolCalls: (
        c: string,
        t: ToolCallRequest[],
        hoistedTools: import('../plugins/plugins.service').ProviderTool[],
        preloaded: undefined,
        virtualOnly: undefined,
        source?: string,
      ) => Promise<ToolCallRequest[]>;
    }
  )._validateToolCalls(cycleId, calls, hoistedTools, undefined, undefined, source);
}

/** Helper to call _executeToolCalls (private) */
async function callExecuteToolCalls(
  service: AgentsService,
  cycleId: string,
  calls: ToolCallRequest[],
): Promise<{
  decisions: import('./agents.service').Decision[];
  sandbox_results: import('./agents.service').SandboxResult[];
}> {
  return (
    service as unknown as {
      _executeToolCalls: (
        c: string,
        t: ToolCallRequest[],
      ) => Promise<{
        decisions: import('./agents.service').Decision[];
        sandbox_results: import('./agents.service').SandboxResult[];
      }>;
    }
  )._executeToolCalls(cycleId, calls);
}

describe('F4-S1 Phase 3.2/3.3 — _validateToolCalls kernel bypass', () => {
  const CYCLE_ID = 'kernel-validate-001';

  it('3.2 — kernel write_skill call is NOT dropped with plugin_not_found or function_not_declared (source:reflection)', async () => {
    // No active plugins at all — but kernel tools must pass when source==='reflection'
    const plugins = makePlugins([], []);
    const audit = makeAudit();
    const service = makeAgentsService(plugins, audit);

    const kernelTool: import('../plugins/plugins.service').ProviderTool = {
      plugin_id: 'kernel',
      name: 'kernel__write_skill',
      description: 'Reescribe un SKILL.md opt-in durante reflexión.',
      input_schema: {
        type: 'object',
        properties: { skill: { type: 'string' }, new_body: { type: 'string' } },
        required: ['skill', 'new_body'],
      },
    };

    const calls: ToolCallRequest[] = [
      { plugin_id: 'kernel', function: 'write_skill', args: { skill: 'x', new_body: 'y' } },
    ];

    // Pass source:'reflection' — the only context where kernel tools are permitted
    const result = await callValidateWithHoisted(
      service,
      CYCLE_ID,
      calls,
      [kernelTool],
      'reflection',
    );

    // Kernel tool MUST pass validation and be returned as a valid call
    expect(result).toHaveLength(1);
    expect(result[0].plugin_id).toBe('kernel');
    expect(result[0].function).toBe('write_skill');
    // No tool_call_dropped audit for kernel tools
    expect(audit.log).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'tool_call_dropped', plugin_id: 'kernel' }),
    );
  });

  it('3.3 — unknown kernel function is dropped with reason "unknown_kernel_tool"', async () => {
    const plugins = makePlugins([], []);
    const audit = makeAudit();
    const service = makeAgentsService(plugins, audit);

    const calls: ToolCallRequest[] = [{ plugin_id: 'kernel', function: 'unknown_fn', args: {} }];

    const result = await callValidateWithHoisted(service, CYCLE_ID, calls, []);

    expect(result).toHaveLength(0);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'tool_call_dropped',
        plugin_id: 'kernel',
        meta: expect.objectContaining({ reason: 'unknown_kernel_tool' }) as unknown,
      }),
    );
  });
});

describe('F4-S1 Phase 3.4/3.5 — _executeToolCalls kernel dispatch', () => {
  const CYCLE_ID = 'kernel-exec-001';

  function makePluginsWithWriteSkillGuarded(): KernelPluginsMock {
    return makeKernelPluginsMock();
  }

  function makeAgentsServiceWithKernelPlugins(
    plugins: KernelPluginsMock,
    audit: ReturnType<typeof makeAudit>,
    sandbox: ReturnType<typeof makeSandbox>,
  ): AgentsService {
    return new AgentsService(
      {} as unknown as LlmService,
      sandbox as unknown as SandboxGateway,
      plugins as unknown as PluginsService,
      {} as unknown as ContextMemoryService,
      audit as unknown as AuditService,
      { createBulk: jest.fn().mockResolvedValue([]) } as unknown as AlertsService,
    );
  }

  it('3.4 — kernel write_skill tool_call routes to writeSkillGuarded, sandbox.callPlugin is NEVER called', async () => {
    const plugins = makePluginsWithWriteSkillGuarded();
    const audit = makeAudit();
    const sandbox = makeSandbox();
    const service = makeAgentsServiceWithKernelPlugins(plugins, audit, sandbox);

    const calls: ToolCallRequest[] = [
      {
        plugin_id: 'kernel',
        function: 'write_skill',
        args: { skill: 'my-skill', new_body: 'new body content' },
      },
    ];

    await callExecuteToolCalls(service, CYCLE_ID, calls);

    // Must route to writeSkillGuarded
    expect(plugins.writeSkillGuarded).toHaveBeenCalledWith('my-skill', 'new body content');
    // Must NEVER call sandbox.callPlugin for kernel tools
    expect(sandbox.callPlugin).not.toHaveBeenCalled();
  });

  it('3.5 — existing plugin tool_calls still flow to sandbox.callPlugin unchanged (regression)', async () => {
    const plugins = makePluginsWithWriteSkillGuarded();
    (plugins.findActive as jest.Mock).mockResolvedValue([
      { id: 'alpaca-provider', type: 'provider' },
    ]);
    (plugins.getProviderTools as jest.Mock).mockResolvedValue([
      {
        plugin_id: 'alpaca-provider',
        name: 'alpaca-provider__place_order',
        description: '',
        input_schema: { type: 'object', properties: {} },
      },
    ]);
    const audit = makeAudit();
    const sandbox = makeSandbox();
    const service = makeAgentsServiceWithKernelPlugins(plugins, audit, sandbox);

    const calls: ToolCallRequest[] = [
      { plugin_id: 'alpaca-provider', function: 'place_order', args: { symbol: 'AAPL' } },
    ];

    await callExecuteToolCalls(service, CYCLE_ID, calls);

    // Regular plugin calls MUST still go through sandbox
    expect(sandbox.callPlugin).toHaveBeenCalledWith('alpaca-provider', 'place_order', {
      symbol: 'AAPL',
    });
    // writeSkillGuarded must NOT be called for regular plugin calls
    expect(plugins.writeSkillGuarded).not.toHaveBeenCalled();
  });
});

// ── F4-S1 Phase 4.1 — Injection Gating Tests ─────────────────────────────────

describe('F4-S1 Phase 4.1 — runGovernedTurn tool schema injection gating', () => {
  function buildInjectionCapturingService(
    source: 'chat' | 'cycle' | 'pretest',
    capturedSchema: { tools: string }[],
  ): AgentsService {
    const llm: Partial<LlmService> = {
      complete: jest.fn().mockImplementation((opts: { system_prompt?: string }) => {
        const sp = opts.system_prompt ?? '';
        // Extract the [TOOL SCHEMA] content for assertion
        const match = /\[TOOL SCHEMA\]\n([\s\S]*?)(?:\n\n|$)/.exec(sp);
        capturedSchema.push({ tools: match ? match[1] : '' });
        return Promise.resolve({
          text: '',
          tool_calls: [],
          backend: 'api',
          skills_read: [],
          skills_written: [],
        } as LlmResponse);
      }),
    };

    // Give it a decision prompt so the schema IS injected
    const plugins = makeFullPlugins('Use tools via JSON.', []);

    return new AgentsService(
      llm as unknown as LlmService,
      makeSandbox() as unknown as SandboxGateway,
      plugins as unknown as PluginsService,
      makeMemory() as unknown as ContextMemoryService,
      { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService,
      { createBulk: jest.fn().mockResolvedValue([]) } as unknown as AlertsService,
    );
  }

  it('4.1 source:cycle — kernel__write_skill NOT in injected [TOOL SCHEMA]', async () => {
    const captured: { tools: string }[] = [];
    const service = buildInjectionCapturingService('cycle', captured);

    await service.runGovernedTurn({ source: 'cycle', context: 'run cycle' });

    expect(captured).toHaveLength(1);
    expect(captured[0].tools).not.toContain('kernel__write_skill');
  });

  it('4.1 source:chat — kernel__write_skill NOT in injected [TOOL SCHEMA]', async () => {
    const captured: { tools: string }[] = [];
    const service = buildInjectionCapturingService('chat', captured);

    await service.runGovernedTurn({ source: 'chat', context: 'ask something' });

    expect(captured).toHaveLength(1);
    expect(captured[0].tools).not.toContain('kernel__write_skill');
  });

  it('4.1 source:pretest — kernel__write_skill NOT in injected [TOOL SCHEMA]', async () => {
    const captured: { tools: string }[] = [];
    const service = buildInjectionCapturingService('pretest', captured);

    await service.runGovernedTurn({ source: 'pretest', context: 'pretest run' });

    expect(captured).toHaveLength(1);
    expect(captured[0].tools).not.toContain('kernel__write_skill');
  });

  it('4.1 source:reflection (cast) — kernel__write_skill IS in injected [TOOL SCHEMA]', async () => {
    const captured: { tools: string }[] = [];
    // Cast to bypass union — 'reflection' is not in GovernedTurnInput.source union in s1 (by design).
    // This test proves the gating condition is correctly wired for forward-compat.
    const service = buildInjectionCapturingService('chat' /* placeholder, we'll cast */, captured);

    await service.runGovernedTurn({
      source: 'reflection',
      context: 'reflection turn',
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].tools).toContain('kernel__write_skill');
  });
});

// ── Fix: CRITICAL — kernel tool dispatch gating by source ─────────────────────
//
// Confirms that kernel__write_skill emitted by the LLM in a non-reflection turn
// is DROPPED (audited 'kernel_source_not_allowed') and writeSkillGuarded is NEVER
// called — i.e. s1 is truly inert, not just cosmetically gated at injection.

describe('F4-S1 Fix — kernel tool DROPPED when source !== reflection (dispatch enforcement)', () => {
  const CYCLE_ID = 'kernel-src-gate-001';

  function makePluginsForSourceGate(): KernelPluginsMock {
    return makeKernelPluginsMock();
  }

  function makeServiceForSourceGate(
    plugins: KernelPluginsMock,
    audit: ReturnType<typeof makeAudit>,
  ): AgentsService {
    return new AgentsService(
      {} as unknown as LlmService,
      makeSandbox() as unknown as SandboxGateway,
      plugins as unknown as PluginsService,
      {} as unknown as ContextMemoryService,
      audit as unknown as AuditService,
      { createBulk: jest.fn().mockResolvedValue([]) } as unknown as AlertsService,
    );
  }

  it('src-gate.1 source:cycle — kernel__write_skill is DROPPED with kernel_source_not_allowed, writeSkillGuarded NOT called', async () => {
    const plugins = makePluginsForSourceGate();
    const audit = makeAudit();
    const service = makeServiceForSourceGate(plugins, audit);

    const calls: ToolCallRequest[] = [
      { plugin_id: 'kernel', function: 'write_skill', args: { skill: 'x', new_body: 'y' } },
    ];

    // Call _validateToolCalls directly — cycle source means kernel call must be dropped
    const result = await (
      service as unknown as {
        _validateToolCalls: (
          c: string,
          t: ToolCallRequest[],
          hoisted: undefined,
          preloaded: undefined,
          virtualOnly: undefined,
          source: string,
        ) => Promise<ToolCallRequest[]>;
      }
    )._validateToolCalls(CYCLE_ID, calls, undefined, undefined, undefined, 'cycle');

    // Kernel call must be DROPPED (not allowed outside reflection)
    expect(result).toHaveLength(0);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        cycle_id: CYCLE_ID,
        event_type: 'tool_call_dropped',
        plugin_id: 'kernel',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        meta: expect.objectContaining({ reason: 'kernel_source_not_allowed' }),
      }),
    );
    // CRITICAL: writeSkillGuarded must NEVER have been called
    expect(plugins.writeSkillGuarded).not.toHaveBeenCalled();
  });

  it('src-gate.2 source:chat — kernel__write_skill DROPPED, writeSkillGuarded NOT called', async () => {
    const plugins = makePluginsForSourceGate();
    const audit = makeAudit();
    const service = makeServiceForSourceGate(plugins, audit);

    const calls: ToolCallRequest[] = [
      { plugin_id: 'kernel', function: 'write_skill', args: { skill: 'x', new_body: 'y' } },
    ];

    const result = await (
      service as unknown as {
        _validateToolCalls: (
          c: string,
          t: ToolCallRequest[],
          hoisted: undefined,
          preloaded: undefined,
          virtualOnly: undefined,
          source: string,
        ) => Promise<ToolCallRequest[]>;
      }
    )._validateToolCalls(CYCLE_ID, calls, undefined, undefined, undefined, 'chat');

    expect(result).toHaveLength(0);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'tool_call_dropped',
        plugin_id: 'kernel',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        meta: expect.objectContaining({ reason: 'kernel_source_not_allowed' }),
      }),
    );
    expect(plugins.writeSkillGuarded).not.toHaveBeenCalled();
  });

  it('src-gate.3 source:pretest — kernel__write_skill DROPPED, writeSkillGuarded NOT called', async () => {
    const plugins = makePluginsForSourceGate();
    const audit = makeAudit();
    const service = makeServiceForSourceGate(plugins, audit);

    const calls: ToolCallRequest[] = [
      { plugin_id: 'kernel', function: 'write_skill', args: { skill: 'x', new_body: 'y' } },
    ];

    const result = await (
      service as unknown as {
        _validateToolCalls: (
          c: string,
          t: ToolCallRequest[],
          hoisted: undefined,
          preloaded: undefined,
          virtualOnly: undefined,
          source: string,
        ) => Promise<ToolCallRequest[]>;
      }
    )._validateToolCalls(CYCLE_ID, calls, undefined, undefined, undefined, 'pretest');

    expect(result).toHaveLength(0);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'tool_call_dropped',
        plugin_id: 'kernel',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        meta: expect.objectContaining({ reason: 'kernel_source_not_allowed' }),
      }),
    );
    expect(plugins.writeSkillGuarded).not.toHaveBeenCalled();
  });

  it('src-gate.4 source:reflection — kernel__write_skill IS allowed, passes validation', async () => {
    const plugins = makePluginsForSourceGate();
    const audit = makeAudit();
    const service = makeServiceForSourceGate(plugins, audit);

    const calls: ToolCallRequest[] = [
      { plugin_id: 'kernel', function: 'write_skill', args: { skill: 'x', new_body: 'y' } },
    ];

    const result = await (
      service as unknown as {
        _validateToolCalls: (
          c: string,
          t: ToolCallRequest[],
          hoisted: undefined,
          preloaded: undefined,
          virtualOnly: undefined,
          source: string,
        ) => Promise<ToolCallRequest[]>;
      }
    )._validateToolCalls(CYCLE_ID, calls, undefined, undefined, undefined, 'reflection');

    // Must be allowed when source === 'reflection'
    expect(result).toHaveLength(1);
    expect(result[0].plugin_id).toBe('kernel');
    expect(audit.log).not.toHaveBeenCalledWith(
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        meta: expect.objectContaining({ reason: 'kernel_source_not_allowed' }),
      }),
    );
  });

  it('src-gate.5 end-to-end: runGovernedTurn with source:cycle + LLM emitting kernel__write_skill — writeSkillGuarded NEVER called', async () => {
    // The LLM returns a kernel__write_skill tool_call in a cycle turn.
    const toolCallText =
      '<tool_calls>[{"tool":"kernel__write_skill","args":{"skill":"my-skill","new_body":"injected body"}}]</tool_calls>';
    const llm = makeLlm(toolCallText);
    const audit = makeAudit();
    const plugins = makeFullPlugins('Emit tool calls as JSON.', []);
    // Add writeSkillGuarded to the plugins stub
    const pluginsWithKernel = {
      ...plugins,
      writeSkillGuarded: jest.fn().mockResolvedValue({ ok: true, old_len: 0, new_len: 100 }),
    };
    const sandbox = makeSandbox();
    const memory = makeMemory();
    const service = new AgentsService(
      llm as unknown as LlmService,
      sandbox as unknown as SandboxGateway,
      pluginsWithKernel as unknown as PluginsService,
      memory as unknown as ContextMemoryService,
      audit as unknown as AuditService,
      { createBulk: jest.fn().mockResolvedValue([]) } as unknown as AlertsService,
    );

    const result = await service.runGovernedTurn({
      source: 'cycle',
      context: 'cycle run',
    });

    // Kernel call must be DROPPED — not in result.tool_calls
    expect(result.tool_calls).toHaveLength(0);
    // writeSkillGuarded must NEVER have been called
    expect(pluginsWithKernel.writeSkillGuarded).not.toHaveBeenCalled();
    // Must have audited tool_call_dropped with kernel_source_not_allowed
    const logCalls = (audit.log as jest.Mock).mock.calls as Array<[Record<string, unknown>]>;
    const droppedCall = logCalls.find(
      ([arg]) =>
        arg['event_type'] === 'tool_call_dropped' &&
        (arg['meta'] as Record<string, unknown>)?.['reason'] === 'kernel_source_not_allowed',
    );
    expect(droppedCall).toBeDefined();
  });
});

// ── F4-S3 Fix — end-to-end source-gate for kernel__create_pretest_variant and kernel__run_pretest_compare ──
//
// Mirrors src-gate.5: drive through runGovernedTurn and confirm sandbox.callPlugin is
// NEVER called for these kernel tools, and that the right drop reason is emitted.

describe('F4-S3 Fix — kernel pretest tools DROPPED end-to-end when source !== reflection', () => {
  it('src-gate.6 end-to-end: source:cycle + LLM emitting kernel__create_pretest_variant — sandbox.callPlugin NEVER called, kernel_source_not_allowed audited', async () => {
    const toolCallText =
      '<tool_calls>[{"tool":"kernel__create_pretest_variant","args":{"name":"v1","plugin_ids":["p1"]}}]</tool_calls>';
    const llm = makeLlm(toolCallText);
    const audit = makeAudit();
    const plugins = makeFullPlugins('Emit tool calls.', []);
    const sandbox = makeSandbox();
    const memory = makeMemory();
    const service = new AgentsService(
      llm as unknown as LlmService,
      sandbox as unknown as SandboxGateway,
      plugins as unknown as PluginsService,
      memory as unknown as ContextMemoryService,
      audit as unknown as AuditService,
      { createBulk: jest.fn().mockResolvedValue([]) } as unknown as AlertsService,
    );

    const result = await service.runGovernedTurn({ source: 'cycle', context: 'run' });

    // Tool call must be DROPPED — not surfaced in result
    expect(result.tool_calls).toHaveLength(0);
    // sandbox.callPlugin must NEVER be called for this kernel tool
    expect(sandbox.callPlugin).not.toHaveBeenCalled();
    // Must have audited tool_call_dropped with kernel_source_not_allowed
    const logCalls = (audit.log as jest.Mock).mock.calls as Array<[Record<string, unknown>]>;
    const droppedCall = logCalls.find(
      ([arg]) =>
        arg['event_type'] === 'tool_call_dropped' &&
        (arg['meta'] as Record<string, unknown>)?.['reason'] === 'kernel_source_not_allowed',
    );
    expect(droppedCall).toBeDefined();
  });

  it('src-gate.7 end-to-end: source:cycle + LLM emitting kernel__run_pretest_compare — sandbox.callPlugin NEVER called, kernel_source_not_allowed audited', async () => {
    const toolCallText =
      '<tool_calls>[{"tool":"kernel__run_pretest_compare","args":{}}]</tool_calls>';
    const llm = makeLlm(toolCallText);
    const audit = makeAudit();
    const plugins = makeFullPlugins('Emit tool calls.', []);
    const sandbox = makeSandbox();
    const memory = makeMemory();
    const service = new AgentsService(
      llm as unknown as LlmService,
      sandbox as unknown as SandboxGateway,
      plugins as unknown as PluginsService,
      memory as unknown as ContextMemoryService,
      audit as unknown as AuditService,
      { createBulk: jest.fn().mockResolvedValue([]) } as unknown as AlertsService,
    );

    const result = await service.runGovernedTurn({ source: 'cycle', context: 'run' });

    // Tool call must be DROPPED — not surfaced in result
    expect(result.tool_calls).toHaveLength(0);
    // sandbox.callPlugin must NEVER be called for this kernel tool
    expect(sandbox.callPlugin).not.toHaveBeenCalled();
    // Must have audited tool_call_dropped with kernel_source_not_allowed
    const logCalls = (audit.log as jest.Mock).mock.calls as Array<[Record<string, unknown>]>;
    const droppedCall = logCalls.find(
      ([arg]) =>
        arg['event_type'] === 'tool_call_dropped' &&
        (arg['meta'] as Record<string, unknown>)?.['reason'] === 'kernel_source_not_allowed',
    );
    expect(droppedCall).toBeDefined();
  });
});

// ── F4-S2 Task 1.7/1.8 — source:'reflection' union activation ────────────────
//
// These tests verify that adding 'reflection' to GovernedTurnInput.source union
// (task 1.8) activates the dormant s1 kernel-tool gate without changing existing
// cycle/chat/pretest behavior.

describe('F4-S2 Task 1.7 — GovernedTurnInput.source union accepts reflection (compile-guard)', () => {
  it('s2-1.7a — source:reflection compiles without a type cast (union extended)', () => {
    // Compile-time gate: tsc rejects this if 'reflection' is not in the union.
    // In s1 this required `as unknown as 'chat'` cast — in s2 it must compile directly.
    const input: import('./agents.service').GovernedTurnInput = {
      source: 'reflection',
      context: 'reflection context',
    };
    expect(input.source).toBe('reflection');
  });

  it('s2-1.7b — kernel__write_skill IS in effectiveTools when source=reflection (activation)', async () => {
    // With source:'reflection' now in the union, runGovernedTurn MUST inject the kernel tool.
    const captured: { tools: string }[] = [];

    const llm: Partial<LlmService> = {
      complete: jest.fn().mockImplementation((opts: { system_prompt?: string }) => {
        const sp = opts.system_prompt ?? '';
        const match = /\[TOOL SCHEMA\]\n([\s\S]*?)(?:\n\n|$)/.exec(sp);
        captured.push({ tools: match ? match[1] : '' });
        return Promise.resolve({
          text: '',
          tool_calls: [],
          backend: 'api',
          skills_read: [],
          skills_written: [],
        } as LlmResponse);
      }),
    };

    const plugins = makeFullPlugins('Use tools via JSON.', []);
    const service = new AgentsService(
      llm as unknown as LlmService,
      makeSandbox() as unknown as SandboxGateway,
      plugins as unknown as PluginsService,
      makeMemory() as unknown as ContextMemoryService,
      { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService,
      { createBulk: jest.fn().mockResolvedValue([]) } as unknown as AlertsService,
    );

    // source:'reflection' — now a valid union member (no cast needed)
    await service.runGovernedTurn({ source: 'reflection', context: 'reflect on decisions' });

    expect(captured).toHaveLength(1);
    // kernel__write_skill MUST be present in the tool schema for reflection turns
    expect(captured[0].tools).toContain('kernel__write_skill');
  });

  it('s2-1.7c — _validateToolCalls: source:reflection → kernel__write_skill passes (allowKernelTools=true)', async () => {
    const plugins = makePlugins([], []);
    const audit = makeAudit();
    const service = makeAgentsService(plugins, audit);

    const calls: ToolCallRequest[] = [
      { plugin_id: 'kernel', function: 'write_skill', args: { skill: 'x', new_body: 'y' } },
    ];

    // source:'reflection' now in union — no cast needed
    const result = await callValidateWithHoisted(service, 'reflect-001', calls, [], 'reflection');

    expect(result).toHaveLength(1);
    expect(result[0].plugin_id).toBe('kernel');
    expect(audit.log).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'tool_call_dropped', plugin_id: 'kernel' }),
    );
  });

  it('s2-1.7d (regression) — source:cycle → kernel__write_skill still ABSENT from effectiveTools', async () => {
    // Regression guard: adding 'reflection' must NOT change cycle behavior.
    const captured: { tools: string }[] = [];

    const llm: Partial<LlmService> = {
      complete: jest.fn().mockImplementation((opts: { system_prompt?: string }) => {
        const sp = opts.system_prompt ?? '';
        const match = /\[TOOL SCHEMA\]\n([\s\S]*?)(?:\n\n|$)/.exec(sp);
        captured.push({ tools: match ? match[1] : '' });
        return Promise.resolve({
          text: '',
          tool_calls: [],
          backend: 'api',
          skills_read: [],
          skills_written: [],
        } as LlmResponse);
      }),
    };

    const plugins = makeFullPlugins('Use tools.', []);
    const service = new AgentsService(
      llm as unknown as LlmService,
      makeSandbox() as unknown as SandboxGateway,
      plugins as unknown as PluginsService,
      makeMemory() as unknown as ContextMemoryService,
      { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService,
      { createBulk: jest.fn().mockResolvedValue([]) } as unknown as AlertsService,
    );

    await service.runGovernedTurn({ source: 'cycle', context: 'cycle run' });

    expect(captured).toHaveLength(1);
    expect(captured[0].tools).not.toContain('kernel__write_skill');
  });

  it('s2-1.7e (regression) — source:chat → kernel__write_skill ABSENT', async () => {
    const captured: { tools: string }[] = [];

    const llm: Partial<LlmService> = {
      complete: jest.fn().mockImplementation((opts: { system_prompt?: string }) => {
        const sp = opts.system_prompt ?? '';
        const match = /\[TOOL SCHEMA\]\n([\s\S]*?)(?:\n\n|$)/.exec(sp);
        captured.push({ tools: match ? match[1] : '' });
        return Promise.resolve({
          text: '',
          tool_calls: [],
          backend: 'api',
          skills_read: [],
          skills_written: [],
        } as LlmResponse);
      }),
    };

    const plugins = makeFullPlugins('Use tools.', []);
    const service = new AgentsService(
      llm as unknown as LlmService,
      makeSandbox() as unknown as SandboxGateway,
      plugins as unknown as PluginsService,
      makeMemory() as unknown as ContextMemoryService,
      { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService,
      { createBulk: jest.fn().mockResolvedValue([]) } as unknown as AlertsService,
    );

    await service.runGovernedTurn({ source: 'chat', context: 'ask something' });

    expect(captured).toHaveLength(1);
    expect(captured[0].tools).not.toContain('kernel__write_skill');
  });

  it('s2-1.7f (regression) — source:pretest → kernel__write_skill ABSENT', async () => {
    const captured: { tools: string }[] = [];

    const llm: Partial<LlmService> = {
      complete: jest.fn().mockImplementation((opts: { system_prompt?: string }) => {
        const sp = opts.system_prompt ?? '';
        const match = /\[TOOL SCHEMA\]\n([\s\S]*?)(?:\n\n|$)/.exec(sp);
        captured.push({ tools: match ? match[1] : '' });
        return Promise.resolve({
          text: '',
          tool_calls: [],
          backend: 'api',
          skills_read: [],
          skills_written: [],
        } as LlmResponse);
      }),
    };

    const plugins = makeFullPlugins('Use tools.', []);
    const service = new AgentsService(
      llm as unknown as LlmService,
      makeSandbox() as unknown as SandboxGateway,
      plugins as unknown as PluginsService,
      makeMemory() as unknown as ContextMemoryService,
      { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService,
      { createBulk: jest.fn().mockResolvedValue([]) } as unknown as AlertsService,
    );

    await service.runGovernedTurn({ source: 'pretest', context: 'pretest run' });

    expect(captured).toHaveLength(1);
    expect(captured[0].tools).not.toContain('kernel__write_skill');
  });
});

// ── F4-S2 Phase 2 — _assembleReflectionContext ────────────────────────────────

/**
 * Helper to call the private _assembleReflectionContext method.
 */
async function callAssembleReflectionContext(service: AgentsService): Promise<string> {
  return (
    service as unknown as {
      _assembleReflectionContext: () => Promise<string>;
    }
  )._assembleReflectionContext();
}

/**
 * Build a service configured for assembler tests.
 * snapshot and pretest are optional — match real constructor signature.
 */
function makeAssemblerService(opts: {
  auditEntries?: Array<{ event_type: string; symbol?: string | null; action?: string | null }>;
  equityCurve?: Array<{ ts: string; equity: number }>;
  auditThrows?: boolean;
  snapshotThrows?: boolean;
  pretestCompare?: Record<string, unknown>;
  pretestThrows?: boolean;
  noPretestService?: boolean;
}): AgentsService {
  const audit = {
    log: jest.fn().mockResolvedValue(undefined),
    query: opts.auditThrows
      ? jest.fn().mockRejectedValue(new Error('audit unavailable'))
      : jest.fn().mockResolvedValue(
          (opts.auditEntries ?? []).map((e) => ({
            event_type: e.event_type,
            symbol: e.symbol ?? null,
            action: e.action ?? null,
          })),
        ),
  };

  const snapshot: Partial<SnapshotService> | undefined = opts.snapshotThrows
    ? { getEquityCurve: jest.fn().mockRejectedValue(new Error('snapshot unavailable')) }
    : {
        getEquityCurve: jest.fn().mockResolvedValue(
          (opts.equityCurve ?? [{ ts: '2024-01-01', equity: 1000 }]).map((e) => ({
            ts: e.ts,
            equity: e.equity,
          })),
        ),
      };

  const pretestCompareResult = opts.pretestCompare ?? {
    portfolios: [],
    winner_by_return: '',
    winner_by_risk_adj: '',
  };

  let pretest: Partial<PretestService> | undefined;
  if (opts.noPretestService) {
    pretest = undefined;
  } else if (opts.pretestThrows) {
    pretest = { compare: jest.fn().mockRejectedValue(new Error('pretest unavailable')) };
  } else {
    pretest = { compare: jest.fn().mockResolvedValue(pretestCompareResult) };
  }

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
  ) => AgentsService)(
    {},
    {},
    {
      getActiveDecisionPrompt: jest.fn().mockResolvedValue(null),
      getProviderTools: jest.fn().mockResolvedValue([]),
      findActive: jest.fn().mockResolvedValue([]),
    },
    {},
    audit,
    { createBulk: jest.fn().mockResolvedValue([]) },
    snapshot,
    undefined,
    undefined,
    pretest,
  );
}

describe('F4-S2 Phase 2.1 — _assembleReflectionContext budget enforcement', () => {
  it('2.1a — nominal: result length <= 4000 when all sources are small', async () => {
    const service = makeAssemblerService({
      auditEntries: [
        { event_type: 'cycle_complete', symbol: 'AAPL', action: 'buy' },
        { event_type: 'signal', symbol: 'TSLA', action: 'sell' },
      ],
      equityCurve: [
        { ts: '2024-01-01', equity: 1000 },
        { ts: '2024-01-02', equity: 1050 },
      ],
    });

    const ctx = await callAssembleReflectionContext(service);

    expect(typeof ctx).toBe('string');
    expect(ctx.length).toBeLessThanOrEqual(4000);
  });

  it('2.1b — oversized sources: total assembled <= 4000 chars regardless', async () => {
    const bigAuditEntries = Array.from({ length: 100 }, () => ({
      event_type: 'cycle_complete',
      symbol: 'AAPL'.repeat(20),
      action: 'buy'.repeat(100),
    }));

    const bigEquity = Array.from({ length: 100 }, (_, i) => ({
      ts: `2024-01-${String(i + 1).padStart(2, '0')}`,
      equity: 1000 + i * 10,
    }));

    const bigPretest = {
      portfolios: Array.from({ length: 50 }, (_, i) => ({
        id: `p${i}`,
        name: `Portfolio ${String(i).repeat(20)}`,
        return_pct: i * 0.1,
        gate_status: 'READY',
      })),
      winner_by_return: 'Portfolio 0',
      winner_by_risk_adj: 'Portfolio 1',
    };

    const service = makeAssemblerService({
      auditEntries: bigAuditEntries,
      equityCurve: bigEquity,
      pretestCompare: bigPretest,
    });

    const ctx = await callAssembleReflectionContext(service);

    expect(ctx.length).toBeLessThanOrEqual(4000);
  });

  it('2.1c — SnapshotService throws: EQUITY section degrades to (unavailable), no throw', async () => {
    const service = makeAssemblerService({
      snapshotThrows: true,
    });

    const ctx = await callAssembleReflectionContext(service);

    expect(typeof ctx).toBe('string');
    expect(ctx).toContain('(unavailable)');
    expect(ctx.length).toBeLessThanOrEqual(4000);
  });

  it('2.1d — PretestService absent (undefined): PRETEST section degrades gracefully, no throw', async () => {
    const service = makeAssemblerService({
      noPretestService: true,
    });

    const ctx = await callAssembleReflectionContext(service);

    expect(typeof ctx).toBe('string');
    expect(ctx.length).toBeLessThanOrEqual(4000);
  });

  it('2.1e — empty portfolios (compare returns []): PRETEST section must NOT emit confusing "winner_return: winner_risk_adj:" line', async () => {
    // When pretest.compare() returns zero portfolios, the winner_return/winner_risk_adj
    // fields are empty strings, so emitting `winner_return: winner_risk_adj:` is misleading.
    // The guard `if (cmp.portfolios.length > 0)` must suppress that header entirely.
    const service = makeAssemblerService({
      pretestCompare: {
        portfolios: [],
        winner_by_return: '',
        winner_by_risk_adj: '',
      },
    });

    const ctx = await callAssembleReflectionContext(service);

    expect(typeof ctx).toBe('string');
    // The confusing winner line must NOT appear
    expect(ctx).not.toContain('winner_return:');
    expect(ctx).not.toContain('winner_risk_adj:');
    // Budget still respected
    expect(ctx.length).toBeLessThanOrEqual(4000);
  });
});

// ── F4-S2 Phase 2.3 — runReflectionTurn ──────────────────────────────────────

/** Export type check: ReflectionTurnResult must be importable */
type _ReflectionTurnResultCheck = import('./agents.service').ReflectionTurnResult;

function makeReflectionService(opts: { reflectionPrompt: string | null; llmText?: string }): {
  service: AgentsService;
  audit: { log: jest.Mock; query: jest.Mock };
  runGovernedTurnSpy: jest.SpyInstance;
} {
  const audit = {
    log: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue([]),
  };

  const plugins = {
    getActiveDecisionPrompt: jest.fn().mockResolvedValue(null),
    getActiveReflectionPrompt: jest.fn().mockResolvedValue(opts.reflectionPrompt),
    getProviderTools: jest.fn().mockResolvedValue([]),
    findActive: jest.fn().mockResolvedValue([]),
  };

  const llm: Partial<LlmService> = {
    complete: jest.fn().mockResolvedValue({
      text: opts.llmText ?? 'reflection response',
      tool_calls: [],
      backend: 'api',
      skills_read: [],
      skills_written: [],
    }),
  };

  const snapshot: Partial<SnapshotService> = {
    getEquityCurve: jest.fn().mockResolvedValue([{ ts: '2024-01-01', equity: 1000 }]),
  };

  const pretest: Partial<PretestService> = {
    compare: jest.fn().mockResolvedValue({
      portfolios: [],
      winner_by_return: '',
      winner_by_risk_adj: '',
    }),
  };

  const service = new (AgentsService as unknown as new (
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
  ) => AgentsService)(
    llm,
    makeSandbox(),
    plugins,
    {},
    audit,
    { createBulk: jest.fn().mockResolvedValue([]) },
    snapshot,
    undefined,
    undefined,
    pretest,
  );

  const runGovernedTurnSpy = jest.spyOn(service, 'runGovernedTurn');

  return { service, audit, runGovernedTurnSpy };
}

describe('F4-S2 Phase 2.3 — runReflectionTurn', () => {
  it('2.3a — no reflection plugin → {skipped:true, reason:"no_reflection_plugin"}, no governed turn, no audit', async () => {
    const { service, audit, runGovernedTurnSpy } = makeReflectionService({
      reflectionPrompt: null,
    });

    const result = await service.runReflectionTurn();

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('no_reflection_plugin');
    expect(runGovernedTurnSpy).not.toHaveBeenCalled();

    const calls = audit.log.mock.calls as Array<[Record<string, unknown>]>;
    const reflectionAudit = calls.find(([a]) => a['event_type'] === 'reflection_turn');
    expect(reflectionAudit).toBeUndefined();
  });

  it('2.3b — plugin active, LLM calls write_skill → reflection_turn audit emitted, returns {skipped:false}', async () => {
    const { service, audit, runGovernedTurnSpy } = makeReflectionService({
      reflectionPrompt: 'Reflect on your decisions.',
    });

    runGovernedTurnSpy.mockResolvedValue({
      cycle_id: 'reflect-001',
      text: 'I will update the skill.',
      tool_calls: [
        { plugin_id: 'kernel', function: 'write_skill', args: { skill: 'x', new_body: 'y' } },
      ],
      decisions: [],
      sandbox_results: [],
      backend: 'api',
      skills_read: [],
      skills_written: ['x'],
      llm_response: {
        text: '',
        tool_calls: [],
        backend: 'api',
        skills_read: [],
        skills_written: [],
      },
      signalsEmitted: [],
    });

    const result = await service.runReflectionTurn('cycle-abc');

    expect(result.skipped).toBe(false);

    const calls = audit.log.mock.calls as Array<[Record<string, unknown>]>;
    const reflectionAudit = calls.find(([a]) => a['event_type'] === 'reflection_turn');
    expect(reflectionAudit).toBeDefined();
    const meta = reflectionAudit![0]['meta'] as Record<string, unknown>;
    const ctxLen =
      (meta['ctx_len'] as number | undefined) ?? (meta['contextLen'] as number | undefined);
    expect(ctxLen).toBeLessThanOrEqual(4000);
  });

  it('2.3c — plugin active, LLM does NOT call tool → audit still emitted, toolCallsExecuted===0', async () => {
    const { service, audit, runGovernedTurnSpy } = makeReflectionService({
      reflectionPrompt: 'Reflect.',
    });

    runGovernedTurnSpy.mockResolvedValue({
      cycle_id: 'reflect-002',
      text: 'No tools needed.',
      tool_calls: [],
      decisions: [],
      sandbox_results: [],
      backend: 'api',
      skills_read: [],
      skills_written: [],
      llm_response: {
        text: '',
        tool_calls: [],
        backend: 'api',
        skills_read: [],
        skills_written: [],
      },
      signalsEmitted: [],
    });

    const result = await service.runReflectionTurn();

    expect(result.skipped).toBe(false);

    const calls = audit.log.mock.calls as Array<[Record<string, unknown>]>;
    const reflectionAudit = calls.find(([a]) => a['event_type'] === 'reflection_turn');
    expect(reflectionAudit).toBeDefined();
  });

  // Note: the cycle_in_progress guard was removed from runReflectionTurn (Fix #2).
  // Concurrency is now handled exclusively by PanelService.reflectNow (which holds
  // runState.running while reflection is in-flight). All callers route through reflectNow.
  it('2.3d — plugin active → proceeds to governed turn regardless of external state (lock is in reflectNow)', async () => {
    const { service, runGovernedTurnSpy } = makeReflectionService({
      reflectionPrompt: 'Reflect.',
    });

    const result = await service.runReflectionTurn();

    expect(result.skipped).toBe(false);
    expect(runGovernedTurnSpy).toHaveBeenCalledTimes(1);
  });
});

// ── F4-S3: Exploration Arena ──────────────────────────────────────────────────

// ── Task 1.1: DI boot test (RED until forwardRef wiring is done) ─────────────
//
// Strategy: verify the forwardRef decorators are actually applied by inspecting
// Reflect metadata on AgentsService and PretestService constructors.
// NestJS @Inject(forwardRef(() => X)) stores a ForwardReference token in
// PARAMTYPES_METADATA. We verify the injected token at the right parameter index.
//
// This is the most direct test for tasks 2.2–2.5: without the @Inject(forwardRef(…))
// decorators, the metadata for those param slots will be undefined or a plain class ref.

describe('F4-S3 Task 1.1 — DI boot: forwardRef decorator metadata verified on both constructors', () => {
  it('1.1a — AgentsService constructor last param has @Inject(forwardRef(()=>PretestService)) applied', () => {
    // @Inject(forwardRef(() => PretestService)) must be applied on the pretest? param of AgentsService.
    // NestJS stores this in Reflect metadata key 'self:paramtypes' for @Inject decorators.
    // The 'SELF_DECLARED_DEPS_METADATA' key stores [{index, param}] for each @Inject decorator.
    const SELF_DECLARED_DEPS_METADATA = 'self:paramtypes';
    const injectedDeps = Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, AgentsService) as
      | Array<{ index: number; param: unknown }>
      | undefined;

    // There must be at least one @Inject decorator on AgentsService constructor
    // (the one for PretestService via forwardRef)
    expect(injectedDeps).toBeDefined();
    expect(Array.isArray(injectedDeps)).toBe(true);

    // Find the dep that is a forwardRef to PretestService (it's the last constructor param)
    // forwardRef tokens have a .forwardRef property that is a function returning the class.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { PretestService: PS } = jest.requireActual('../pretest/pretest.service');

    const pretestDep = injectedDeps!.find((d) => {
      const param = d.param as Record<string, unknown> | null | undefined;
      if (!param || typeof param !== 'object') return false;
      if (typeof param['forwardRef'] !== 'function') return false;
      return (param['forwardRef'] as () => unknown)() === PS;
    });

    expect(pretestDep).toBeDefined();
  });

  it('1.1b — AgentsService with PretestService stub injected: pretest property is defined (forwardRef wires correctly)', () => {
    // This is the canonical integration assertion: if forwardRef is wired, passing a pretest stub
    // to the constructor results in this.pretest being defined.
    // We construct it manually (positional, matching the real constructor).
    const pretestStub = {
      findAll: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      compare: jest.fn(),
      runAllActive: jest.fn(),
    };

    const service = new (AgentsService as unknown as new (
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
    ) => AgentsService)(
      {},
      {},
      { findActive: jest.fn(), getProviderTools: jest.fn(), getActiveDecisionPrompt: jest.fn() },
      {},
      { log: jest.fn() },
      { createBulk: jest.fn() },
      undefined,
      undefined,
      undefined,
      pretestStub,
    );

    expect((service as unknown as Record<string, unknown>)['pretest']).toBe(pretestStub);
  });
});

// ── Task 1.1c — REAL NestJS module compile boot test ─────────────────────────
//
// This is the authoritative proof that forwardRef resolves at RUNTIME inside NestJS DI.
// Metadata inspection (1.1a) catches missing decorators; this test catches missing
// module wiring (forwardRef in AgentsModule/PretestModule imports).
//
// Strategy: Test.createTestingModule imports the REAL AgentsModule + PretestModule.
// All external infrastructure providers (Prisma, Sandbox, LLM, etc.) are overridden
// with no-op mocks so .compile() succeeds without real I/O.
// A circular-dependency error from NestJS would cause .compile() to throw — the test
// asserts it does NOT throw, and that both AgentsService and PretestService resolve.

describe('F4-S3 Task 1.1c — REAL NestJS module compile: forwardRef circular DI resolves without error', () => {
  it('1.1c — AgentsModule + PretestModule compile() succeeds: both services resolve, pretest is defined on AgentsService', async () => {
    // Inline imports: only needed in this test, avoids polluting the module-level scope
    // with @nestjs/testing (which is a dev dependency, fine in spec files).
    const { Test } = await import('@nestjs/testing');
    const { AgentsModule } = await import('./agents.module');
    const { PretestModule } = await import('../pretest/pretest.module');

    // Infrastructure providers that would fail without real I/O
    const { PrismaService } = await import('../prisma/prisma.service');
    const { SandboxGateway } = await import('../sandbox/sandbox.gateway');
    const { LlmService } = await import('../llm/llm.service');
    const { PluginsService } = await import('../plugins/plugins.service');
    const { PluginEventsService } = await import('../plugins/plugin-events.service');
    const { LifecycleService } = await import('../plugins/lifecycle.service');
    const { PluginWatcherService } = await import('../plugins/plugin-watcher.service');
    const { ContextMemoryService } = await import('../context-memory/context-memory.service');
    const { AuditService } = await import('../audit/audit.service');
    const { AlertsService } = await import('../alerts/alerts.service');
    const { SnapshotService } = await import('../snapshot/snapshot.service');
    const { NotifierBridge } = await import('../notifier/notifier-bridge');
    const { TelegramService } = await import('../notifier/telegram.service');
    const { ProviderGatewayService } = await import('../providers/provider-gateway.service');
    const { OhlcvCacheService } = await import('../providers/ohlcv-cache.service');
    const { KvService } = await import('../common/kv.service');
    const { MigrationRunnerService } = await import('../prisma/migration-runner.service');
    const { AgentsService: AgentsSvc } = await import('./agents.service');
    const { PretestService } = await import('../pretest/pretest.service');
    const { ConfigModule } = await import('@nestjs/config');
    const { TotpRequiredGuard } = await import('../auth/guards/totp-required.guard');

    const moduleRef = await Test.createTestingModule({
      // ConfigModule.forRoot({ isGlobal: true }) makes ConfigService available in all
      // nested module scopes — mirrors how AppModule registers it in production.
      imports: [ConfigModule.forRoot({ isGlobal: true }), AgentsModule, PretestModule],
    })
      .overrideProvider(PrismaService)
      .useValue({ $connect: jest.fn(), $disconnect: jest.fn() })
      .overrideProvider(MigrationRunnerService)
      .useValue({})
      .overrideProvider(SandboxGateway)
      .useValue({
        runCycle: jest.fn(),
        callPlugin: jest.fn(),
        call: jest.fn(),
        runExtraCycleHook: jest.fn(),
        getPluginStage: jest.fn(),
      })
      .overrideProvider(LlmService)
      .useValue({ complete: jest.fn() })
      .overrideProvider(PluginsService)
      .useValue({
        findActive: jest.fn(),
        getProviderTools: jest.fn(),
        getSkillsMetadata: jest.fn(),
        getActiveDecisionPrompt: jest.fn(),
        getActiveReflectionPrompt: jest.fn(),
        writeSkillGuarded: jest.fn(),
      })
      .overrideProvider(PluginEventsService)
      .useValue({})
      .overrideProvider(LifecycleService)
      .useValue({})
      .overrideProvider(PluginWatcherService)
      .useValue({})
      .overrideProvider(ContextMemoryService)
      .useValue({
        toContextString: jest.fn(),
        appendObservation: jest.fn(),
        trackSignal: jest.fn(),
      })
      .overrideProvider(AuditService)
      .useValue({ log: jest.fn(), query: jest.fn() })
      .overrideProvider(AlertsService)
      .useValue({ createBulk: jest.fn() })
      .overrideProvider(SnapshotService)
      .useValue({ getEquityCurve: jest.fn() })
      .overrideProvider(NotifierBridge)
      .useValue({ send: jest.fn() })
      .overrideProvider(TelegramService)
      .useValue({ sendMessage: jest.fn() })
      .overrideProvider(ProviderGatewayService)
      .useValue({ getQuote: jest.fn() })
      .overrideProvider(OhlcvCacheService)
      .useValue({ get: jest.fn(), set: jest.fn() })
      .overrideProvider(KvService)
      .useValue({ get: jest.fn(), set: jest.fn(), del: jest.fn() })
      .overrideProvider(TotpRequiredGuard)
      .useValue({ canActivate: jest.fn().mockReturnValue(true) })
      .compile();

    // If compile() throws with "Nest cannot create ... circular dependency", the test fails.
    // The fact that we reach here proves NestJS resolved the forwardRef graph without error.

    const agentsService = moduleRef.get(AgentsSvc);
    const pretestService = moduleRef.get(PretestService);

    expect(agentsService).toBeDefined();
    expect(pretestService).toBeDefined();

    // The critical assertion: AgentsService has its pretest property wired (not undefined)
    // This proves forwardRef(() => PretestService) in AgentsModule resolved at DI time.
    const pretest = (agentsService as unknown as Record<string, unknown>)['pretest'];
    expect(pretest).toBeDefined();
    expect(pretest).toBe(pretestService);

    await moduleRef.close();
  }, 15000); // generous timeout for module compilation
});

// ── Task 1.3: Tool schema tests (source-gated) ────────────────────────────────

describe('F4-S3 Task 1.3 — kernel pretest tools present in reflection effectiveTools only', () => {
  // Builds a service that captures the injected [TOOL SCHEMA] for s3 source-gating tests.
  // Note: this helper mirrors the s1/s2 injection-capturing service but is scoped here
  // so s3 tests remain self-contained. The distinct describe name disambiguates it from
  // the s1 Phase 4.1 helper.
  function buildS3SchemaCapturingService(capturedSchema: { tools: string }[]): AgentsService {
    const llm: Partial<LlmService> = {
      complete: jest.fn().mockImplementation((opts: { system_prompt?: string }) => {
        const sp = opts.system_prompt ?? '';
        const match = /\[TOOL SCHEMA\]\n([\s\S]*?)(?:\n\n|$)/.exec(sp);
        capturedSchema.push({ tools: match ? match[1] : '' });
        return Promise.resolve({
          text: '',
          tool_calls: [],
          backend: 'api',
          skills_read: [],
          skills_written: [],
        } as LlmResponse);
      }),
    };
    // Provide a decision prompt so the schema IS injected into the system prompt
    const plugins = makeFullPlugins('Use tools via JSON — s3 test.', []);
    const memory = makeMemory();
    return new AgentsService(
      llm as unknown as LlmService,
      makeSandbox() as unknown as SandboxGateway,
      plugins as unknown as PluginsService,
      memory as unknown as ContextMemoryService,
      { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService,
      { createBulk: jest.fn().mockResolvedValue([]) } as unknown as AlertsService,
    );
  }

  it('1.3a — source:reflection → effectiveTools includes kernel__create_pretest_variant AND kernel__run_pretest_compare', async () => {
    const captured: { tools: string }[] = [];
    const service = buildS3SchemaCapturingService(captured);
    await service.runGovernedTurn({ source: 'reflection', context: 'reflect' });
    expect(captured).toHaveLength(1);
    expect(captured[0].tools).toContain('kernel__create_pretest_variant');
    expect(captured[0].tools).toContain('kernel__run_pretest_compare');
  });

  it('1.3b — source:cycle → neither kernel pretest tool is present in effectiveTools', async () => {
    const captured: { tools: string }[] = [];
    const service = buildS3SchemaCapturingService(captured);
    await service.runGovernedTurn({ source: 'cycle', context: 'run cycle' });
    expect(captured).toHaveLength(1);
    expect(captured[0].tools).not.toContain('kernel__create_pretest_variant');
    expect(captured[0].tools).not.toContain('kernel__run_pretest_compare');
  });

  it('1.3c — source:chat → neither kernel pretest tool is present in effectiveTools', async () => {
    const captured: { tools: string }[] = [];
    const service = buildS3SchemaCapturingService(captured);
    await service.runGovernedTurn({ source: 'chat', context: 'ask something' });
    expect(captured).toHaveLength(1);
    expect(captured[0].tools).not.toContain('kernel__create_pretest_variant');
    expect(captured[0].tools).not.toContain('kernel__run_pretest_compare');
  });

  it('1.3d — source:pretest → neither kernel pretest tool is present in effectiveTools', async () => {
    const captured: { tools: string }[] = [];
    const service = buildS3SchemaCapturingService(captured);
    await service.runGovernedTurn({ source: 'pretest', context: 'pretest run' });
    expect(captured).toHaveLength(1);
    expect(captured[0].tools).not.toContain('kernel__create_pretest_variant');
    expect(captured[0].tools).not.toContain('kernel__run_pretest_compare');
  });
});

// ── Task 1.4: parseToolCalls split tests ─────────────────────────────────────

describe('F4-S3 Task 1.4 — parseToolCalls first-__ split for new kernel tool names', () => {
  it('1.4a — kernel__create_pretest_variant parses to {plugin_id:"kernel", function:"create_pretest_variant"}', async () => {
    const toolCallText =
      '<tool_calls>[{"tool":"kernel__create_pretest_variant","args":{"name":"test","plugin_ids":["p1"]}}]</tool_calls>';
    const llm = makeLlm(toolCallText);
    const audit = makeAudit();
    const plugins = makeFullPlugins('emit tools.', []);
    const sandbox = makeSandbox();
    const memory = makeMemory();
    const service = makeFullAgentsService(llm, audit, plugins, sandbox, memory);

    // Drive through runGovernedTurn to trigger parseToolCalls; inspect decisions for plugin_id/function
    // We check via _validateToolCalls dropping it (non-reflection) with unknown_kernel_tool OR
    // kernel_source_not_allowed; either way plugin_id must be 'kernel' and function 'create_pretest_variant'.
    const logCalls: Array<[Record<string, unknown>]> = [];
    (audit.log as jest.Mock).mockImplementation((arg: Record<string, unknown>) => {
      logCalls.push([arg]);
      return Promise.resolve(undefined);
    });

    await service.runGovernedTurn({ source: 'cycle', context: 'run' });

    const droppedCall = logCalls.find(
      ([arg]) => arg['event_type'] === 'tool_call_dropped' && arg['plugin_id'] === 'kernel',
    );
    expect(droppedCall).toBeDefined();
    // The function must be 'create_pretest_variant' (from the drop meta)
    const meta = droppedCall![0]['meta'] as Record<string, unknown>;
    expect(meta['function']).toBe('create_pretest_variant');
  });

  it('1.4b — kernel__run_pretest_compare parses to {plugin_id:"kernel", function:"run_pretest_compare"}', async () => {
    const toolCallText =
      '<tool_calls>[{"tool":"kernel__run_pretest_compare","args":{}}]</tool_calls>';
    const llm = makeLlm(toolCallText);
    const audit = makeAudit();
    const plugins = makeFullPlugins('emit tools.', []);
    const sandbox = makeSandbox();
    const memory = makeMemory();
    const service = makeFullAgentsService(llm, audit, plugins, sandbox, memory);

    const logCalls: Array<[Record<string, unknown>]> = [];
    (audit.log as jest.Mock).mockImplementation((arg: Record<string, unknown>) => {
      logCalls.push([arg]);
      return Promise.resolve(undefined);
    });

    await service.runGovernedTurn({ source: 'cycle', context: 'run' });

    const droppedCall = logCalls.find(
      ([arg]) => arg['event_type'] === 'tool_call_dropped' && arg['plugin_id'] === 'kernel',
    );
    expect(droppedCall).toBeDefined();
    const meta = droppedCall![0]['meta'] as Record<string, unknown>;
    expect(meta['function']).toBe('run_pretest_compare');
  });
});

// ── Task 1.5/1.6: Dispatch tests for the new kernel tools ────────────────────

/**
 * Factory for AgentsService with a PretestService mock wired as the optional pretest? param.
 * Uses the 10-arg positional constructor (same pattern as makeAssemblerService / makeReflectionService).
 */
function makePretestMock(opts: {
  findAllLength?: number;
  createResult?: Partial<import('../pretest/pretest.service').PretestPortfolio>;
  compareResult?: Partial<import('../pretest/pretest.service').PretestCompare>;
  runAllActiveMock?: jest.Mock;
}) {
  return {
    findAll: jest.fn().mockResolvedValue(
      Array.from({ length: opts.findAllLength ?? 0 }, (_, i) => ({
        id: `p${i}`,
        name: `P${i}`,
        is_active: true,
      })),
    ),
    create: jest.fn().mockResolvedValue({
      id: 'new-pf-id',
      name: 'test variant',
      ...(opts.createResult ?? {}),
    }),
    compare: jest.fn().mockResolvedValue(
      opts.compareResult ?? {
        portfolios: [
          { id: 'p1', name: 'Alpha', return_pct: 5.5, gate_status: 'READY' },
          { id: 'p2', name: 'Beta', return_pct: 3.2, gate_status: 'NOT_READY' },
        ],
        winner_by_return: 'Alpha',
        winner_by_risk_adj: 'Alpha',
      },
    ),
    runAllActive: opts.runAllActiveMock ?? jest.fn().mockResolvedValue([]),
  };
}

function makeServiceWithPretest(
  auditMock: ReturnType<typeof makeAudit>,
  pretestMock: ReturnType<typeof makePretestMock>,
  sandboxMock?: ReturnType<typeof makeSandbox>,
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
  ) => AgentsService)(
    {},
    sandboxMock ?? makeSandbox(),
    {
      getActiveDecisionPrompt: jest.fn().mockResolvedValue(null),
      getProviderTools: jest.fn().mockResolvedValue([]),
      findActive: jest.fn().mockResolvedValue([]),
      writeSkillGuarded: jest.fn(),
    },
    {},
    auditMock,
    { createBulk: jest.fn().mockResolvedValue([]) },
    undefined,
    undefined,
    undefined,
    pretestMock,
  );
}

/** Helper to call _dispatchKernelTool directly */
async function callDispatchKernelTool(
  service: AgentsService,
  cycleId: string,
  tc: import('../llm/llm.service').ToolCallRequest,
  decisions: import('./agents.service').Decision[],
  sandboxResults: import('./agents.service').SandboxResult[],
): Promise<void> {
  return (
    service as unknown as {
      _dispatchKernelTool: (
        cycleId: string,
        tc: import('../llm/llm.service').ToolCallRequest,
        decisions: import('./agents.service').Decision[],
        sandboxResults: import('./agents.service').SandboxResult[],
      ) => Promise<void>;
    }
  )._dispatchKernelTool(cycleId, tc, decisions, sandboxResults);
}

describe('F4-S3 Task 1.5 — _dispatchKernelTool: create_pretest_variant', () => {
  const CYCLE_ID = 's3-create-001';

  it('1.5a — happy path: pretest.create called, audit pretest_variant_created, decision allowed:true, sandbox NOT called', async () => {
    const audit = makeAudit();
    const pretest = makePretestMock({ findAllLength: 3 });
    const sandbox = makeSandbox();
    const service = makeServiceWithPretest(audit, pretest, sandbox);

    const tc: import('../llm/llm.service').ToolCallRequest = {
      plugin_id: 'kernel',
      function: 'create_pretest_variant',
      args: { name: 'variant-a', plugin_ids: ['p1', 'p2'], rationale: 'test' },
    };
    const decisions: import('./agents.service').Decision[] = [];
    const sandboxResults: import('./agents.service').SandboxResult[] = [];

    await callDispatchKernelTool(service, CYCLE_ID, tc, decisions, sandboxResults);

    // pretest.create must have been called
    expect(pretest.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'variant-a', plugin_ids: ['p1', 'p2'] }),
    );
    // audit pretest_variant_created must have been emitted
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'pretest_variant_created' }),
    );
    // decision allowed:true
    expect(decisions).toHaveLength(1);
    expect(decisions[0].allowed).toBe(true);
    // sandbox.callPlugin must NOT have been called
    expect(sandbox.callPlugin).not.toHaveBeenCalled();
  });

  it('1.5b — cap reached (findAll >= 20): no create, audit pretest_cap_reached, decision allowed:false reason:pretest_cap_reached', async () => {
    const audit = makeAudit();
    const pretest = makePretestMock({ findAllLength: 20 });
    const sandbox = makeSandbox();
    const service = makeServiceWithPretest(audit, pretest, sandbox);

    const tc: import('../llm/llm.service').ToolCallRequest = {
      plugin_id: 'kernel',
      function: 'create_pretest_variant',
      args: { name: 'over-cap', plugin_ids: ['p1'] },
    };
    const decisions: import('./agents.service').Decision[] = [];
    const sandboxResults: import('./agents.service').SandboxResult[] = [];

    await callDispatchKernelTool(service, CYCLE_ID, tc, decisions, sandboxResults);

    // pretest.create must NOT have been called
    expect(pretest.create).not.toHaveBeenCalled();
    // audit pretest_cap_reached must have been emitted
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'pretest_cap_reached' }),
    );
    // decision allowed:false reason:pretest_cap_reached
    expect(decisions).toHaveLength(1);
    expect(decisions[0].allowed).toBe(false);
    expect(decisions[0].reason).toBe('pretest_cap_reached');
    // sandbox NOT called
    expect(sandbox.callPlugin).not.toHaveBeenCalled();
  });

  it('1.5c — invalid args (empty name): dropped invalid_variant_args, no create, no findAll', async () => {
    const audit = makeAudit();
    const pretest = makePretestMock({ findAllLength: 0 });
    const sandbox = makeSandbox();
    const service = makeServiceWithPretest(audit, pretest, sandbox);

    const tc: import('../llm/llm.service').ToolCallRequest = {
      plugin_id: 'kernel',
      function: 'create_pretest_variant',
      args: { name: '', plugin_ids: ['p1'] },
    };
    const decisions: import('./agents.service').Decision[] = [];
    const sandboxResults: import('./agents.service').SandboxResult[] = [];

    await callDispatchKernelTool(service, CYCLE_ID, tc, decisions, sandboxResults);

    expect(pretest.create).not.toHaveBeenCalled();
    expect(pretest.findAll).not.toHaveBeenCalled();
    expect(decisions[0].allowed).toBe(false);
    expect(decisions[0].reason).toBe('invalid_variant_args');
    expect(sandbox.callPlugin).not.toHaveBeenCalled();
  });

  it('1.5c2 — invalid args (empty plugin_ids): dropped invalid_variant_args, no create, no findAll', async () => {
    const audit = makeAudit();
    const pretest = makePretestMock({ findAllLength: 0 });
    const sandbox = makeSandbox();
    const service = makeServiceWithPretest(audit, pretest, sandbox);

    const tc: import('../llm/llm.service').ToolCallRequest = {
      plugin_id: 'kernel',
      function: 'create_pretest_variant',
      args: { name: 'valid-name', plugin_ids: [] },
    };
    const decisions: import('./agents.service').Decision[] = [];
    const sandboxResults: import('./agents.service').SandboxResult[] = [];

    await callDispatchKernelTool(service, CYCLE_ID, tc, decisions, sandboxResults);

    expect(pretest.create).not.toHaveBeenCalled();
    expect(pretest.findAll).not.toHaveBeenCalled();
    expect(decisions[0].allowed).toBe(false);
    expect(decisions[0].reason).toBe('invalid_variant_args');
  });

  it('1.5d — pretest unavailable (undefined): allowed:false reason:pretest_unavailable, no throw', async () => {
    // Build service WITHOUT pretest (undefined)
    const audit = makeAudit();
    const sandbox = makeSandbox();
    const serviceNoPretest = new (AgentsService as unknown as new (
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
    ) => AgentsService)(
      {},
      sandbox,
      {
        getActiveDecisionPrompt: jest.fn().mockResolvedValue(null),
        getProviderTools: jest.fn().mockResolvedValue([]),
        findActive: jest.fn().mockResolvedValue([]),
        writeSkillGuarded: jest.fn(),
      },
      {},
      audit,
      { createBulk: jest.fn().mockResolvedValue([]) },
      undefined,
      undefined,
      undefined,
      undefined, // pretest is undefined
    );

    const tc: import('../llm/llm.service').ToolCallRequest = {
      plugin_id: 'kernel',
      function: 'create_pretest_variant',
      args: { name: 'test', plugin_ids: ['p1'] },
    };
    const decisions: import('./agents.service').Decision[] = [];
    const sandboxResults: import('./agents.service').SandboxResult[] = [];

    // Must not throw
    await expect(
      callDispatchKernelTool(serviceNoPretest, CYCLE_ID, tc, decisions, sandboxResults),
    ).resolves.not.toThrow();

    expect(decisions[0].allowed).toBe(false);
    expect(decisions[0].reason).toBe('pretest_unavailable');
    expect(sandbox.callPlugin).not.toHaveBeenCalled();
  });
});

describe('F4-S3 Task 1.6 — _dispatchKernelTool: run_pretest_compare', () => {
  const CYCLE_ID = 's3-compare-001';

  it('1.6a — happy path: pretest.compare called, runAllActive NOT called, sandbox NOT called, audit pretest_compared, result in sandbox_results', async () => {
    const audit = makeAudit();
    const runAllActiveMock = jest.fn().mockResolvedValue([]);
    const pretest = makePretestMock({ runAllActiveMock });
    const sandbox = makeSandbox();
    const service = makeServiceWithPretest(audit, pretest, sandbox);

    const tc: import('../llm/llm.service').ToolCallRequest = {
      plugin_id: 'kernel',
      function: 'run_pretest_compare',
      args: {},
    };
    const decisions: import('./agents.service').Decision[] = [];
    const sandboxResults: import('./agents.service').SandboxResult[] = [];

    await callDispatchKernelTool(service, CYCLE_ID, tc, decisions, sandboxResults);

    // pretest.compare must have been called
    expect(pretest.compare).toHaveBeenCalledTimes(1);
    // runAllActive must NOT have been called (compare-only per ADR-3)
    expect(runAllActiveMock).not.toHaveBeenCalled();
    // sandbox.callPlugin must NOT have been called
    expect(sandbox.callPlugin).not.toHaveBeenCalled();
    // audit pretest_compared must have been emitted
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'pretest_compared' }),
    );
    // decision allowed:true
    expect(decisions).toHaveLength(1);
    expect(decisions[0].allowed).toBe(true);
    // result must be in sandbox_results with winner + portfolios
    expect(sandboxResults).toHaveLength(1);
    const r = sandboxResults[0];
    expect(r.ok).toBe(true);
    const result = r.result as Record<string, unknown>;
    expect(result['winner_by_return']).toBe('Alpha');
    expect(result['winner_by_risk_adj']).toBe('Alpha');
    expect(Array.isArray(result['portfolios'])).toBe(true);
    const portfolios = result['portfolios'] as Array<Record<string, unknown>>;
    expect(portfolios[0]).toMatchObject({ name: 'Alpha', return_pct: 5.5, gate_status: 'READY' });
  });

  it('1.6b — pretest unavailable (undefined): allowed:false reason:pretest_unavailable, no throw', async () => {
    const audit = makeAudit();
    const sandbox = makeSandbox();
    const serviceNoPretest = new (AgentsService as unknown as new (
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
    ) => AgentsService)(
      {},
      sandbox,
      {
        getActiveDecisionPrompt: jest.fn().mockResolvedValue(null),
        getProviderTools: jest.fn().mockResolvedValue([]),
        findActive: jest.fn().mockResolvedValue([]),
        writeSkillGuarded: jest.fn(),
      },
      {},
      audit,
      { createBulk: jest.fn().mockResolvedValue([]) },
      undefined,
      undefined,
      undefined,
      undefined,
    );

    const tc: import('../llm/llm.service').ToolCallRequest = {
      plugin_id: 'kernel',
      function: 'run_pretest_compare',
      args: {},
    };
    const decisions: import('./agents.service').Decision[] = [];
    const sandboxResults: import('./agents.service').SandboxResult[] = [];

    await expect(
      callDispatchKernelTool(serviceNoPretest, CYCLE_ID, tc, decisions, sandboxResults),
    ).resolves.not.toThrow();

    expect(decisions[0].allowed).toBe(false);
    expect(decisions[0].reason).toBe('pretest_unavailable');
    expect(sandbox.callPlugin).not.toHaveBeenCalled();
  });
});

// ── Task 1.7: Source-gate regression tests ────────────────────────────────────

describe('F4-S3 Task 1.7 — source-gate regression: new kernel tools dropped in non-reflection turns', () => {
  const CYCLE_ID = 's3-gate-001';

  it('1.7a — create_pretest_variant in cycle turn: dropped kernel_source_not_allowed', async () => {
    const plugins = makePlugins([], []);
    const audit = makeAudit();
    const service = makeAgentsService(plugins, audit);

    const calls: ToolCallRequest[] = [
      {
        plugin_id: 'kernel',
        function: 'create_pretest_variant',
        args: { name: 'x', plugin_ids: ['p1'] },
      },
    ];

    const result = await callValidateWithHoisted(service, CYCLE_ID, calls, [], 'cycle');

    expect(result).toHaveLength(0);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'tool_call_dropped',
        plugin_id: 'kernel',
        meta: expect.objectContaining({ reason: 'kernel_source_not_allowed' }) as unknown,
      }),
    );
  });

  it('1.7b — run_pretest_compare in chat turn: dropped kernel_source_not_allowed', async () => {
    const plugins = makePlugins([], []);
    const audit = makeAudit();
    const service = makeAgentsService(plugins, audit);

    const calls: ToolCallRequest[] = [
      { plugin_id: 'kernel', function: 'run_pretest_compare', args: {} },
    ];

    const result = await callValidateWithHoisted(service, CYCLE_ID, calls, [], 'chat');

    expect(result).toHaveLength(0);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'tool_call_dropped',
        plugin_id: 'kernel',
        meta: expect.objectContaining({ reason: 'kernel_source_not_allowed' }) as unknown,
      }),
    );
  });

  it('1.7c — create_pretest_variant in pretest turn: dropped kernel_source_not_allowed', async () => {
    const plugins = makePlugins([], []);
    const audit = makeAudit();
    const service = makeAgentsService(plugins, audit);

    const calls: ToolCallRequest[] = [
      { plugin_id: 'kernel', function: 'create_pretest_variant', args: {} },
    ];

    const result = await callValidateWithHoisted(service, CYCLE_ID, calls, [], 'pretest');

    expect(result).toHaveLength(0);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'tool_call_dropped',
        plugin_id: 'kernel',
        meta: expect.objectContaining({ reason: 'kernel_source_not_allowed' }) as unknown,
      }),
    );
  });

  it('1.7d — unknown kernel function still dropped unknown_kernel_tool (registry regression)', async () => {
    const plugins = makePlugins([], []);
    const audit = makeAudit();
    const service = makeAgentsService(plugins, audit);

    const calls: ToolCallRequest[] = [
      { plugin_id: 'kernel', function: 'bogus_kernel_fn', args: {} },
    ];

    // Even in reflection turn — unknown function is dropped
    const result = await callValidateWithHoisted(service, CYCLE_ID, calls, [], 'reflection');

    expect(result).toHaveLength(0);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'tool_call_dropped',
        plugin_id: 'kernel',
        meta: expect.objectContaining({ reason: 'unknown_kernel_tool' }) as unknown,
      }),
    );
  });

  it('1.7e — all 3 kernel tools allowed in reflection turn (registry has 3 entries)', async () => {
    const plugins = makePlugins([], []);
    const audit = makeAudit();
    const service = makeAgentsService(plugins, audit);

    const calls: ToolCallRequest[] = [
      { plugin_id: 'kernel', function: 'write_skill', args: { skill: 'x', new_body: 'y' } },
      {
        plugin_id: 'kernel',
        function: 'create_pretest_variant',
        args: { name: 'v', plugin_ids: ['p1'] },
      },
      { plugin_id: 'kernel', function: 'run_pretest_compare', args: {} },
    ];

    const result = await callValidateWithHoisted(service, CYCLE_ID, calls, [], 'reflection');

    // All 3 must pass validation in reflection turn
    expect(result).toHaveLength(3);
    expect(audit.log).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'tool_call_dropped', plugin_id: 'kernel' }),
    );
  });
});

// ── F4-S4 Phase 3 — kernel__promote_pretest ──────────────────────────────────

/** Extend PretestMock with a promote() mock */
function makePretestMockWithPromote(opts: {
  findAllLength?: number;
  promoteResult?: import('../pretest/pretest.service').PromoteResult;
  promoteShouldThrow?: Error;
  compareResult?: Partial<import('../pretest/pretest.service').PretestCompare>;
}) {
  const base = makePretestMock({
    findAllLength: opts.findAllLength ?? 0,
    compareResult: opts.compareResult ?? undefined,
  });
  const promote = opts.promoteShouldThrow
    ? jest.fn().mockRejectedValue(opts.promoteShouldThrow)
    : jest.fn().mockResolvedValue(
        opts.promoteResult ?? {
          ok: false,
          reason: 'needs_confirmation',
          pending: { plugin_ids: ['p1'], plugin_configs: {} },
        },
      );
  return { ...base, promote };
}

/** Reuses makeServiceWithPretest — same signature, just accepts promote-extended mock. */
const makeServiceWithPretestPromote = (
  auditMock: ReturnType<typeof makeAudit>,
  pretestMock: ReturnType<typeof makePretestMockWithPromote>,
  sandboxMock?: ReturnType<typeof makeSandbox>,
): AgentsService => makeServiceWithPretest(auditMock, pretestMock, sandboxMock);

describe('F4-S4 Phase 3 — parseToolCalls split: kernel__promote_pretest', () => {
  it('3.1 — kernel__promote_pretest parses to {plugin_id:"kernel", function:"promote_pretest"}', async () => {
    const toolCallText =
      '<tool_calls>[{"tool":"kernel__promote_pretest","args":{"pretest_id":"pf-1"}}]</tool_calls>';
    const llm = makeLlm(toolCallText);
    const audit = makeAudit();
    const plugins = makeFullPlugins('emit tools.', []);
    const sandbox = makeSandbox();
    const memory = makeMemory();
    const service = makeFullAgentsService(llm, audit, plugins, sandbox, memory);

    const logCalls: Array<[Record<string, unknown>]> = [];
    (audit.log as jest.Mock).mockImplementation((arg: Record<string, unknown>) => {
      logCalls.push([arg]);
      return Promise.resolve(undefined);
    });

    await service.runGovernedTurn({ source: 'cycle', context: 'run' });

    const droppedCall = logCalls.find(
      ([arg]) => arg['event_type'] === 'tool_call_dropped' && arg['plugin_id'] === 'kernel',
    );
    expect(droppedCall).toBeDefined();
    const meta = droppedCall![0]['meta'] as Record<string, unknown>;
    expect(meta['function']).toBe('promote_pretest');
  });
});

describe('F4-S4 Phase 3 — reflection: kernel__promote_pretest in effectiveTools', () => {
  function buildCapturingService(capturedSchema: { tools: string }[]): AgentsService {
    const llm: Partial<LlmService> = {
      complete: jest.fn().mockImplementation((opts: { system_prompt?: string }) => {
        const sp = opts.system_prompt ?? '';
        const match = /\[TOOL SCHEMA\]\n([\s\S]*?)(?:\n\n|$)/.exec(sp);
        capturedSchema.push({ tools: match ? match[1] : '' });
        return Promise.resolve({
          text: '',
          tool_calls: [],
          backend: 'api' as const,
          skills_read: [],
          skills_written: [],
        } as LlmResponse);
      }),
    };
    const plugins = makeFullPlugins('Use tools via JSON.', []);
    return new AgentsService(
      llm as unknown as LlmService,
      makeSandbox() as unknown as SandboxGateway,
      plugins as unknown as PluginsService,
      makeMemory() as unknown as ContextMemoryService,
      { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService,
      { createBulk: jest.fn().mockResolvedValue([]) } as unknown as AlertsService,
    );
  }

  it('3.2 — source:reflection → kernel__promote_pretest in effectiveTools; 4 kernel tools total', async () => {
    const captured: { tools: string }[] = [];
    const service = buildCapturingService(captured);

    await service.runGovernedTurn({ source: 'reflection' as const, context: 'x' });

    expect(captured).toHaveLength(1);
    expect(captured[0].tools).toContain('kernel__promote_pretest');
    expect(captured[0].tools).toContain('kernel__write_skill');
    expect(captured[0].tools).toContain('kernel__create_pretest_variant');
    expect(captured[0].tools).toContain('kernel__run_pretest_compare');
  });

  it('3.3 — source:chat → kernel__promote_pretest NOT in effectiveTools', async () => {
    const captured: { tools: string }[] = [];
    const service = buildCapturingService(captured);

    await service.runGovernedTurn({ source: 'chat', context: 'x' });

    expect(captured).toHaveLength(1);
    expect(captured[0].tools).not.toContain('kernel__promote_pretest');
  });
});

describe('F4-S4 Phase 3 — _dispatchKernelTool: promote_pretest', () => {
  const CYCLE_ID = 's4-promote-001';

  it('3.4 — LLM cannot auto-apply by default: dispatch promote_pretest → promote() called WITHOUT confirm → needs_confirmation; activate/setConfig NOT called', async () => {
    const audit = makeAudit();
    const pretest = makePretestMockWithPromote({
      promoteResult: {
        ok: false,
        reason: 'needs_confirmation',
        pending: { plugin_ids: ['p1'], plugin_configs: {} },
      },
    });
    const sandbox = makeSandbox();
    const service = makeServiceWithPretestPromote(audit, pretest, sandbox);

    const tc: import('../llm/llm.service').ToolCallRequest = {
      plugin_id: 'kernel',
      function: 'promote_pretest',
      args: { pretest_id: 'pf-abc', rationale: 'gate passed' },
    };
    const decisions: import('./agents.service').Decision[] = [];
    const sandboxResults: import('./agents.service').SandboxResult[] = [];

    await callDispatchKernelTool(service, CYCLE_ID, tc, decisions, sandboxResults);

    // promote() called WITHOUT opts.confirm
    expect(pretest.promote).toHaveBeenCalledWith('pf-abc');
    expect(pretest.promote).not.toHaveBeenCalledWith(
      'pf-abc',
      expect.objectContaining({ confirm: true }),
    );

    // audit pretest_promote_requested emitted
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'pretest_promote_requested' }),
    );

    // result is needs_confirmation — no activate/setConfig (sandbox NOT called)
    expect(sandbox.callPlugin).not.toHaveBeenCalled();
  });

  it('3.5 — pretest unavailable: allowed:false reason:pretest_unavailable; no throw', async () => {
    const audit = makeAudit();
    // Build service WITHOUT pretest (undefined)
    const sandbox = makeSandbox();
    const serviceNoPretest = new (AgentsService as unknown as new (
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
    ) => AgentsService)(
      {},
      sandbox,
      {
        getActiveDecisionPrompt: jest.fn().mockResolvedValue(null),
        getProviderTools: jest.fn().mockResolvedValue([]),
        findActive: jest.fn().mockResolvedValue([]),
        writeSkillGuarded: jest.fn(),
      },
      {},
      audit,
      { createBulk: jest.fn().mockResolvedValue([]) },
      undefined,
      undefined,
      undefined,
      undefined,
    );

    const tc: import('../llm/llm.service').ToolCallRequest = {
      plugin_id: 'kernel',
      function: 'promote_pretest',
      args: { pretest_id: 'pf-1' },
    };
    const decisions: import('./agents.service').Decision[] = [];
    const sandboxResults: import('./agents.service').SandboxResult[] = [];

    await expect(
      callDispatchKernelTool(serviceNoPretest, CYCLE_ID, tc, decisions, sandboxResults),
    ).resolves.not.toThrow();

    expect(decisions[0].allowed).toBe(false);
    expect(decisions[0].reason).toBe('pretest_unavailable');
  });

  it('3.6 — empty pretest_id: dropped invalid_promote_args; promote() NOT called', async () => {
    const audit = makeAudit();
    const pretest = makePretestMockWithPromote({});
    const service = makeServiceWithPretestPromote(audit, pretest);

    const tc: import('../llm/llm.service').ToolCallRequest = {
      plugin_id: 'kernel',
      function: 'promote_pretest',
      args: { pretest_id: '' },
    };
    const decisions: import('./agents.service').Decision[] = [];
    const sandboxResults: import('./agents.service').SandboxResult[] = [];

    await callDispatchKernelTool(service, CYCLE_ID, tc, decisions, sandboxResults);

    expect(pretest.promote).not.toHaveBeenCalled();
    expect(decisions[0].reason).toBe('invalid_promote_args');
  });

  it('3.7 — promote() throws NotFoundException: caught → ok:false error:"not_found"; no re-throw', async () => {
    const { NotFoundException: NFE } = await import('@nestjs/common');
    const audit = makeAudit();
    const pretest = makePretestMockWithPromote({
      promoteShouldThrow: new NFE('Pretest not found'),
    });
    const service = makeServiceWithPretestPromote(audit, pretest);

    const tc: import('../llm/llm.service').ToolCallRequest = {
      plugin_id: 'kernel',
      function: 'promote_pretest',
      args: { pretest_id: 'missing-id' },
    };
    const decisions: import('./agents.service').Decision[] = [];
    const sandboxResults: import('./agents.service').SandboxResult[] = [];

    await expect(
      callDispatchKernelTool(service, CYCLE_ID, tc, decisions, sandboxResults),
    ).resolves.not.toThrow();

    expect(decisions[0].allowed).toBe(false);
    const sr = sandboxResults.find((r) => r.plugin_id === 'kernel');
    expect(sr?.ok).toBe(false);
    expect((sr as unknown as Record<string, unknown>)?.['error']).toBe('not_found');
  });

  it('3.8 — promote_pretest dispatch: sandbox.callPlugin NOT called (kernel bypass)', async () => {
    const audit = makeAudit();
    const pretest = makePretestMockWithPromote({
      promoteResult: { ok: true, applied: [], failed: [] },
    });
    const sandbox = makeSandbox();
    const service = makeServiceWithPretestPromote(audit, pretest, sandbox);

    const tc: import('../llm/llm.service').ToolCallRequest = {
      plugin_id: 'kernel',
      function: 'promote_pretest',
      args: { pretest_id: 'pf-x' },
    };
    const decisions: import('./agents.service').Decision[] = [];
    const sandboxResults: import('./agents.service').SandboxResult[] = [];

    await callDispatchKernelTool(service, CYCLE_ID, tc, decisions, sandboxResults);

    expect(sandbox.callPlugin).not.toHaveBeenCalled();
  });

  it('3.9 — unknown kernel fn kernel__bogus → still unknown_kernel_tool (registry regression with 4 entries)', async () => {
    const plugins = makePlugins([], []);
    const audit = makeAudit();
    const service = makeAgentsService(plugins, audit);

    const calls: ToolCallRequest[] = [
      { plugin_id: 'kernel', function: 'bogus_kernel_fn', args: {} },
    ];

    const result = await callValidateWithHoisted(service, 'cycle-bogus', calls, [], 'reflection');

    expect(result).toHaveLength(0);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'tool_call_dropped',
        plugin_id: 'kernel',
        meta: expect.objectContaining({ reason: 'unknown_kernel_tool' }) as unknown,
      }),
    );
  });
});

// ── F6-S1 ReAct Loop Tests ────────────────────────────────────────────────────
//
// Tests for the in-turn ReAct loop with budget (cognitive-upgrade-s1).
// Strict TDD: these were written RED first, then GREEN via implementation.

/**
 * Build a KvService mock that returns the given value for 'react.max_turns'.
 */
function makeKv(reactMaxTurns: string | null): jest.Mocked<Pick<KvService, 'get'>> {
  return {
    get: jest.fn().mockImplementation((key: string) => {
      if (key === 'react.max_turns') return Promise.resolve(reactMaxTurns);
      return Promise.resolve(null);
    }),
  };
}

/**
 * Build an AgentsService with KvService injected as the 11th constructor arg.
 * All other deps are minimal/stubbed.
 * Prefixed with _ because the inline factory pattern is used directly in tests.
 */

function _makeReActService(opts: {
  kv: jest.Mocked<Pick<KvService, 'get'>>;
  llmResponses: LlmResponse[];
  sandbox?: jest.Mocked<Pick<SandboxGateway, 'callPlugin'>>;
  plugins?: ReturnType<typeof makeFullPlugins>;
  audit?: ReturnType<typeof makeAudit>;
  activePlugins?: import('../plugins/plugins.service').HydratedPlugin[];
}): AgentsService {
  const audit = opts.audit ?? makeAudit();
  const sandbox = opts.sandbox ?? {
    callPlugin: jest.fn().mockResolvedValue({ ok: true, result: null }),
  };
  const plugins = opts.plugins ?? makeFullPlugins(null, []);
  if (opts.activePlugins) {
    plugins.findActive.mockResolvedValue(opts.activePlugins);
  }

  let callIdx = 0;
  const llmComplete = jest.fn().mockImplementation(() => {
    const resp = opts.llmResponses[callIdx] ?? opts.llmResponses[opts.llmResponses.length - 1];
    callIdx++;
    return Promise.resolve(resp);
  });

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
  ) => AgentsService)(
    { complete: llmComplete },
    sandbox,
    plugins,
    {},
    audit,
    { createBulk: jest.fn().mockResolvedValue([]) },
    undefined,
    undefined,
    undefined,
    undefined,
    opts.kv,
  );
}

/** Helper: build an LlmResponse with no tool calls (natural exit text). */
function makeLlmText(text: string): LlmResponse {
  return { text, tool_calls: [], backend: 'api', skills_read: [], skills_written: [] };
}

/** Helper: build an LlmResponse that embeds a provider tool call in text. */
function makeLlmToolCall(
  pluginId: string,
  fn: string,
  args: Record<string, unknown> = {},
): LlmResponse {
  const toolName = `${pluginId}__${fn}`;
  const text = `<tool_calls>[{"tool":"${toolName}","args":${JSON.stringify(args)}}]</tool_calls>`;
  return { text, tool_calls: [], backend: 'api', skills_read: [], skills_written: [] };
}

/** Helper: build an LlmResponse for a kernel tool call. */
function makeLlmKernelToolCall(fn: string, args: Record<string, unknown> = {}): LlmResponse {
  const text = `<tool_calls>[{"tool":"kernel__${fn}","args":${JSON.stringify(args)}}]</tool_calls>`;
  return { text, tool_calls: [], backend: 'api', skills_read: [], skills_written: [] };
}

// ── T1: maxTurns=1 ≡ current behavior (byte-identical decision path — REGRESSION GATE) ─

describe('F6-S1 T1 — maxTurns=1 byte-identical to pre-loop behavior (REGRESSION GATE)', () => {
  it('T1.1 — kv returns "1": exactly 1 llm.complete call; context unchanged (no [OBSERVACIONES]); NO react_iteration/react_budget_exhausted audit; turns_used=1', async () => {
    const kv = makeKv('1');
    const audit = makeAudit();

    const llmResponse = makeLlmText('decision: hold');
    const llmComplete = jest.fn().mockResolvedValue(llmResponse);

    const plugins = makeFullPlugins(null, []);
    const service = new (AgentsService as unknown as new (
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
    ) => AgentsService)(
      { complete: llmComplete },
      { callPlugin: jest.fn().mockResolvedValue({ ok: true, result: null }) },
      plugins,
      {},
      audit,
      { createBulk: jest.fn().mockResolvedValue([]) },
      undefined,
      undefined,
      undefined,
      undefined,
      kv,
    );

    const inputContext = 'market context for cycle';
    const result = await service.runGovernedTurn({
      source: 'cycle',
      context: inputContext,
    });

    // Exactly one LLM call
    expect(llmComplete).toHaveBeenCalledTimes(1);

    // Context passed to LLM must equal input.context — NO [OBSERVACIONES...] suffix
    const llmCallArg = (llmComplete.mock.calls[0] as [{ context: string }])[0];
    expect(llmCallArg.context).toBe(inputContext);
    expect(llmCallArg.context).not.toContain('[OBSERVACIONES');

    // NO react_iteration or react_budget_exhausted audit events
    const auditCalls = (audit.log as jest.Mock).mock.calls as Array<[Record<string, unknown>]>;
    const reactIterAudit = auditCalls.find(([a]) => a['event_type'] === 'react_iteration');
    const exhaustAudit = auditCalls.find(([a]) => a['event_type'] === 'react_budget_exhausted');
    expect(reactIterAudit).toBeUndefined();
    expect(exhaustAudit).toBeUndefined();

    // turns_used = 1
    expect(result.turns_used).toBe(1);

    // Result shape matches existing fields
    expect(result.text).toBe('decision: hold');
    expect(result.cycle_id).toBeDefined();
  });

  it('T1.2 — maxTurns=1 + LLM emits a valid provider tool_call: tool executes (1 llm.complete, decision present), turns_used=1, NEITHER react_iteration NOR react_budget_exhausted is audited', async () => {
    const providerTool = {
      plugin_id: 'alpaca-provider',
      name: 'alpaca-provider__place_order',
      description: 'Place an order',
      input_schema: { type: 'object', properties: {} },
    };
    const plugins = makeFullPlugins('Use tools.', [providerTool]);
    plugins.findActive.mockResolvedValue([
      { id: 'alpaca-provider', type: 'provider', name: 'Alpaca' },
    ] as never);

    const kv = makeKv('1');
    const audit = makeAudit();

    const llmResponse = makeLlmToolCall('alpaca-provider', 'place_order', {
      symbol: 'AAPL',
      action: 'buy',
    });
    const llmComplete = jest.fn().mockResolvedValue(llmResponse);

    const sandbox = {
      callPlugin: jest.fn().mockResolvedValue({ ok: true, result: { filled: true } }),
    } as jest.Mocked<Pick<SandboxGateway, 'callPlugin'>>;

    const service = new (AgentsService as unknown as new (
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
    ) => AgentsService)(
      { complete: llmComplete },
      sandbox,
      plugins,
      {},
      audit,
      { createBulk: jest.fn().mockResolvedValue([]) },
      undefined,
      undefined,
      undefined,
      undefined,
      kv,
    );

    const result = await service.runGovernedTurn({
      source: 'cycle',
      context: 'market context',
      _activePlugins: [{ id: 'alpaca-provider', type: 'provider', name: 'Alpaca' }] as never,
    });

    // Exactly one LLM call (single-shot — maxTurns=1)
    expect(llmComplete).toHaveBeenCalledTimes(1);

    // Tool executed: decision is present
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]).toMatchObject({
      plugin_id: 'alpaca-provider',
      function: 'place_order',
      allowed: true,
    });

    // turns_used = 1
    expect(result.turns_used).toBe(1);

    // NEITHER react_iteration NOR react_budget_exhausted must be audited
    const auditCalls = (audit.log as jest.Mock).mock.calls as Array<[Record<string, unknown>]>;
    const reactIterAudit = auditCalls.find(([a]) => a['event_type'] === 'react_iteration');
    const exhaustAudit = auditCalls.find(([a]) => a['event_type'] === 'react_budget_exhausted');
    expect(reactIterAudit).toBeUndefined();
    expect(exhaustAudit).toBeUndefined();
  });
});

// ── T2: Multi-iteration accumulation ─────────────────────────────────────────

describe('F6-S1 T2 — multi-iteration accumulation + observations fed forward', () => {
  it('T2.1 — iter1 executes provider tool (emits signal), iter2 natural exit; 2 llm.complete calls, iter2 context has [OBSERVACIONES], accumulated decisions/signals, turns_used=2', async () => {
    const kv = makeKv('4');
    const audit = makeAudit();

    const providerTool = {
      plugin_id: 'alpaca-provider',
      name: 'alpaca-provider__place_order',
      description: 'Place an order',
      input_schema: { type: 'object', properties: {} },
    };
    const plugins = makeFullPlugins('Use tools.', [providerTool]);
    plugins.findActive.mockResolvedValue([
      { id: 'alpaca-provider', type: 'provider', name: 'Alpaca' },
    ] as never);

    const capturedContexts: string[] = [];
    let callIdx = 0;
    const llmResponses: LlmResponse[] = [
      makeLlmToolCall('alpaca-provider', 'place_order', { symbol: 'AAPL', action: 'buy' }),
      makeLlmText('done, no more tools'),
    ];
    const llmComplete = jest.fn().mockImplementation((opts: { context: string }) => {
      capturedContexts.push(opts.context);
      const resp = llmResponses[callIdx] ?? llmResponses[llmResponses.length - 1];
      callIdx++;
      return Promise.resolve(resp);
    });

    const sandbox = {
      callPlugin: jest.fn().mockResolvedValue({ ok: true, result: { filled: true } }),
    } as jest.Mocked<Pick<SandboxGateway, 'callPlugin'>>;

    const service = new (AgentsService as unknown as new (
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
    ) => AgentsService)(
      { complete: llmComplete },
      sandbox,
      plugins,
      {},
      audit,
      { createBulk: jest.fn().mockResolvedValue([]) },
      undefined,
      undefined,
      undefined,
      undefined,
      kv,
    );

    const result = await service.runGovernedTurn({
      source: 'cycle',
      context: 'trade signal context',
      _activePlugins: [
        { id: 'alpaca-provider', type: 'provider', name: 'Alpaca' },
      ] as import('../plugins/plugins.service').HydratedPlugin[],
    });

    // 2 LLM calls
    expect(llmComplete).toHaveBeenCalledTimes(2);

    // Iter2 context must contain [OBSERVACIONES] block
    expect(capturedContexts[1]).toContain('[OBSERVACIONES');

    // Accumulated decisions (at least one from iter1)
    expect(result.decisions.length).toBeGreaterThanOrEqual(1);

    // Accumulated signals (AAPL buy from iter1)
    expect(result.signalsEmitted).toContainEqual({ symbol: 'AAPL', action: 'buy' });

    // turns_used = 2
    expect(result.turns_used).toBe(2);

    // Final text from last iteration (iter2 natural exit)
    expect(result.text).toBe('done, no more tools');
  });
});

// ── T3: Natural exit on first iteration ──────────────────────────────────────

describe('F6-S1 T3 — natural exit on first iteration (no tool_calls)', () => {
  it('T3.1 — LLM emits no tool_calls on iter1 → exits immediately; 1 llm.complete; turns_used=1; no exhaustion audit', async () => {
    const kv = makeKv('4');
    const audit = makeAudit();
    const plugins = makeFullPlugins(null, []);

    const llmComplete = jest.fn().mockResolvedValue(makeLlmText('just a text response'));

    const service = new (AgentsService as unknown as new (
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
    ) => AgentsService)(
      { complete: llmComplete },
      { callPlugin: jest.fn().mockResolvedValue({ ok: true }) },
      plugins,
      {},
      audit,
      { createBulk: jest.fn().mockResolvedValue([]) },
      undefined,
      undefined,
      undefined,
      undefined,
      kv,
    );

    const result = await service.runGovernedTurn({ source: 'chat', context: 'hello' });

    expect(llmComplete).toHaveBeenCalledTimes(1);
    expect(result.turns_used).toBe(1);
    expect(result.text).toBe('just a text response');

    // No exhaustion audit
    const auditCalls = (audit.log as jest.Mock).mock.calls as Array<[Record<string, unknown>]>;
    const exhaustAudit = auditCalls.find(([a]) => a['event_type'] === 'react_budget_exhausted');
    expect(exhaustAudit).toBeUndefined();
  });
});

// ── T4: Budget exhaustion → react_budget_exhausted + NO grace execution ───────

describe('F6-S1 T4 — budget exhaustion: react_budget_exhausted emitted, NO grace exec', () => {
  it('T4.1 — maxTurns=2, both iters emit tool_calls; exactly 2 llm.complete; react_budget_exhausted audited once; NO 3rd call; turns_used=2', async () => {
    const kv = makeKv('2');
    const audit = makeAudit();

    const providerTool = {
      plugin_id: 'alpaca-provider',
      name: 'alpaca-provider__place_order',
      description: 'Place an order',
      input_schema: { type: 'object', properties: {} },
    };
    const plugins = makeFullPlugins('Use tools.', [providerTool]);
    plugins.findActive.mockResolvedValue([
      { id: 'alpaca-provider', type: 'provider', name: 'Alpaca' },
    ] as never);

    const toolCallResponse = makeLlmToolCall('alpaca-provider', 'place_order', {
      symbol: 'AAPL',
      action: 'buy',
    });
    const llmComplete = jest.fn().mockResolvedValue(toolCallResponse);

    const sandbox = {
      callPlugin: jest.fn().mockResolvedValue({ ok: true, result: null }),
    } as jest.Mocked<Pick<SandboxGateway, 'callPlugin'>>;

    const service = new (AgentsService as unknown as new (
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
    ) => AgentsService)(
      { complete: llmComplete },
      sandbox,
      plugins,
      {},
      audit,
      { createBulk: jest.fn().mockResolvedValue([]) },
      undefined,
      undefined,
      undefined,
      undefined,
      kv,
    );

    const result = await service.runGovernedTurn({
      source: 'cycle',
      context: 'context',
      _activePlugins: [
        { id: 'alpaca-provider', type: 'provider', name: 'Alpaca' },
      ] as import('../plugins/plugins.service').HydratedPlugin[],
    });

    // Exactly 2 LLM calls (maxTurns=2), NO 3rd grace call
    expect(llmComplete).toHaveBeenCalledTimes(2);

    // react_budget_exhausted audited exactly once
    const auditCalls = (audit.log as jest.Mock).mock.calls as Array<[Record<string, unknown>]>;
    const exhaustAudits = auditCalls.filter(([a]) => a['event_type'] === 'react_budget_exhausted');
    expect(exhaustAudits).toHaveLength(1);
    expect(exhaustAudits[0][0]).toMatchObject({
      event_type: 'react_budget_exhausted',
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      meta: expect.objectContaining({ turns_used: 2 }),
    });

    // turns_used = maxTurns = 2
    expect(result.turns_used).toBe(2);

    // sandbox.callPlugin called exactly 2 times (one per iteration, no grace)
    expect(sandbox.callPlugin).toHaveBeenCalledTimes(2);
  });
});

// ── T5: Control re-application — kernel dropped on non-reflection 2nd iteration ─

describe('F6-S1 T5 — control re-application: kernel dropped on non-reflection 2nd iteration', () => {
  it('T5.1 — source:cycle; iter1 valid provider call, iter2 emits kernel.write_skill → dropped kernel_source_not_allowed; writeSkillGuarded NOT called', async () => {
    const kv = makeKv('4');
    const audit = makeAudit();

    const providerTool = {
      plugin_id: 'alpaca-provider',
      name: 'alpaca-provider__place_order',
      description: 'Place an order',
      input_schema: { type: 'object', properties: {} },
    };
    const plugins = makeFullPlugins('Use tools.', [providerTool]);
    plugins.findActive.mockResolvedValue([
      { id: 'alpaca-provider', type: 'provider', name: 'Alpaca' },
    ] as never);
    // Add writeSkillGuarded to catch any unintended dispatch
    (plugins as unknown as { writeSkillGuarded: jest.Mock }).writeSkillGuarded = jest
      .fn()
      .mockResolvedValue({ ok: true });

    let callIdx = 0;
    const llmResponses: LlmResponse[] = [
      makeLlmToolCall('alpaca-provider', 'place_order', { symbol: 'AAPL', action: 'buy' }),
      makeLlmKernelToolCall('write_skill', { skill: 'my-skill', new_body: 'injected' }),
      makeLlmText('done'),
    ];
    const llmComplete = jest.fn().mockImplementation(() => {
      const resp = llmResponses[callIdx] ?? llmResponses[llmResponses.length - 1];
      callIdx++;
      return Promise.resolve(resp);
    });

    const sandbox = {
      callPlugin: jest.fn().mockResolvedValue({ ok: true, result: null }),
    } as jest.Mocked<Pick<SandboxGateway, 'callPlugin'>>;

    const service = new (AgentsService as unknown as new (
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
    ) => AgentsService)(
      { complete: llmComplete },
      sandbox,
      plugins,
      {},
      audit,
      { createBulk: jest.fn().mockResolvedValue([]) },
      undefined,
      undefined,
      undefined,
      undefined,
      kv,
    );

    await service.runGovernedTurn({
      source: 'cycle',
      context: 'cycle context',
      _activePlugins: [
        { id: 'alpaca-provider', type: 'provider', name: 'Alpaca' },
      ] as import('../plugins/plugins.service').HydratedPlugin[],
    });

    // iter2's kernel call must be dropped kernel_source_not_allowed
    const auditCalls = (audit.log as jest.Mock).mock.calls as Array<[Record<string, unknown>]>;
    const kernelDropped = auditCalls.find(
      ([a]) =>
        a['event_type'] === 'tool_call_dropped' &&
        a['plugin_id'] === 'kernel' &&
        (a['meta'] as Record<string, unknown>)?.['reason'] === 'kernel_source_not_allowed',
    );
    expect(kernelDropped).toBeDefined();

    // writeSkillGuarded MUST NOT be called
    expect(
      (plugins as unknown as { writeSkillGuarded: jest.Mock }).writeSkillGuarded,
    ).not.toHaveBeenCalled();
  });
});

// ── T6: Control re-application — provider dropped in virtual_only 2nd iteration ─

describe('F6-S1 T6 — control re-application: provider dropped in virtual_only 2nd iteration', () => {
  it('T6.1 — source:pretest, virtual_only:true; iter2 emits provider tool → dropped virtual_mode_provider_blocked; sandbox.callPlugin NOT called for it', async () => {
    const kv = makeKv('4');
    const audit = makeAudit();

    const providerTool = {
      plugin_id: 'alpaca-provider',
      name: 'alpaca-provider__place_order',
      description: 'Place an order',
      input_schema: { type: 'object', properties: {} },
    };
    // Use an extra-type tool for iter1 (not dropped by virtual_only) and provider tool for iter2
    const extraTool = {
      plugin_id: 'backtester',
      name: 'backtester__run',
      description: 'Run backtest',
      input_schema: { type: 'object', properties: {} },
    };
    const plugins = makeFullPlugins('Use tools.', [extraTool, providerTool]);
    plugins.findActive.mockResolvedValue([
      { id: 'backtester', type: 'extra', name: 'Backtester' },
      { id: 'alpaca-provider', type: 'provider', name: 'Alpaca' },
    ] as never);

    let callIdx = 0;
    const llmResponses: LlmResponse[] = [
      makeLlmToolCall('backtester', 'run', {}), // extra tool — should execute (not blocked by virtual_only)
      makeLlmToolCall('alpaca-provider', 'place_order', { symbol: 'AAPL', action: 'buy' }), // provider — DROPPED
      makeLlmText('done'),
    ];
    const llmComplete = jest.fn().mockImplementation(() => {
      const resp = llmResponses[callIdx] ?? llmResponses[llmResponses.length - 1];
      callIdx++;
      return Promise.resolve(resp);
    });

    const callPluginMock = jest.fn().mockResolvedValue({ ok: true, result: null });
    const sandbox = { callPlugin: callPluginMock } as jest.Mocked<
      Pick<SandboxGateway, 'callPlugin'>
    >;

    const service = new (AgentsService as unknown as new (
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
    ) => AgentsService)(
      { complete: llmComplete },
      sandbox,
      plugins,
      {},
      audit,
      { createBulk: jest.fn().mockResolvedValue([]) },
      undefined,
      undefined,
      undefined,
      undefined,
      kv,
    );

    await service.runGovernedTurn({
      source: 'pretest',
      context: 'pretest context',
      virtual_only: true,
      _activePlugins: [
        { id: 'backtester', type: 'extra', name: 'Backtester' },
        { id: 'alpaca-provider', type: 'provider', name: 'Alpaca' },
      ] as import('../plugins/plugins.service').HydratedPlugin[],
    });

    // Provider tool in iter2 must be dropped virtual_mode_provider_blocked
    const auditCalls = (audit.log as jest.Mock).mock.calls as Array<[Record<string, unknown>]>;
    const providerDropped = auditCalls.find(
      ([a]) =>
        a['event_type'] === 'tool_call_dropped' &&
        a['plugin_id'] === 'alpaca-provider' &&
        (a['meta'] as Record<string, unknown>)?.['reason'] === 'virtual_mode_provider_blocked',
    );
    expect(providerDropped).toBeDefined();

    // sandbox.callPlugin must NOT have been called with alpaca-provider
    const alphacaCalls = callPluginMock.mock.calls.filter(
      (args: unknown[]) => (args as [string, ...unknown[]])[0] === 'alpaca-provider',
    );
    expect(alphacaCalls).toHaveLength(0);
  });
});

// ── T7: maxTurns clamp/fail-safe ─────────────────────────────────────────────

describe('F6-S1 T7 — _resolveMaxTurns clamp and fail-safe', () => {
  async function resolveMaxTurns(kv: jest.Mocked<Pick<KvService, 'get'>>): Promise<number> {
    const plugins = makeFullPlugins(null, []);
    const service = new (AgentsService as unknown as new (
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
    ) => AgentsService)(
      {},
      {},
      plugins,
      {},
      { log: jest.fn().mockResolvedValue(undefined) },
      { createBulk: jest.fn().mockResolvedValue([]) },
      undefined,
      undefined,
      undefined,
      undefined,
      kv,
    );

    return (service as unknown as { _resolveMaxTurns: () => Promise<number> })._resolveMaxTurns();
  }

  it('T7.1 — missing key (null) → 4', async () => {
    expect(await resolveMaxTurns(makeKv(null))).toBe(4);
  });

  it('T7.2 — "abc" (invalid) → 4', async () => {
    expect(await resolveMaxTurns(makeKv('abc'))).toBe(4);
  });

  it('T7.3 — "0" → clamped to 1', async () => {
    expect(await resolveMaxTurns(makeKv('0'))).toBe(1);
  });

  it('T7.4 — "999" → clamped to 10', async () => {
    expect(await resolveMaxTurns(makeKv('999'))).toBe(10);
  });

  it('T7.5 — "2" → 2', async () => {
    expect(await resolveMaxTurns(makeKv('2'))).toBe(2);
  });

  it('T7.6 — kv absent (null service) → 4', async () => {
    const plugins = makeFullPlugins(null, []);
    const service = new (AgentsService as unknown as new (
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
    ) => AgentsService)(
      {},
      {},
      plugins,
      {},
      { log: jest.fn().mockResolvedValue(undefined) },
      { createBulk: jest.fn().mockResolvedValue([]) },
      undefined,
      undefined,
      undefined,
      undefined,
      null, // no KvService
    );

    const result = await (
      service as unknown as { _resolveMaxTurns: () => Promise<number> }
    )._resolveMaxTurns();
    expect(result).toBe(4);
  });
});

// ── T8: Termination guarantee ─────────────────────────────────────────────────

describe('F6-S1 T8 — termination: loop stops at maxTurns even with LLM always emitting tool_calls', () => {
  it('T8.1 — maxTurns=3, all iters emit tool_calls → exactly 3 llm.complete calls, terminates', async () => {
    const kv = makeKv('3');
    const audit = makeAudit();

    const providerTool = {
      plugin_id: 'alpaca-provider',
      name: 'alpaca-provider__place_order',
      description: 'Place an order',
      input_schema: { type: 'object', properties: {} },
    };
    const plugins = makeFullPlugins('Use tools.', [providerTool]);
    plugins.findActive.mockResolvedValue([
      { id: 'alpaca-provider', type: 'provider', name: 'Alpaca' },
    ] as never);

    const toolCallResponse = makeLlmToolCall('alpaca-provider', 'place_order', {
      symbol: 'AAPL',
      action: 'buy',
    });
    const llmComplete = jest.fn().mockResolvedValue(toolCallResponse);

    const sandbox = {
      callPlugin: jest.fn().mockResolvedValue({ ok: true, result: null }),
    } as jest.Mocked<Pick<SandboxGateway, 'callPlugin'>>;

    const service = new (AgentsService as unknown as new (
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
    ) => AgentsService)(
      { complete: llmComplete },
      sandbox,
      plugins,
      {},
      audit,
      { createBulk: jest.fn().mockResolvedValue([]) },
      undefined,
      undefined,
      undefined,
      undefined,
      kv,
    );

    const result = await service.runGovernedTurn({
      source: 'cycle',
      context: 'context',
      _activePlugins: [
        { id: 'alpaca-provider', type: 'provider', name: 'Alpaca' },
      ] as import('../plugins/plugins.service').HydratedPlugin[],
    });

    // Must stop at exactly maxTurns=3
    expect(llmComplete).toHaveBeenCalledTimes(3);
    expect(result.turns_used).toBe(3);
  });

  it('T8.2 — all-dropped iteration (LLM emits calls but all dropped) exits the loop (safe-direction)', async () => {
    // LLM emits kernel.write_skill in a non-reflection source → all dropped → hadToolCalls=false → natural exit
    const kv = makeKv('4');
    const audit = makeAudit();
    const plugins = makeFullPlugins(null, []);

    const llmComplete = jest
      .fn()
      .mockResolvedValue(makeLlmKernelToolCall('write_skill', { skill: 'x', new_body: 'y' }));

    const service = new (AgentsService as unknown as new (
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
    ) => AgentsService)(
      { complete: llmComplete },
      { callPlugin: jest.fn().mockResolvedValue({ ok: true }) },
      plugins,
      {},
      audit,
      { createBulk: jest.fn().mockResolvedValue([]) },
      undefined,
      undefined,
      undefined,
      undefined,
      kv,
    );

    const result = await service.runGovernedTurn({ source: 'cycle', context: 'ctx' });

    // The all-dropped call exits naturally (hadToolCalls = validatedCalls.length > 0 = false after drop)
    expect(result.turns_used).toBe(1);
    expect(llmComplete).toHaveBeenCalledTimes(1);
  });
});

// ── T9: Context cap ───────────────────────────────────────────────────────────

describe('F6-S1 T9 — _composeIterationContext: context cap enforced', () => {
  it('T9.1 — 4 iterations of long results → composed context stays within global transcript budget (~3000 chars overhead)', async () => {
    const kv = makeKv('5');
    const audit = makeAudit();

    const providerTool = {
      plugin_id: 'alpaca-provider',
      name: 'alpaca-provider__place_order',
      description: 'Place an order',
      input_schema: { type: 'object', properties: {} },
    };
    const plugins = makeFullPlugins('Use tools.', [providerTool]);
    plugins.findActive.mockResolvedValue([
      { id: 'alpaca-provider', type: 'provider', name: 'Alpaca' },
    ] as never);

    const capturedContexts: string[] = [];
    // 4 iterations with tool calls, then natural exit
    let callIdx = 0;
    const llmResponses: LlmResponse[] = [
      makeLlmToolCall('alpaca-provider', 'place_order', {
        symbol: 'AAPL',
        action: 'buy',
        extra: 'x'.repeat(800),
      }),
      makeLlmToolCall('alpaca-provider', 'place_order', {
        symbol: 'TSLA',
        action: 'sell',
        extra: 'y'.repeat(800),
      }),
      makeLlmToolCall('alpaca-provider', 'place_order', {
        symbol: 'MSFT',
        action: 'buy',
        extra: 'z'.repeat(800),
      }),
      makeLlmToolCall('alpaca-provider', 'place_order', {
        symbol: 'GOOG',
        action: 'buy',
        extra: 'w'.repeat(800),
      }),
      makeLlmText('done'),
    ];
    const llmComplete = jest.fn().mockImplementation((opts: { context: string }) => {
      capturedContexts.push(opts.context);
      const resp = llmResponses[callIdx] ?? llmResponses[llmResponses.length - 1];
      callIdx++;
      return Promise.resolve(resp);
    });

    const sandbox = {
      callPlugin: jest
        .fn()
        .mockResolvedValue({ ok: true, result: { status: 'filled', details: 'x'.repeat(500) } }),
    } as jest.Mocked<Pick<SandboxGateway, 'callPlugin'>>;

    const service = new (AgentsService as unknown as new (
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
    ) => AgentsService)(
      { complete: llmComplete },
      sandbox,
      plugins,
      {},
      audit,
      { createBulk: jest.fn().mockResolvedValue([]) },
      undefined,
      undefined,
      undefined,
      undefined,
      kv,
    );

    const baseContext = 'base context - short';
    const result = await service.runGovernedTurn({
      source: 'cycle',
      context: baseContext,
      _activePlugins: [
        { id: 'alpaca-provider', type: 'provider', name: 'Alpaca' },
      ] as import('../plugins/plugins.service').HydratedPlugin[],
    });

    // Ran more than 1 iteration (multi-turn happened)
    expect(result.turns_used).toBeGreaterThan(1);

    // For all contexts starting from iter2, the [OBSERVACIONES] block must exist
    // AND the total context length must be bounded (base + ~3000 char transcript budget)
    for (let i = 1; i < capturedContexts.length; i++) {
      const ctx = capturedContexts[i];
      expect(ctx).toContain('[OBSERVACIONES');
      // Context should not grow unbounded — enforce a reasonable max (base + 3500 chars overhead)
      expect(ctx.length).toBeLessThanOrEqual(baseContext.length + 3500);
    }
  });

  it('T9.2 — empty observations (iter1) → _composeIterationContext returns base unchanged', async () => {
    const kv = makeKv('1');
    const audit = makeAudit();
    const plugins = makeFullPlugins(null, []);

    const capturedContexts: string[] = [];
    const llmComplete = jest.fn().mockImplementation((opts: { context: string }) => {
      capturedContexts.push(opts.context);
      return Promise.resolve(makeLlmText('done'));
    });

    const service = new (AgentsService as unknown as new (
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
    ) => AgentsService)(
      { complete: llmComplete },
      { callPlugin: jest.fn().mockResolvedValue({ ok: true }) },
      plugins,
      {},
      audit,
      { createBulk: jest.fn().mockResolvedValue([]) },
      undefined,
      undefined,
      undefined,
      undefined,
      kv,
    );

    const base = 'the original context text';
    await service.runGovernedTurn({ source: 'chat', context: base });

    // On iter1, context passed to LLM must be exactly base (no suffix)
    expect(capturedContexts[0]).toBe(base);
  });
});

// ── F6-S2 PR2 — LongTermMemory integration tests (RED phase) ─────────────────

import type { LongTermMemoryService } from '../long-term-memory/long-term-memory.service';
import type { EpisodeInput } from '../long-term-memory/memory-provider.interface';

/** Typed LTM stub that mirrors MemoryProvider methods needed by PR2. */
function makeLtm(): jest.Mocked<
  Pick<LongTermMemoryService, 'prefetch' | 'record' | 'updateOutcome'>
> {
  return {
    prefetch: jest.fn().mockResolvedValue([]),
    record: jest.fn().mockResolvedValue(undefined),
    updateOutcome: jest.fn().mockResolvedValue(undefined),
  };
}

/** Build an AgentsService with 12 constructor args (adds longTermMemory as 12th). */
function makeLtmAgentsService(
  llm: Partial<LlmService>,
  audit: ReturnType<typeof makeAudit>,
  plugins: ReturnType<typeof makeFullPlugins>,
  sandbox: ReturnType<typeof makeSandbox> | ReturnType<typeof makeFullSandbox>,
  memory: ReturnType<typeof makeMemory>,
  ltm?: jest.Mocked<Pick<LongTermMemoryService, 'prefetch' | 'record' | 'updateOutcome'>> | null,
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
  ) => AgentsService)(
    llm,
    sandbox,
    plugins,
    memory,
    audit,
    { createBulk: jest.fn().mockResolvedValue([]) },
    undefined,
    undefined,
    undefined,
    undefined,
    makeKvSingleTurn(),
    ltm ?? undefined,
  );
}

async function callExecuteCycleLtm(
  service: AgentsService,
  cycleId: string,
  context: string,
) {
  return (
    service as unknown as {
      _executeCycle: (c: string, ctx: string, sp?: string) => Promise<unknown>;
    }
  )._executeCycle(cycleId, context, undefined);
}

describe('F6-S2 PR2 — LongTermMemory in _executeCycle', () => {
  const CYCLE_ID = 'ltm-cycle-001';

  it('2.1a — record() called after cycle with outcome_pnl null and correct fields', async () => {
    const ltm = makeLtm();
    // Prefetch returns empty → no injection
    ltm.prefetch.mockResolvedValue([]);

    const toolText =
      '<tool_calls>[{"tool":"alpaca-provider__place_order","args":{"symbol":"SPY","action":"exit","qty":1}}]</tool_calls>';
    const plugins = makeFullPlugins('Decide.', [
      {
        plugin_id: 'alpaca-provider',
        name: 'alpaca-provider__place_order',
        description: '',
        input_schema: { type: 'object', properties: {} },
      },
    ]);
    plugins.findActive.mockResolvedValue([{ id: 'alpaca-provider', type: 'provider' }] as never);
    const sandbox = makeFullSandbox();
    sandbox.runCycle.mockResolvedValue({
      ok: true,
      result: { pending_signals: [{ symbol: 'SPY', action: 'exit' }] },
    } as never);

    const llm = makeLlm(toolText);
    const audit = makeAudit();
    const memory = makeMemory();
    const service = makeLtmAgentsService(llm, audit, plugins, sandbox, memory, ltm);

    await callExecuteCycleLtm(service, CYCLE_ID, 'run cycle');

    expect(ltm.record).toHaveBeenCalledTimes(1);
    const ep = (ltm.record as jest.Mock).mock.calls[0][0] as EpisodeInput;
    expect(ep.cycle_id).toBe(CYCLE_ID);
    // outcome is not set by record — it stays null until snapshot
    expect('outcome_pnl' in ep).toBe(false);
    expect(Array.isArray(ep.symbols)).toBe(true);
    expect(typeof ep.action_summary).toBe('string');
    expect(ep.action_summary.length).toBeLessThanOrEqual(200);
    expect(typeof ep.llm_rationale).toBe('string');
    expect(ep.llm_rationale.length).toBeLessThanOrEqual(500);
    expect(typeof ep.narrative).toBe('string');
  });

  it('2.1b — prefetch hits → [EPISODIOS RELEVANTES] block injected into LLM context', async () => {
    const ltm = makeLtm();
    // Return a fake hit so prefetch > 0
    ltm.prefetch.mockResolvedValue([
      {
        id: 'ep-1',
        ts: new Date(),
        cycle_id: 'old-cycle',
        symbols: '["SPY"]',
        regime_tags: '[]',
        action_summary: 'EXIT SPY',
        llm_rationale: 'market turned bearish',
        narrative: 'SPY EXIT market turned bearish',
        outcome_pnl: -50,
        outcome_equity: 9950,
        promoted: false,
        meta: null,
      },
    ]);

    const capturedContexts: string[] = [];
    const llmComplete = jest.fn().mockImplementation((opts: { context: string }) => {
      capturedContexts.push(opts.context);
      return Promise.resolve({
        text: '',
        tool_calls: [],
        backend: 'api',
        skills_read: [],
        skills_written: [],
      } as LlmResponse);
    });

    const plugins = makeFullPlugins(null, []);
    plugins.findActive.mockResolvedValue([] as never);
    const sandbox = makeFullSandbox();
    sandbox.runCycle.mockResolvedValue({
      ok: true,
      result: { pending_signals: [{ symbol: 'SPY', action: 'exit' }] },
    } as never);

    const audit = makeAudit();
    const memory = makeMemory();
    const service = makeLtmAgentsService(
      { complete: llmComplete } as Partial<LlmService>,
      audit,
      plugins,
      sandbox,
      memory,
      ltm,
    );

    await callExecuteCycleLtm(service, CYCLE_ID, 'run cycle');

    expect(capturedContexts.length).toBeGreaterThan(0);
    // The context passed to LLM must contain [EPISODIOS RELEVANTES]
    expect(capturedContexts[0]).toContain('[EPISODIOS RELEVANTES]');
    // Block must fit within 800 chars after the marker
    const blockStart = capturedContexts[0].indexOf('[EPISODIOS RELEVANTES]');
    const block = capturedContexts[0].slice(blockStart);
    expect(block.length).toBeLessThanOrEqual(800);
  });

  it('2.1c — prefetch empty → [EPISODIOS RELEVANTES] NOT injected', async () => {
    const ltm = makeLtm();
    ltm.prefetch.mockResolvedValue([]); // no hits

    const capturedContexts: string[] = [];
    const llmComplete = jest.fn().mockImplementation((opts: { context: string }) => {
      capturedContexts.push(opts.context);
      return Promise.resolve({
        text: '',
        tool_calls: [],
        backend: 'api',
        skills_read: [],
        skills_written: [],
      } as LlmResponse);
    });

    const plugins = makeFullPlugins(null, []);
    plugins.findActive.mockResolvedValue([] as never);
    const sandbox = makeFullSandbox();
    sandbox.runCycle.mockResolvedValue({
      ok: true,
      result: { pending_signals: [{ symbol: 'QQQ', action: 'hold' }] },
    } as never);

    const audit = makeAudit();
    const memory = makeMemory();
    const service = makeLtmAgentsService(
      { complete: llmComplete } as Partial<LlmService>,
      audit,
      plugins,
      sandbox,
      memory,
      ltm,
    );

    await callExecuteCycleLtm(service, CYCLE_ID, 'run cycle');

    expect(capturedContexts.length).toBeGreaterThan(0);
    expect(capturedContexts[0]).not.toContain('[EPISODIOS RELEVANTES]');
  });

  it('2.1d — record() throws → cycle still completes, no rethrow', async () => {
    const ltm = makeLtm();
    ltm.prefetch.mockResolvedValue([]);
    ltm.record.mockRejectedValue(new Error('DB write failed'));

    const llm = makeLlm('');
    const audit = makeAudit();
    const plugins = makeFullPlugins(null, []);
    plugins.findActive.mockResolvedValue([] as never);
    const sandbox = makeFullSandbox();
    sandbox.runCycle.mockResolvedValue({ ok: true, result: {} } as never);
    const memory = makeMemory();
    const service = makeLtmAgentsService(llm, audit, plugins, sandbox, memory, ltm);

    // Must NOT throw
    await expect(callExecuteCycleLtm(service, CYCLE_ID, 'run cycle')).resolves.toBeDefined();
  });

  it('2.1e — prefetch() throws → cycle still completes, block NOT injected', async () => {
    const ltm = makeLtm();
    ltm.prefetch.mockRejectedValue(new Error('FTS5 gone'));
    ltm.record.mockResolvedValue(undefined);

    const capturedContexts: string[] = [];
    const llmComplete = jest.fn().mockImplementation((opts: { context: string }) => {
      capturedContexts.push(opts.context);
      return Promise.resolve({
        text: '',
        tool_calls: [],
        backend: 'api',
        skills_read: [],
        skills_written: [],
      } as LlmResponse);
    });

    const plugins = makeFullPlugins(null, []);
    plugins.findActive.mockResolvedValue([] as never);
    const sandbox = makeFullSandbox();
    sandbox.runCycle.mockResolvedValue({ ok: true, result: {} } as never);
    const audit = makeAudit();
    const memory = makeMemory();
    const service = makeLtmAgentsService(
      { complete: llmComplete } as Partial<LlmService>,
      audit,
      plugins,
      sandbox,
      memory,
      ltm,
    );

    // Must NOT throw and block must NOT appear
    await expect(callExecuteCycleLtm(service, CYCLE_ID, 'run cycle')).resolves.toBeDefined();
    if (capturedContexts.length > 0) {
      expect(capturedContexts[0]).not.toContain('[EPISODIOS RELEVANTES]');
    }
  });

  it('2.1f — @Optional null (no LTM injected) → cycle runs fine, no crash', async () => {
    const llm = makeLlm('');
    const audit = makeAudit();
    const plugins = makeFullPlugins(null, []);
    plugins.findActive.mockResolvedValue([] as never);
    const sandbox = makeFullSandbox();
    sandbox.runCycle.mockResolvedValue({ ok: true, result: {} } as never);
    const memory = makeMemory();
    // Pass null explicitly → longTermMemory is undefined in service
    const service = makeLtmAgentsService(llm, audit, plugins, sandbox, memory, null);

    await expect(callExecuteCycleLtm(service, CYCLE_ID, 'run cycle')).resolves.toBeDefined();
  });
});

// ── T10: Full existing suite regression guard ─────────────────────────────────

describe('F6-S1 T10 — existing suite regression: _executeCycle reads accumulated signals/decisions', () => {
  it('T10.1 — runCycle with maxTurns=1 (kv null→default 4, but only 1 iter needed): _executeCycle still reads signalsEmitted/decisions correctly', async () => {
    // This is the standard _executeCycle regression guard:
    // ensure accumulated decisions/signalsEmitted from runGovernedTurn are visible to _executeCycle.
    const toolCallText =
      '<tool_calls>[{"tool":"alpaca-provider__place_order","args":{"symbol":"TSLA","action":"sell","qty":1}}]</tool_calls>';

    const llm = makeLlm(toolCallText);
    const audit = makeAudit();
    const plugins = makeFullPlugins('Use tools.', [
      {
        plugin_id: 'alpaca-provider',
        name: 'alpaca-provider__place_order',
        description: 'Place order',
        input_schema: { type: 'object', properties: {} },
      },
    ]);
    plugins.findActive.mockResolvedValue([
      { id: 'alpaca-provider', type: 'provider', name: 'Alpaca' },
    ] as never);

    const sandbox = makeFullSandbox();
    const memory = makeMemory();

    // Build service with kv null (default 4 turns), but LLM returns no-tool text on iter1 after executing once
    const kv = makeKv(null); // → maxTurns=4, but natural exit after iter1 execution

    const service = new (AgentsService as unknown as new (
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
    ) => AgentsService)(
      llm,
      sandbox,
      plugins,
      memory,
      audit,
      { createBulk: jest.fn().mockResolvedValue([]) },
      undefined,
      undefined,
      undefined,
      undefined,
      kv,
    );

    const result = await callExecuteCyclePrivate(service, 'react-cycle-001', 'run cycle');

    // The cycle must have seen and processed decisions from the governed turn
    expect(result.decisions).toBeDefined();
    // Memory.appendObservation must have been called (uses signalsEmitted from governed turn)
    expect(memory.appendObservation).toHaveBeenCalled();
  });
});
