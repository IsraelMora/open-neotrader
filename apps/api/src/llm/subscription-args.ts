export interface SubscriptionArgsInput {
  /** Model id forwarded to the Claude Code CLI (e.g. claude-haiku-4-5-20251001). */
  model: string;
  /** The user-facing prompt (context) printed with -p. */
  prompt: string;
  /** System prompt + skills, appended via --append-system-prompt when non-empty. */
  system: string;
}

/**
 * Builds the argument vector for the `claude` CLI in headless (print) mode.
 *
 * Kept as a pure function so the routing/flag logic is unit-testable without
 * spawning the CLI. The model is always forwarded so the operator can pick a
 * cheaper model (e.g. Haiku) for cost control on the subscription backend.
 */
export function buildSubscriptionArgs(input: SubscriptionArgsInput): string[] {
  const args = ['--output-format', 'text', '--model', input.model];
  if (input.system.trim().length > 0) {
    args.push('--append-system-prompt', input.system);
  }
  args.push('-p', input.prompt);
  return args;
}
