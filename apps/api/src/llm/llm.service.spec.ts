import { LlmService } from './llm.service';
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

// ── Fake Anthropic API response ───────────────────────────────────────────────

function mockFetch(responseText: string): void {
  globalThis.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ content: [{ text: responseText }] }),
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('LlmService.complete() — parseToolCalls wire', () => {
  let service: LlmService;
  let plugins: PluginsService;

  beforeEach(() => {
    plugins = makePlugins();
    service = new LlmService(makeConfig(), plugins);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('populates tool_calls when response contains a <tool_calls> block', async () => {
    const toolCallText =
      '<tool_calls>[{"tool":"alpaca-provider__place_order","args":{"symbol":"AAPL","qty":3}}]</tool_calls>';
    mockFetch(toolCallText);

    const result = await service.complete({ context: 'test' });

    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls[0]).toEqual({
      plugin_id: 'alpaca-provider',
      function: 'place_order',
      args: { symbol: 'AAPL', qty: 3 },
    });
  });

  it('populates tool_calls when response contains a fenced ```json block', async () => {
    const toolCallText =
      '```json\n[{"tool":"paper-trading__open_position","args":{"qty":1}}]\n```';
    mockFetch(toolCallText);

    const result = await service.complete({ context: 'test' });

    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls[0].plugin_id).toBe('paper-trading');
    expect(result.tool_calls[0].function).toBe('open_position');
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
