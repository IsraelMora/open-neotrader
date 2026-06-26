import { LlmService } from './llm.service';
import type { ProviderTool } from '../plugins/plugins.service';
import { ConfigService } from '@nestjs/config';
import { PluginsService } from '../plugins/plugins.service';

// ── Minimal stubs ─────────────────────────────────────────────────────────────

function makeConfig(overrides: Record<string, string> = {}): ConfigService {
  const values: Record<string, string> = {
    LLM_MODEL: 'test-model',
    LLM_BACKEND: 'anthropic',
    ANTHROPIC_API_KEY: 'test-key',
    ...overrides,
  };
  return { get: (k: string, d?: unknown) => values[k] ?? d } as unknown as ConfigService;
}

function makePlugins(): PluginsService {
  return {
    isExtraActive: jest.fn().mockResolvedValue(false),
    getSkillsMetadata: jest.fn().mockResolvedValue([]),
    loadSkillContent: jest.fn().mockResolvedValue(null),
  } as unknown as PluginsService;
}

function makeKvStub() {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
  } as unknown as import('../common/kv.service').KvService;
}

// ── Fake Anthropic API response ───────────────────────────────────────────────

function mockFetch(responseText: string): void {
  globalThis.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ content: [{ text: responseText }] }),
  });
}

// ── Fake OpenAI API response helpers ─────────────────────────────────────────

type OpenAiToolCall = {
  id?: string;
  type?: string;
  function: { name: string; arguments: string };
};

function mockOpenAiFetch(content: string | null, toolCalls?: OpenAiToolCall[]): jest.Mock {
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    json: () =>
      Promise.resolve({
        choices: [
          {
            message: {
              content,
              ...(toolCalls ? { tool_calls: toolCalls } : {}),
            },
          },
        ],
      }),
    text: () => Promise.resolve(''),
  });
  globalThis.fetch = fetchMock;
  return fetchMock;
}

