import { buildSubscriptionArgs } from './subscription-args';

describe('buildSubscriptionArgs', () => {
  it('passes the selected model to the CLI via --model', () => {
    const args = buildSubscriptionArgs({
      model: 'claude-haiku-4-5-20251001',
      prompt: 'hola',
      system: '',
    });

    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('claude-haiku-4-5-20251001');
  });

  it('uses --append-system-prompt for the system content when present', () => {
    const args = buildSubscriptionArgs({ model: 'm', prompt: 'p', system: 'SYSTEM' });

    expect(args).toContain('--append-system-prompt');
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('SYSTEM');
  });

  it('omits --append-system-prompt when there is no system content', () => {
    const args = buildSubscriptionArgs({ model: 'm', prompt: 'p', system: '' });

    expect(args).not.toContain('--append-system-prompt');
  });

  it('requests text output and prints the user prompt', () => {
    const args = buildSubscriptionArgs({ model: 'm', prompt: 'hello world', system: '' });

    expect(args).toEqual(expect.arrayContaining(['--output-format', 'text', '-p', 'hello world']));
  });
});
