/** F6-s2: MemoryProvider seam + associated types for long-term episodic memory. */

export interface EpisodeRecord {
  id: string;
  ts: Date;
  cycle_id: string;
  symbols: string;
  regime_tags: string;
  action_summary: string;
  llm_rationale: string;
  narrative: string;
  outcome_pnl: number | null;
  outcome_equity: number | null;
  promoted: boolean;
  meta: string | null;
}

export interface EpisodeInput {
  cycle_id: string;
  symbols: string[];
  regime_tags: string[];
  action_summary: string;
  llm_rationale: string;
  narrative: string;
  meta?: string | null;
}

export interface LessonRecord {
  text: string;
  episode_id?: string;
  rationale?: string;
}

export interface MemoryProvider {
  prefetch(query: string, limit?: number): Promise<EpisodeRecord[]>;
  record(ep: EpisodeInput): Promise<void>;
  updateOutcome(cycleId: string, pnl: number, equity: number): Promise<void>;
  promote(lesson: LessonRecord): Promise<void>;
}
