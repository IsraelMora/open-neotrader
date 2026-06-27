import { parseToolCalls, stripToolCallBlocks } from './kernel-parser';

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
    const text = '<tool_calls>[{"tool":"position-sizing__size","args":{}}]</tool_calls>';

    const result = parseToolCalls(text);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      plugin_id: 'position-sizing',
      function: 'size',
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
    const call = {
      plugin_id: 'alpaca-provider',
      function: 'place_order',
      args: { symbol: 'AAPL' },
    };
    const fenced =
      '```json\n[{"tool":"alpaca-provider__place_order","args":{"symbol":"AAPL"}}]\n```';
    const tagged =
      '<tool_calls>[{"tool":"alpaca-provider__place_order","args":{"symbol":"AAPL"}}]</tool_calls>';
    const bare = '[{"tool":"alpaca-provider__place_order","args":{"symbol":"AAPL"}}]';

    expect(parseToolCalls(fenced)).toEqual([call]);
    expect(parseToolCalls(tagged)).toEqual([call]);
    expect(parseToolCalls(bare)).toEqual([call]);
  });

  // ── Prose-wrapped bare array ─────────────────────────────────────────────────

  it('parses a bare array wrapped in surrounding prose', () => {
    const text =
      'Some analysis here. [{"tool":"alpaca-provider__place_order","args":{}}] And more text.';

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
    const text =
      '[{"tool":"alpaca-provider__place_order"},{"tool":"alpaca-provider__cancel_order","args":{}}]';

    const result = parseToolCalls(text);

    expect(result).toHaveLength(1);
    expect(result[0].function).toBe('cancel_order');
  });

  // ── kernel__ namespace split ─────────────────────────────────────────────────

  it('parses kernel__write_skill → {plugin_id:"kernel", function:"write_skill"}', () => {
    // Codifies the design assumption: the first-__ split correctly assigns plugin_id='kernel'
    // and function='write_skill'. This test is the guarantee the kernel namespace relies on.
    const text = '[{"tool":"kernel__write_skill","args":{"skill":"s","new_body":"b"}}]';

    const result = parseToolCalls(text);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      plugin_id: 'kernel',
      function: 'write_skill',
      args: { skill: 's', new_body: 'b' },
    });
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

describe('stripToolCallBlocks', () => {
  // 1. Prose + block → prose only (trimmed)
  it('removes a <tool_calls> block and preserves surrounding prose', () => {
    const input = 'Listo.\n<tool_calls>[{"tool":"x__y","args":{}}]</tool_calls>';
    expect(stripToolCallBlocks(input)).toBe('Listo.');
  });

  // 2. Block-only → empty string ("hola" bug case)
  it('returns "" when the input is only a <tool_calls>[]</tool_calls> block', () => {
    expect(stripToolCallBlocks('<tool_calls>[]</tool_calls>')).toBe('');
  });

  // 3. Case-insensitive
  it('removes <TOOL_CALLS>...</TOOL_CALLS> (uppercase tags)', () => {
    const input = 'Ok.\n<TOOL_CALLS>[{"tool":"a__b","args":{}}]</TOOL_CALLS>';
    expect(stripToolCallBlocks(input)).toBe('Ok.');
  });

  // 4. Multiple blocks removed (each removal leaves \n on each side → \n\n paragraph break;
  //    rule 9 only collapses 3+ newlines to 2, so double newlines remain)
  it('removes multiple <tool_calls> blocks in one pass', () => {
    const input =
      'First.\n<tool_calls>[{"tool":"a__b","args":{}}]</tool_calls>\nMiddle.\n<tool_calls>[]</tool_calls>\nEnd.';
    expect(stripToolCallBlocks(input)).toBe('First.\n\nMiddle.\n\nEnd.');
  });

  // 5. Multiline JSON inside block
  it('removes blocks with multiline JSON content', () => {
    const block = `<tool_calls>[\n  {\n    "tool": "a__b",\n    "args": {}\n  }\n]</tool_calls>`;
    const input = `Thinking...\n${block}`;
    expect(stripToolCallBlocks(input)).toBe('Thinking...');
  });

  // 6. Plain prose unchanged
  it('returns plain prose unchanged (modulo trim)', () => {
    const input = 'Just a regular answer with no tool calls.';
    expect(stripToolCallBlocks(input)).toBe(input);
  });

  // 7. Does NOT strip ```json code fences (data-loss guard)
  it('does NOT strip a legitimate ```json code fence', () => {
    const input = 'Here is an example:\n```json\n[{"key": "value"}]\n```\nThat\'s how it works.';
    expect(stripToolCallBlocks(input)).toBe(input);
  });

  // 8a. Empty string → ""
  it('returns "" on empty string input', () => {
    expect(stripToolCallBlocks('')).toBe('');
  });

  // 8b. Null/undefined defensively handled
  it('handles null input without throwing', () => {
    expect(() => stripToolCallBlocks(null as unknown as string)).not.toThrow();
    expect(stripToolCallBlocks(null as unknown as string)).toBe('');
  });

  it('handles undefined input without throwing', () => {
    expect(() => stripToolCallBlocks(undefined as unknown as string)).not.toThrow();
    expect(stripToolCallBlocks(undefined as unknown as string)).toBe('');
  });

  // 9. Collapses excess blank lines and trims
  it('collapses 3+ consecutive newlines to 2 and trims the result', () => {
    const input = 'Line A.\n\n\n\n<tool_calls>[]</tool_calls>\n\n\nLine B.';
    expect(stripToolCallBlocks(input)).toBe('Line A.\n\nLine B.');
  });
});
