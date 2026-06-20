import { sanitizeText } from './sanitize.util';

describe('sanitizeText', () => {
  it('strips [DECISION] token', () => {
    expect(sanitizeText('hello [DECISION] world')).toBe('hello [stripped] world');
  });

  it('strips [DECISION] case-insensitively', () => {
    expect(sanitizeText('[decision] test')).toBe('[stripped] test');
  });

  it('strips [TOOL SCHEMA] token', () => {
    expect(sanitizeText('prefix [TOOL SCHEMA] suffix')).toBe('prefix [stripped] suffix');
  });

  it('strips [SEÑALES APROBADAS ...] token', () => {
    expect(sanitizeText('[SEÑALES APROBADAS BTC/USD] buy')).toBe('[stripped] buy');
  });

  it('strips [EPISODIOS RELEVANTES] token', () => {
    expect(sanitizeText('context [EPISODIOS RELEVANTES] more')).toBe('context [stripped] more');
  });

  it('strips [OBSERVACIONES ...] token', () => {
    expect(sanitizeText('[OBSERVACIONES detalle] end')).toBe('[stripped] end');
  });

  it('strips [LESSONS] token', () => {
    expect(sanitizeText('[LESSONS] learned')).toBe('[stripped] learned');
  });

  it('strips [PAST EPISODES] token', () => {
    expect(sanitizeText('[PAST EPISODES] here')).toBe('[stripped] here');
  });

  it('strips <tool_calls> block', () => {
    const input = 'before <tool_calls>[{"tool":"x"}]</tool_calls> after';
    expect(sanitizeText(input)).toBe('before [stripped] after');
  });

  it('strips ```json fenced block', () => {
    const input = 'text ```json\n{"key":"value"}\n``` end';
    expect(sanitizeText(input)).toBe('text [stripped] end');
  });

  it('strips bare ``` fenced block', () => {
    const input = 'text ```\nsome code\n``` end';
    expect(sanitizeText(input)).toBe('text [stripped] end');
  });

  it('returns plain text unchanged', () => {
    const plain = 'This is a normal rationale without any control tokens.';
    expect(sanitizeText(plain)).toBe(plain);
  });

  it('handles empty string', () => {
    expect(sanitizeText('')).toBe('');
  });

  it('strips multiple tokens in one pass', () => {
    const input = '[DECISION] and [LESSONS] here';
    expect(sanitizeText(input)).toBe('[stripped] and [stripped] here');
  });
});
