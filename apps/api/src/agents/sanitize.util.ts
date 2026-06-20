/**
 * Shared text sanitizer — strips LLM control-structure tokens from free text
 * (rationale, episode, lesson fields) before they are stored, audited, or
 * injected back into a future LLM context window.
 *
 * This is the extracted implementation of the former private
 * `AgentsService._sanitizeEpisodeText`. The logic is VERBATIM — do not change
 * the regex set without updating all call sites and their tests.
 */

const CONTROL_TOKENS: RegExp[] = [
  /\[DECISION\]/gi,
  /\[TOOL SCHEMA\]/gi,
  /\[SEÑALES APROBADAS[^\]]*\]/gi,
  /\[EPISODIOS RELEVANTES\]/gi,
  /\[OBSERVACIONES[^\]]*\]/gi,
  /\[LESSONS\]/gi,
  /\[PAST EPISODES\]/gi,
  /<tool_calls>[\s\S]*?<\/tool_calls>/gi,
  /```json[\s\S]*?```/gi,
  /```[\s\S]*?```/gi,
];

/**
 * Strips LLM prompt-injection tokens from `s` and returns the sanitized string.
 * Never throws. Returns an empty string when `s` is empty.
 */
export function sanitizeText(s: string): string {
  let result = s;
  for (const re of CONTROL_TOKENS) {
    result = result.replace(re, '[stripped]');
  }
  return result;
}
