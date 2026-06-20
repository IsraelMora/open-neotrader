/**
 * Domain types for the multi-agent debate / consensus mechanism (F6 Slice 3).
 *
 * These are PURE interfaces — no runtime behaviour. Both DebateService and the
 * _executeToolCalls intercept reference these shapes; they must never import from
 * AgentsService to avoid circular dependencies.
 */

/** A debate role supplied by the active debate plugin's [debate] manifest section. */
export interface DebateRole {
  /** Role name, e.g. 'bull' | 'bear' | 'risk-auditor'. Plugin-defined. */
  name: string;
  /** Inline prompt. Takes priority over prompt_file when both are set. */
  prompt?: string;
  /** Filename (basename only, no path traversal) of a file containing the prompt. */
  prompt_file?: string;
  /**
   * When true this role acts as a hard-veto auditor: if the role returns
   * stance='reject' the consensus is immediately 'reject' regardless of other roles.
   */
  block?: boolean;
}

/** The parsed stance produced by a single debate role after calling llm.complete. */
export interface DebateStance {
  /** Role name that produced this stance. */
  role: string;
  /** The role's recommendation. */
  stance: 'approve' | 'reject' | 'abstain';
  /** Confidence score, clamped to [0, 1]. */
  confidence: number;
  /**
   * Sanitized rationale text (via sanitizeText), capped at 500 characters.
   * Empty string when the response was malformed or the role abstained due to error.
   */
  rationale: string;
  /**
   * Copied from the originating DebateRole. True for roles with hard-veto power
   * (e.g. risk-auditor). Used by synthesizeConsensus to apply auditor logic first.
   */
  block?: boolean;
}

/** The synthesized consensus after all role stances have been collected. */
export interface DebateConsensus {
  /** Overall recommendation for this tool_call. */
  recommendation: 'approve' | 'reject';
  /**
   * True when the consensus was decided by an auditor hard-veto (block===true &&
   * stance==='reject'), rather than by the weighted majority algorithm.
   */
  auditor_blocked: boolean;
  /** One DebateStance per role in the panel. */
  stances: DebateStance[];
}
