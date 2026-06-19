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