function makeDecisionTool(): ProviderTool {
  return {
    plugin_id: 'decision',
    name: 'decision__emit_trade_intent',
    description: 'Emits a trade intent signal.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        action: { type: 'string' },
        confidence: { type: 'number' },
        rationale: { type: 'string' },
      },
      required: ['symbol', 'action', 'confidence', 'rationale'],
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('LlmService.complete() — inert contract (no parseToolCalls)', () => {
  let service: LlmService;
  let plugins: PluginsService;

  beforeEach(() => {
    plugins = makePlugins();
    service = new LlmService(makeConfig(), plugins, makeKvStub());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns tool_calls: [] even when response contains a <tool_calls> block', async () => {
    const toolCallText =
      '<tool_calls>[{"tool":"alpaca-provider__place_order","args":{"symbol":"AAPL","qty":3}}]</tool_calls>';
    mockFetch(toolCallText);

    const result = await service.complete({ context: 'test' });

    // complete() does NOT parse — parsing happens in AgentsService._executeCycle().
    expect(result.tool_calls).toEqual([]);
  });

  it('returns tool_calls: [] even when response contains a fenced ```json block', async () => {
    const toolCallText = '```json\n[{"tool":"paper-trading__open_position","args":{"qty":1}}]\n```';
    mockFetch(toolCallText);

    const result = await service.complete({ context: 'test' });

    expect(result.tool_calls).toEqual([]);
  });

  it('returns empty tool_calls when response contains plain prose (no block)', async () => {
    mockFetch('The market looks bullish today. No specific tool calls needed.');

    const result = await service.complete({ context: 'test' });

    expect(result.tool_calls).toEqual([]);
  });

  it('returns empty tool_calls and does not throw when response contains malformed JSON block', async () => {
    mockFetch('<tool_calls>not valid json</tool_calls>');

    const result = await service.complete({ context: 'test' });

    expect(result.tool_calls).toEqual([]);
  });

  it('preserves existing response fields (text, backend, skills_read, skills_written)', async () => {
    mockFetch('Some analysis.');

    const result = await service.complete({ context: 'test' });

    expect(result.text).toBe('Some analysis.');
    expect(result.backend).toBe('api');
    expect(Array.isArray(result.skills_read)).toBe(true);
    expect(Array.isArray(result.skills_written)).toBe(true);
  });
});

// ── Native tool calls — completeViaOpenAi ─────────────────────────────────────

describe('LlmService.completeViaOpenAi — native tool_calls', () => {
  let service: LlmService;
  let plugins: PluginsService;

  beforeEach(() => {
    plugins = makePlugins();
    service = new LlmService(
      makeConfig({
        LLM_BACKEND: 'openai',
        OPENAI_API_KEY: 'test-openai-key',
        LLM_MODEL: 'gpt-4o-mini',
      }),
      plugins,
      makeKvStub(),
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('maps native tool_calls to ToolCallRequest[] when response contains function calls', async () => {
    const tool = makeDecisionTool();
    const nativeArgs = { symbol: 'AAPL', action: 'long', confidence: 0.7, rationale: 'x' };
    mockOpenAiFetch(null, [
      {
        id: 'call_abc123',
        type: 'function',
        function: { name: 'decision__emit_trade_intent', arguments: JSON.stringify(nativeArgs) },
      },
    ]);

    const result = await service.complete({ context: 'buy signal', tools: [tool] });

    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls[0]).toEqual({
      plugin_id: 'decision',
      function: 'emit_trade_intent',
      args: nativeArgs,
    });
  });

  it('includes tools and tool_choice:auto in the request body when tools are provided', async () => {
    const tool = makeDecisionTool();
    const fetchMock = mockOpenAiFetch('no-op', []);

    await service.complete({ context: 'test', tools: [tool] });

    const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(callArgs[1].body as string) as Record<string, unknown>;

    expect(body['tool_choice']).toBe('auto');
    expect(Array.isArray(body['tools'])).toBe(true);
    const tools = body['tools'] as Array<{ type: string; function: { name: string } }>;
    expect(tools[0].type).toBe('function');
    expect(tools[0].function.name).toBe('decision__emit_trade_intent');
  });

  it('returns tool_calls:[] and does not throw when response has no tool_calls field', async () => {
    mockOpenAiFetch('Just text, no tool calls.');

    const tool = makeDecisionTool();
    const result = await service.complete({ context: 'test', tools: [tool] });

    expect(result.tool_calls).toEqual([]);
    expect(result.text).toBe('Just text, no tool calls.');
  });

  it('returns args:{} and does not throw when tool_call arguments contain malformed JSON', async () => {
    const tool = makeDecisionTool();
    mockOpenAiFetch(null, [
      {
        id: 'call_bad',
        type: 'function',
        function: { name: 'decision__emit_trade_intent', arguments: 'not-valid-json' },
      },
    ]);

    const result = await service.complete({ context: 'test', tools: [tool] });

    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls[0].args).toEqual({});
  });

  it('does NOT include tools or tool_choice in request body when no tools provided', async () => {
    const fetchMock = mockOpenAiFetch('plain response');

    await service.complete({ context: 'test' });

    const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(callArgs[1].body as string) as Record<string, unknown>;

    expect(body['tool_choice']).toBeUndefined();
    expect(body['tools']).toBeUndefined();
  });

  it('still returns tool_calls:[] when tools is an empty array', async () => {
    const fetchMock = mockOpenAiFetch('plain response');

    await service.complete({ context: 'test', tools: [] });

    const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(callArgs[1].body as string) as Record<string, unknown>;

    expect(body['tool_choice']).toBeUndefined();
    expect(body['tools']).toBeUndefined();
  });

  it('handles multiple tool_calls in a single response', async () => {
    const tool = makeDecisionTool();
    mockOpenAiFetch(null, [
      {
        function: {
          name: 'decision__emit_trade_intent',
          arguments: '{"symbol":"AAPL","action":"long","confidence":0.8,"rationale":"a"}',
        },
      },
      {
        function: {
          name: 'decision__emit_trade_intent',
          arguments: '{"symbol":"TSLA","action":"short","confidence":0.6,"rationale":"b"}',
        },
      },
    ]);

    const result = await service.complete({ context: 'test', tools: [tool] });

    expect(result.tool_calls).toHaveLength(2);
    expect(result.tool_calls[0].args['symbol']).toBe('AAPL');
    expect(result.tool_calls[1].args['symbol']).toBe('TSLA');
  });

  it('splits name with __ correctly: plugin_id=first segment, function=rest joined', async () => {
    const tool: ProviderTool = {
      plugin_id: 'paper',
      name: 'paper__open__position',
      description: 'desc',
      input_schema: { type: 'object', properties: {}, required: [] },
    };
    mockOpenAiFetch(null, [
      { function: { name: 'paper__open__position', arguments: '{"qty":1}' } },
    ]);

    const result = await service.complete({ context: 'test', tools: [tool] });

    expect(result.tool_calls[0].plugin_id).toBe('paper');
    expect(result.tool_calls[0].function).toBe('open__position');
  });
});

// ── Native tool calls — completeViaCustom ─────────────────────────────────────

describe('LlmService.completeViaCustom — native tool_calls', () => {
  let service: LlmService;
  let plugins: PluginsService;

  beforeEach(() => {
    plugins = makePlugins();
    service = new LlmService(
      makeConfig({ LLM_BACKEND: 'custom', LLM_MODEL: 'nvidia/nemotron-3-super-120b-a12b:free' }),
      plugins,
      makeKvStub(),
    );
    // Register a custom provider and activate it
    service.addCustomProvider({
      id: 'openrouter',
      name: 'OpenRouter',
      base_url: 'https://openrouter.ai/api/v1',
      api_key_env: 'OPENROUTER_API_KEY',
      default_model: 'nvidia/nemotron-3-super-120b-a12b:free',
    });
    service.patchConfig({ custom_provider_id: 'openrouter' });
    process.env['OPENROUTER_API_KEY'] = 'test-or-key';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env['OPENROUTER_API_KEY'];
  });

  it('maps native tool_calls from custom provider response', async () => {
    const tool = makeDecisionTool();
    const nativeArgs = { symbol: 'NVDA', action: 'long', confidence: 0.85, rationale: 'momentum' };
    mockOpenAiFetch(null, [
      {
        id: 'call_xyz',
        type: 'function',
        function: { name: 'decision__emit_trade_intent', arguments: JSON.stringify(nativeArgs) },
      },
    ]);

    const result = await service.complete({ context: 'nvda signal', tools: [tool] });

    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls[0]).toEqual({
      plugin_id: 'decision',
      function: 'emit_trade_intent',
      args: nativeArgs,
    });
  });

  it('includes tools and tool_choice:auto in request body for custom provider', async () => {
    const tool = makeDecisionTool();
    const fetchMock = mockOpenAiFetch('ok', []);

    await service.complete({ context: 'test', tools: [tool] });

    const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(callArgs[1].body as string) as Record<string, unknown>;

    expect(body['tool_choice']).toBe('auto');
    expect(Array.isArray(body['tools'])).toBe(true);
  });
});

describe('LlmService — persistencia de config en KV', () => {
  it('onModuleInit restaura backend/model desde KV (sobre los defaults de env)', async () => {
    const kv = {
      get: jest.fn((k: string) =>
        Promise.resolve(
          ({ 'llm.backend': 'openai', 'llm.model': 'vendor/model:free' } as Record<string, string>)[
            k
          ] ?? null,
        ),
      ),
      set: jest.fn().mockResolvedValue(undefined),
    } as unknown as import('../common/kv.service').KvService;
    const svc = new LlmService(makeConfig(), makePlugins(), kv);
    await svc.onModuleInit();
    expect(svc.getConfig().backend).toBe('openai');
    expect(svc.getConfig().model).toBe('vendor/model:free');
  });

  it('onModuleInit desenvuelve valores KV JSON-encoded ("openai") — bug de doble encoding', async () => {
    // El panel guarda con JSON.stringify → KV puede tener '"openai"' (con comillas).
    const kv = {
      get: jest.fn((k: string) =>
        Promise.resolve(
          ({ 'llm.backend': '"openai"', 'llm.model': '"vendor/x:free"' } as Record<string, string>)[
            k
          ] ?? null,
        ),
      ),
      set: jest.fn().mockResolvedValue(undefined),
    } as unknown as import('../common/kv.service').KvService;
    const svc = new LlmService(makeConfig({ OPENAI_API_KEY: 'k' }), makePlugins(), kv);
    await svc.onModuleInit();
    expect(svc.getConfig().backend).toBe('openai'); // sin comillas
    expect(svc.getConfig().model).toBe('vendor/x:free');
    expect(svc.getReadiness().credentialPresent).toBe(true); // openai resuelve, no cae a anthropic
  });

  it('patchConfig persiste model+backend en KV', () => {
    const set = jest.fn().mockResolvedValue(undefined);
    const kv = {
      get: jest.fn().mockResolvedValue(null),
      set,
    } as unknown as import('../common/kv.service').KvService;
    const svc = new LlmService(makeConfig(), makePlugins(), kv);
    svc.patchConfig({ backend: 'openai', model: 'x/y:free' });
    expect(set).toHaveBeenCalledWith('llm.model', 'x/y:free');
    expect(set).toHaveBeenCalledWith('llm.backend', 'openai');
  });
});

describe('LlmService.getReadiness — diagnóstico de credencial del LLM', () => {
  it('backend openai SIN OPENAI_API_KEY → no listo (la causa del "no opera")', () => {
    const svc = new LlmService(
      makeConfig({ LLM_BACKEND: 'openai', OPENAI_API_KEY: '' }),
      makePlugins(),
      makeKvStub(),
    );
    const r = svc.getReadiness();
    expect(r.backend).toBe('openai');
    expect(r.credentialPresent).toBe(false);
    expect(r.requiredEnv).toBe('OPENAI_API_KEY');
  });

  it('backend anthropic CON key → listo', () => {
    const svc = new LlmService(
      makeConfig({ LLM_BACKEND: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-x' }),
      makePlugins(),
      makeKvStub(),
    );
    const r = svc.getReadiness();
    expect(r.backend).toBe('anthropic');
    expect(r.credentialPresent).toBe(true);
    expect(r.requiredEnv).toBe('ANTHROPIC_API_KEY');
  });

  it('backend subscription no requiere API key → listo', () => {
    const svc = new LlmService(
      makeConfig({ LLM_BACKEND: 'subscription' }),
      makePlugins(),
      makeKvStub(),
    );
    const r = svc.getReadiness();
    expect(r.credentialPresent).toBe(true);
    expect(r.requiredEnv).toBeNull();
  });
});
