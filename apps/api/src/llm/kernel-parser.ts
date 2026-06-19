import type { ToolCallRequest } from './llm.service';

// ── Extraction strategies ─────────────────────────────────────────────────────

/** Extracts raw JSON text from a fenced ```json block, if present. */
function extractFenced(text: string): { raw: string } | null {
  // Non-backtracking extraction: find markers, then slice between them.
  const open = text.indexOf('```json');
  if (open === -1) return null;
  const contentStart = text.indexOf('\n', open);
  if (contentStart === -1) return null;
  const close = text.indexOf('\n```', contentStart);
  if (close === -1) return null;
  return { raw: text.slice(contentStart + 1, close).trim() };
}

/** Extracts raw JSON text from a <tool_calls>...</tool_calls> block, if present. */
function extractTagged(text: string): { raw: string } | null {
  const match = /<tool_calls>([\s\S]*?)<\/tool_calls>/.exec(text);
  return match ? { raw: match[1].trim() } : null;
}

/** Extracts raw JSON text from a bare top-level [...] array, if present. */
function extractBare(text: string): { raw: string } | null {
  // Find the first '[' and match the closing ']' by tracking bracket depth.
  const start = text.indexOf('[');
  if (start === -1) return null;

  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '[') depth++;
    else if (text[i] === ']') {
      depth--;
      if (depth === 0) {
        return { raw: text.slice(start, i + 1) };
      }
    }
  }
  return null;
}

// ── Entry normalizer ──────────────────────────────────────────────────────────

type RawEntry = Record<string, unknown>;

/**
 * Normalizes a parsed JSON entry into a ToolCallRequest.
 * Accepts:
 *   - { tool: "pluginId__fn", args: {...} }  — flat tool-reference form
 *   - { plugin_id: "...", function: "...", args: {...} } — object form
 * Returns null for entries that cannot be normalized.
 */
function normalizeEntry(entry: RawEntry): ToolCallRequest | null {
  if (!entry || typeof entry !== 'object') return null;

  // Object-form: { plugin_id, function, args }
  if (typeof entry['plugin_id'] === 'string' && typeof entry['function'] === 'string') {
    const args = (entry['args'] ?? {}) as Record<string, unknown>;
    return { plugin_id: entry['plugin_id'], function: entry['function'], args };
  }

  // Tool-form: { tool: "pluginId__fn", args: {...} }
  if (typeof entry['tool'] === 'string') {
    if (typeof entry['args'] !== 'object' || entry['args'] === null) return null;
    const tool = entry['tool'];
    const idx = tool.indexOf('__');
    if (idx === -1) return null; // no __ separator — malformed

    const plugin_id = tool.slice(0, idx);
    const fn = tool.slice(idx + 2);
    if (!plugin_id || !fn) return null;

    return {
      plugin_id,
      function: fn,
      args: entry['args'] as Record<string, unknown>,
    };
  }

  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Parses tool-call JSON from an LLM response text into ToolCallRequest[].
 *
 * Tries three extraction strategies in order:
 *   1. Fenced ```json block
 *   2. <tool_calls>...</tool_calls> tag block
 *   3. Bare top-level JSON array
 *
 * Returns [] if no block is found or if parsing fails.
 * Calls auditFn(rawBlock) only when a block is detected but JSON is malformed.
 * Never throws.
 */
export function parseToolCalls(text: string, auditFn?: (raw: string) => void): ToolCallRequest[] {
  if (!text) return [];

  // Try each extraction strategy in priority order.
  const detected = extractFenced(text) ?? extractTagged(text) ?? extractBare(text);

  if (!detected) return [];

  // We have a detected block — attempt JSON parsing.
  let parsed: unknown;
  try {
    parsed = JSON.parse(detected.raw);
  } catch {
    // Block was detected but JSON is invalid → audit and return [].
    auditFn?.(detected.raw);
    return [];
  }

  if (!Array.isArray(parsed)) {
    // Detected block parsed but is not an array → treat as malformed.
    auditFn?.(detected.raw);
    return [];
  }

  const results: ToolCallRequest[] = [];
  for (const entry of parsed as RawEntry[]) {
    const normalized = normalizeEntry(entry);
    if (normalized) results.push(normalized);
  }

  return results;
}
