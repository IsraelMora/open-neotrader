import { parseToolCalls } from './kernel-parser';

describe('parseToolCalls', () => {
  // ── Fenced ```json block ─────────────────────────────────────────────────────

  it('parses a fenced ```json block', () => {
    const text =
      'Here is the call:\n```json\n[{"tool":"alpaca-provider__place_order","args":{"symbol":"AAPL","qty":3}}]\n```\nEnd.';

    const result = parseToolCalls(text);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      plugin_id: 'alpaca-provider',
      function: 'place_order',
      args: { symbol: 'AAPL', qty: 3 },
    });
  });

  // ── <tool_calls> tag block ───────────────────────────────────────────────────

  it('parses a <tool_calls> XML-style tag block', () => {
    const text =
      '<tool_calls>[{"tool":"kelly-criterion__calculate_position_size","args":{}}]</tool_calls>';

    const result = parseToolCalls(text);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      plugin_id: 'kelly-criterion',
      function: 'calculate_position_size',
      args: {},
    });
  });

  // ── Bare JSON array ──────────────────────────────────────────────────────────

  it('parses a bare JSON array', () => {
    const text = '[{"tool":"paper-trading__open_position","args":{"qty":1}}]';

    const result = parseToolCalls(text);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      plugin_id: 'paper-trading',
      function: 'open_position',
      args: { qty: 1 },
    });
  });

  // ── All three formats produce identical result ───────────────────────────────

  it('produces identical ToolCallRequest[] for all three formats', () => {
    const call = { plugin_id: 'alpaca-provider', function: 'place_order', args: { symbol: 'AAPL' } };
    const fenced = '```json\n[{"tool":"alpaca-provider__place_order","args":{"symbol":"AAPL"}}]\n```';
    const tagged = '<tool_calls>[{"tool":"alpaca-provider__place_order","args":{"symbol":"AAPL"}}]</tool_calls>';
    const bare = '[{"tool":"alpaca-provider__place_order","args":{"symbol":"AAPL"}}]';

    expect(parseToolCalls(fenced)).toEqual([call]);
    expect(parseToolCalls(tagged)).toEqual([call]);
    expect(parseToolCalls(bare)).toEqual([call]);
  });

  // ── Prose-wrapped bare array ─────────────────────────────────────────────────

  it('parses a bare array wrapped in surrounding prose', () => {
    const text = 'Some analysis here. [{"tool":"alpaca-provider__place_order","args":{}}] And more text.';

    const result = parseToolCalls(text);

    expect(result).toHaveLength(1);
    expect(result[0].plugin_id).toBe('alpaca-provider');
    expect(result[0].function).toBe('place_order');
  });

  // ── Malformed JSON in detected block ────────────────────────────────────────

  it('returns [] and calls auditFn when block is detected but JSON is malformed', () => {
    const text = '<tool_calls>{bad json</tool_calls>';
    const auditFn = jest.fn();

    const result = parseToolCalls(text, auditFn);

    expect(result).toEqual([]);
    expect(auditFn).toHaveBeenCalledTimes(1);
    expect(auditFn).toHaveBeenCalledWith('{bad json');
  });

  it('calls auditFn with raw block content when fenced block is malformed', () => {
    const text = '```json\nnot valid json\n```';
    const auditFn = jest.fn();

    const result = parseToolCalls(text, auditFn);

    expect(result).toEqual([]);
    expect(auditFn).toHaveBeenCalledWith('not valid json');
  });

  // ── No tool-call block at all ────────────────────────────────────────────────

  it('returns [] and does NOT call auditFn when no block is present', () => {
    const text = 'Just some plain prose from the LLM with no tool calls at all.';
    const auditFn = jest.fn();

    const result = parseToolCalls(text, auditFn);

    expect(result).toEqual([]);
    expect(auditFn).not.toHaveBeenCalled();
  });

  // ── Multiple calls in one block ──────────────────────────────────────────────

  it('returns all calls when multiple are present in one block', () => {
    const text =
      '<tool_calls>[{"tool":"alpaca-provider__place_order","args":{"symbol":"AAPL"}},{"tool":"alpaca-provider__cancel_order","args":{"order_id":"123"}}]</tool_calls>';

    const result = parseToolCalls(text);

    expect(result).toHaveLength(2);
    expect(result[0].function).toBe('place_order');
    expect(result[1].function).toBe('cancel_order');
  });

  // ── First-__ split into {plugin_id, function} ────────────────────────────────

  it('splits on FIRST __ only so plugin_id is the part before the first __ and function is the rest', () => {
    // plugin ids are kebab-case (no underscores), so first-__ split is unambiguous
    const text = '[{"tool":"my-plugin__do_something_complex","args":{}}]';

    const result = parseToolCalls(text);

    expect(result[0].plugin_id).toBe('my-plugin');
    expect(result[0].function).toBe('do_something_complex');
  });

  // ── Object-form {plugin_id, function, args} fallback ────────────────────────

  it('accepts object-form {plugin_id, function, args} directly', () => {
    const text =
      '[{"plugin_id":"alpaca-provider","function":"place_order","args":{"symbol":"AAPL"}}]';

    const result = parseToolCalls(text);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      plugin_id: 'alpaca-provider',
      function: 'place_order',
      args: { symbol: 'AAPL' },
    });
  });

  // ── Entry missing tool or args is dropped ───────────────────────────────────

  it('drops entries missing the tool field', () => {
    const text = '[{"args":{"symbol":"AAPL"}},{"tool":"alpaca-provider__place_order","args":{}}]';

    const result = parseToolCalls(text);

    expect(result).toHaveLength(1);
    expect(result[0].function).toBe('place_order');
  });

  it('drops entries missing the args field (when using tool-form)', () => {
    const text = '[{"tool":"alpaca-provider__place_order"},{"tool":"alpaca-provider__cancel_order","args":{}}]';

    const result = parseToolCalls(text);

    expect(result).toHaveLength(1);
    expect(result[0].function).toBe('cancel_order');
  });

  // ── Never throws ─────────────────────────────────────────────────────────────

  it('never throws on any input', () => {
    const inputs = ['', '   ', 'null', '{}', '[]', '```json\n```', undefined as unknown as string];
    for (const input of inputs) {
      expect(() => parseToolCalls(input)).not.toThrow();
    }
  });

  it('returns [] on empty input without calling auditFn', () => {
    const auditFn = jest.fn();
    expect(parseToolCalls('', auditFn)).toEqual([]);
    expect(auditFn).not.toHaveBeenCalled();
  });
});
