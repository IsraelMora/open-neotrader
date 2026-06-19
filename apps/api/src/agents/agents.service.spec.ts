import { AgentsService } from './agents.service';
import type { LlmService, LlmResponse, ToolCallRequest } from '../llm/llm.service';
import type { SandboxGateway } from '../sandbox/sandbox.gateway';
import type { PluginsService } from '../plugins/plugins.service';
import type { ContextMemoryService } from '../context-memory/context-memory.service';
import type { AuditService } from '../audit/audit.service';
import type { AlertsService } from '../alerts/alerts.service';

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

function makeFullAgentsService(
  llm: Partial<LlmService>,
  audit: ReturnType<typeof makeAudit>,
  plugins: ReturnType<typeof makeFullPlugins>,
  sandbox: ReturnType<typeof makeSandbox>,
  memory: ReturnType<typeof makeMemory>,
): AgentsService {
  return new AgentsService(
    llm as unknown as LlmService,
    sandbox as unknown as SandboxGateway,
    plugins as unknown as PluginsService,
    memory as unknown as ContextMemoryService,
    audit as unknown as AuditService,
    { createBulk: jest.fn().mockResolvedValue([]) } as unknown as AlertsService,
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
