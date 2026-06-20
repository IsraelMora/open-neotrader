/**
 * LongTermMemoryService — F6-s2: durable, FTS5-indexed episodic memory.
 *
 * Design decisions:
 * - Standalone FTS5 (NOT external-content): episode_fts is synced via explicit dual-write inside
 *   a $transaction in record(), avoiding rowid race and trigger opacity.
 * - ALL methods are fail-soft: try/catch → log.warn, never throw into the cycle.
 * - Boot-check (onModuleInit): creates a throwaway _fts5_probe table to confirm FTS5 is compiled.
 *   On failure: fts5Available=false, warns, does NOT crash boot.
 * - prefetch returns [] when fts5Available=false or when the sanitized query is empty.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import type {
  EpisodeInput,
  EpisodeRecord,
  LessonRecord,
  MemoryProvider,
} from './memory-provider.interface';

@Injectable()
export class LongTermMemoryService implements MemoryProvider, OnModuleInit {
  readonly log = new Logger(LongTermMemoryService.name);
  private fts5Available = false;

  constructor(private readonly db: PrismaService) {}

  // ── Boot-check ─────────────────────────────────────────────────────────────

  async onModuleInit(): Promise<void> {
    try {
      await this.db.$executeRaw`CREATE VIRTUAL TABLE IF NOT EXISTS _fts5_probe USING fts5(x)`;
      await this.db.$executeRaw`INSERT INTO _fts5_probe(x) VALUES ('ping')`;
      await this.db.$queryRaw`SELECT 1 FROM _fts5_probe WHERE _fts5_probe MATCH 'ping'`;
      await this.db.$executeRaw`DROP TABLE IF EXISTS _fts5_probe`;
      this.fts5Available = true;
    } catch (e) {
      this.log.warn(`FTS5 unavailable — long-term memory degraded: ${e}`);
      this.fts5Available = false;
    }
  }

  // ── Query sanitization ─────────────────────────────────────────────────────

  /**
   * Strip FTS5 operators from a query string.
   * Splits on whitespace, replaces non-alphanumeric chars with spaces, further splits,
   * drops empties, and wraps each surviving token in double quotes.
   * Result: space-joined quoted tokens (implicit AND in FTS5), or '' if no tokens remain.
   */
  /** Exposed as protected to allow unit testing via subclass or direct cast. */
  protected sanitizeMatch(q: string): string {
    return q
      .split(/\s+/)
      .map((t) => t.replace(/[^A-Za-z0-9]/g, ' ').trim())
      .flatMap((t) => t.split(/\s+/))
      .filter(Boolean)
      .map((t) => `"${t}"`)
      .join(' ');
  }

  // ── record ─────────────────────────────────────────────────────────────────

  /**
   * Insert an episode into episode_memory AND episode_fts (same rowid) in one $transaction.
   * Dual-write avoids the rowid race: the FTS insert uses a subselect on the just-inserted id.
   */
  async record(ep: EpisodeInput): Promise<void> {
    try {
      const id = randomUUID();
      const symbols = JSON.stringify(ep.symbols);
      const regime_tags = JSON.stringify(ep.regime_tags);

      await this.db.$transaction(async (tx) => {
        await tx.$executeRaw`
          INSERT INTO episode_memory
            (id, cycle_id, symbols, regime_tags, action_summary, llm_rationale, narrative,
             outcome_pnl, outcome_equity, promoted, meta)
          VALUES
            (${id}, ${ep.cycle_id}, ${symbols}, ${regime_tags},
             ${ep.action_summary}, ${ep.llm_rationale}, ${ep.narrative},
             NULL, NULL, 0, ${ep.meta ?? null})
        `;
        await tx.$executeRaw`
          INSERT INTO episode_fts (rowid, narrative)
          SELECT rowid, narrative FROM episode_memory WHERE id = ${id}
        `;
      });
    } catch (e) {
      this.log.warn(`record failed: ${e}`);
    }
  }

  // ── prefetch ───────────────────────────────────────────────────────────────

  /**
   * FTS5 MATCH search, ordered by BM25 rank (most relevant first), limited to `limit` rows.
   * Returns [] when fts5Available=false or sanitized query is empty.
   */
  async prefetch(query: string, limit = 5): Promise<EpisodeRecord[]> {
    if (!this.fts5Available) return [];
    try {
      const m = this.sanitizeMatch(query);
      if (!m) return [];
      const rows = await this.db.$queryRaw<EpisodeRecord[]>`
        SELECT e.*
        FROM episode_fts f
        JOIN episode_memory e ON e.rowid = f.rowid
        WHERE episode_fts MATCH ${m}
        ORDER BY rank
        LIMIT ${limit}
      `;
      return rows;
    } catch (e) {
      this.log.warn(`prefetch failed: ${e}`);
      return [];
    }
  }

  // ── updateOutcome ──────────────────────────────────────────────────────────

  /** Backfill outcome_pnl and outcome_equity for an episode by cycle_id. No-op if not found. */
  async updateOutcome(cycleId: string, pnl: number, equity: number): Promise<void> {
    try {
      await this.db.$executeRaw`
        UPDATE episode_memory
        SET outcome_pnl = ${pnl}, outcome_equity = ${equity}
        WHERE cycle_id = ${cycleId}
      `;
    } catch (e) {
      this.log.warn(`updateOutcome failed: ${e}`);
    }
  }

  // ── promote (PR3 stub) ─────────────────────────────────────────────────────

  /** No-op stub. Implemented in PR3 (curated lessons). */
  async promote(_lesson: LessonRecord): Promise<void> {
    // PR3 stub — no-op
  }
}
