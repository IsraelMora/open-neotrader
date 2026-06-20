import { Injectable } from '@nestjs/common';
import { LlmService } from '../llm/llm.service';
import { sanitizeText } from './sanitize.util';
import type { DebateRole, DebateStance, DebateConsensus } from './debate.types';

/** Default panel timeout in milliseconds. Overridable via constructor param for tests. */
const DEFAULT_PANEL_TIMEOUT_MS = 20_000;

/**
 * Returns an abstain stance for the given role name.
 * Used when a per-call LLM error occurs — keeps the panel alive.
 */
function abstainFor(roleName: string): DebateStance {
  return { role: roleName, stance: 'abstain', confidence: 0, rationale: '' };
}

/**
 * DebateService — the pure mechanism layer for the multi-agent debate panel.
 *
 * Injects LlmService ONLY. Does NOT inject AgentsService or AuditService.
 * Audit event emission is the caller's responsibility (_executeToolCalls intercept).
 *
 * All public methods are safe (never throw per their contracts).
 */
@Injectable()
export class DebateService {
  /** Panel timeout in ms. Set only by tests via the static factory below; production uses default. */
  private readonly panelTimeoutMs: number = DEFAULT_PANEL_TIMEOUT_MS;

  constructor(private readonly llm: LlmService) {}

  /**
   * Returns a DebateService instance with a custom panel timeout.
   * Only used in tests — production always uses the DEFAULT_PANEL_TIMEOUT_MS.
   * This avoids emitting a `Number` constructor parameter in reflect-metadata, which
   * would confuse NestJS DI and cause a resolution error in the real module boot test.
   */
  static withTimeout(llm: LlmService, timeoutMs: number): DebateService {
    const svc = new DebateService(llm);
    (svc as unknown as { panelTimeoutMs: number }).panelTimeoutMs = timeoutMs;
    return svc;
  }

  // ── parseStance ──────────────────────────────────────────────────────────────

  /**
   * Parse a single role's LLM response text into a DebateStance.
   *
   * Extraction strategy mirrors kernel-parser: try fenced ```json first,
   * then bare first-{...} object. JSON.parse in try/catch.
   *
   * Contract: NEVER throws. Malformed/unparseable → abstain with confidence=0.
   */
  parseStance(text: string, roleName: string): DebateStance {
    try {
      if (typeof text !== 'string') {
        return abstainFor(roleName);
      }

      // Strategy 1: fenced ```json block (non-backtracking: find markers, slice between them)
      const rawJson = this._extractFencedJson(text) ?? this._extractBareObject(text);

      if (!rawJson) return abstainFor(roleName);

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawJson);
      } catch {
        return abstainFor(roleName);
      }

      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return abstainFor(roleName);
      }

      const obj = parsed as Record<string, unknown>;

      // Coerce stance to the enum; unknown → abstain
      const rawStance = typeof obj['stance'] === 'string' ? obj['stance'] : '';
      const stance = this._coerceStance(rawStance);

      // Clamp confidence [0, 1]
      const rawConf = typeof obj['confidence'] === 'number' ? obj['confidence'] : 0;
      const confidence = Math.max(0, Math.min(1, rawConf));

      // Sanitize and cap rationale
      const rawRationale = typeof obj['rationale'] === 'string' ? obj['rationale'] : '';
      const rationale = sanitizeText(rawRationale).slice(0, 500);

      return { role: roleName, stance, confidence, rationale };
    } catch {
      // Safety net — parseStance must NEVER throw
      return abstainFor(roleName);
    }
  }

  // ── synthesizeConsensus ───────────────────────────────────────────────────────

  /**
   * Synthesize a DebateConsensus from the collected stances.
   *
   * Algorithm:
   *  1. Auditor veto: any stance with block===true AND stance==='reject'
   *     → recommendation='reject', auditor_blocked=true (short-circuit, no majority calc).
   *  2. Else: score = Σ(confidence × value) where approve=+1, reject=-1, abstain=0.
   *     score > 0 → 'approve'; else → 'reject' (conservative; 0 → reject).
   *     auditor_blocked = false.
   */
  synthesizeConsensus(stances: DebateStance[]): DebateConsensus {
    // Step 1: auditor veto
    for (const s of stances) {
      if (s.block === true && s.stance === 'reject') {
        return { recommendation: 'reject', auditor_blocked: true, stances };
      }
    }

    // Step 2: confidence-weighted majority
    let score = 0;
    for (const s of stances) {
      let value = 0;
      if (s.stance === 'approve') value = 1;
      else if (s.stance === 'reject') value = -1;
      score += s.confidence * value;
    }

    const recommendation = score > 0 ? 'approve' : 'reject';
    return { recommendation, auditor_blocked: false, stances };
  }

  // ── runPanel ──────────────────────────────────────────────────────────────────

  /**
   * Run all roles in parallel (Promise.all), parse each response, synthesize consensus.
   *
   * Per-call failures → abstain stance for that role (panel continues).
   * Whole-panel timeout → AbortController aborts and the panel Promise rejects.
   * The CALLER is responsible for catching that rejection and applying fail_mode.
   */
  async runPanel(summary: string, roles: DebateRole[], _cycleId: string): Promise<DebateConsensus> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.panelTimeoutMs);

    try {
      const stances = await Promise.all(
        roles.map((role) => {
          const prompt = role.prompt ?? '';
          return this.llm
            .complete({ context: summary, system_prompt: prompt })
            .then((res) => {
              const stance = this.parseStance(res.text, role.name);
              // Copy block flag from role onto stance so synthesizeConsensus can use it
              return { ...stance, block: role.block };
            })
            .catch(() => {
              // Per-call failure → abstain; panel remains alive
              return { ...abstainFor(role.name), block: role.block };
            });
        }),
      );

      return this.synthesizeConsensus(stances);
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

  /**
   * Extracts raw JSON content from a fenced ```json block (non-backtracking).
   * Returns null if none found.
   */
  private _extractFencedJson(text: string): string | null {
    const open = text.indexOf('```json');
    if (open === -1) return null;
    const contentStart = text.indexOf('\n', open);
    if (contentStart === -1) return null;
    const close = text.indexOf('\n```', contentStart);
    if (close === -1) return null;
    return text.slice(contentStart + 1, close).trim();
  }

  /**
   * Extracts the first bare {...} JSON object from text by tracking brace depth.
   * Returns null if none found.
   */
  private _extractBareObject(text: string): string | null {
    const start = text.indexOf('{');
    if (start === -1) return null;

    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') {
        depth--;
        if (depth === 0) {
          return text.slice(start, i + 1);
        }
      }
    }
    return null;
  }

  /** Coerces a raw string to the DebateStance stance enum. Unknown values → 'abstain'. */
  private _coerceStance(raw: string): 'approve' | 'reject' | 'abstain' {
    if (raw === 'approve' || raw === 'reject' || raw === 'abstain') return raw;
    return 'abstain';
  }
}
