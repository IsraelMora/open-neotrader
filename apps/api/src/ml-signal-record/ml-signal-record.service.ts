/**
 * MlSignalRecordService — ml-feature-extractor-s1: per-skill signal-to-outcome capture.
 *
 * Design decisions:
 * - Leaf service: depends only on PrismaService (no circular dep risk).
 * - ALL public methods are fail-soft: try/catch -> log.warn, never throw into cycle/snapshot.
 * - Mirrors the LongTermMemoryService fail-soft + $transaction pattern (F6-s2).
 * - getTrainingData is dormant in s1 (defined for s2 contract; no caller in the decision path).
 * - INERT: this service only writes; no read path feeds _executeCycle or any decision step.
 */
import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

export interface SkillContribution {
  plugin_id: string;
  action: string;
  confidence: number;
}

export interface MlSignalRow {
  id: string;
  ts: Date;
  cycle_id: string;
  symbol: string;
  skill_vector: string;
  action: string;
  outcome_pnl: number | null;
  outcome_equity: number | null;
  active_skill_hash: string;
  meta: string | null;
}

@Injectable()
export class MlSignalRecordService {
  readonly log = new Logger(MlSignalRecordService.name);

  constructor(private readonly db: PrismaService) {}

  /**
   * Stable, order-independent hash of active skill plugin ids.
   * Pure function — no try/catch needed (createHash never throws on valid input).
   * Returns 16 hex chars (first 16 chars of SHA-256 hex digest).
   */
  computeActiveSkillHash(ids: string[]): string {
    const sorted = [...ids].sort().join(',');
    return createHash('sha256').update(sorted).digest('hex').slice(0, 16);
  }

  /**
   * Batch-insert one row per record (one per symbol) in a single $transaction.
   * outcome_pnl / outcome_equity are NOT written (remain NULL — no lookahead).
   * Fail-soft: catch -> log.warn, never throw.
   */
  async recordSignals(
    cycleId: string,
    records: { symbol: string; skill_vector: SkillContribution[]; action: string }[],
    activeSkillHash: string,
  ): Promise<void> {
    if (records.length === 0) return;
    try {
      await this.db.$transaction(async (tx) => {
        for (const r of records) {
          const id = randomUUID();
          const skillVectorJson = JSON.stringify(r.skill_vector);
          await tx.$executeRaw`
            INSERT INTO ml_signal_record
              (id, cycle_id, symbol, skill_vector, action, outcome_pnl, outcome_equity, active_skill_hash, meta)
            VALUES
              (${id}, ${cycleId}, ${r.symbol}, ${skillVectorJson}, ${r.action}, ${null}, ${null}, ${activeSkillHash}, ${null})
          `;
        }
      });
    } catch (e) {
      this.log.warn(`[ML] recordSignals failed for cycle ${cycleId} — signals not persisted: ${e}`);
    }
  }

  /**
   * Backfill outcome_pnl and outcome_equity for all rows matching cycle_id (aggregate form).
   * Called from SnapshotService.takeSnapshot with the realized portfolio values.
   * No lookahead: these values come from a LATER snapshot than the decision cycle.
   * Fail-soft: catch -> log.warn, never throw.
   */
  async updateOutcomeAggregate(cycleId: string, pnl: number, equity: number): Promise<void> {
    try {
      await this.db.$executeRaw`
        UPDATE ml_signal_record
        SET outcome_pnl = ${pnl}, outcome_equity = ${equity}
        WHERE cycle_id = ${cycleId}
      `;
    } catch (e) {
      this.log.warn(
        `[ML] updateOutcomeAggregate failed for cycle ${cycleId} — ml outcome not backfilled: ${e}`,
      );
    }
  }

  /**
   * Returns only labeled rows (outcome_pnl IS NOT NULL), ordered by ts DESC.
   * FOR s2 TRAINING ONLY — this method has NO caller in the s1 decision path.
   * Returns [] on any error (fail-soft).
   */
  async getTrainingData(limit: number): Promise<MlSignalRow[]> {
    try {
      return await this.db.$queryRaw<MlSignalRow[]>`
        SELECT *
        FROM ml_signal_record
        WHERE outcome_pnl IS NOT NULL
        ORDER BY ts DESC
        LIMIT ${limit}
      `;
    } catch (e) {
      this.log.warn(`[ML] getTrainingData failed: ${e}`);
      return [];
    }
  }
}
