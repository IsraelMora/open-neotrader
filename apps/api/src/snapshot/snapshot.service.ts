import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderGatewayService, Portfolio } from '../providers/provider-gateway.service';
import { LongTermMemoryService } from '../long-term-memory/long-term-memory.service';
import { MlSignalRecordService } from '../ml-signal-record/ml-signal-record.service';
import { KvService } from '../common/kv.service';

export interface NavEntry {
  id: string;
  ts: Date;
  cycle_id: string | null;
  provider_id: string | null;
  equity: number;
  cash: number;
  positions: unknown[];
  total_pnl: number;
}

/** Persiste y consulta snapshots de NAV (equity, cash, posiciones) para la curva de equity y el dashboard. */
@Injectable()
export class SnapshotService {
  private readonly log = new Logger(SnapshotService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly gateway: ProviderGatewayService,
    // LongTermMemoryService injected @Optional() — snapshots run normally when absent.
    // F6-s2 PR2: backfills episode outcome_pnl/equity via updateOutcome.
    @Optional()
    private readonly longTermMemory?: LongTermMemoryService,
    // MlSignalRecordService injected @Optional() — s1 outcome backfill (INERT in s1).
    // Absent → updateOutcomeAggregate call is skipped; snapshot is byte-identical to pre-s1.
    @Optional()
    private readonly mlSignalRecord?: MlSignalRecordService,
    // KvService @Optional() — para etiquetar el snapshot con la estrategia aplicada
    // (KV 'strategy.applied'). Ausente → strategy_id queda null (comportamiento previo).
    @Optional()
    private readonly kv?: KvService,
  ) {}

  /** Toma un snapshot del NAV actual desde el provider por defecto. */
  async takeSnapshot(cycleId?: string): Promise<NavEntry | null> {
    let portfolio: Portfolio;
    try {
      portfolio = await this.gateway.getPortfolio(null);
    } catch (err) {
      this.log.warn(`No se pudo obtener portfolio para snapshot: ${err}`);
      return null;
    }

    // Estrategia cuya config está aplicada al ciclo (para atribuir el NAV).
    let strategyId: string | null = null;
    if (this.kv) {
      try {
        strategyId = await this.kv.get('strategy.applied');
      } catch {
        strategyId = null;
      }
    }

    const entry = await this.db.navSnapshot.create({
      data: {
        cycle_id: cycleId ?? null,
        provider_id: portfolio.provider_id,
        strategy_id: strategyId,
        equity: portfolio.equity,
        cash: portfolio.cash,
        positions: JSON.stringify(portfolio.positions),
        total_pnl: portfolio.total_pnl,
      },
    });

    // ── F6-s2 PR2: backfill episode outcome after snapshot ───────────────────
    // Calls updateOutcome only when a cycleId is known and LTM is available.
    // Failure NEVER breaks the snapshot.
    if (cycleId && this.longTermMemory) {
      try {
        await this.longTermMemory.updateOutcome(cycleId, portfolio.total_pnl, portfolio.equity);
      } catch (e) {
        this.log.warn(
          `[LTM] updateOutcome failed for cycle ${cycleId} — episode outcome not backfilled: ${e}`,
        );
      }
    }

    // ── ml-feature-extractor-s1: backfill ML signal outcome (INERT) ──────────
    // Same timing as LTM updateOutcome: the snapshot reflects POSTERIOR realized values.
    // NO lookahead: outcome_pnl comes from this snapshot, not from the decision cycle.
    // Failure NEVER breaks the snapshot.
    if (cycleId && this.mlSignalRecord) {
      try {
        await this.mlSignalRecord.updateOutcomeAggregate(
          cycleId,
          portfolio.total_pnl,
          portfolio.equity,
        );
      } catch (e) {
        this.log.warn(
          `[ML] updateOutcomeAggregate failed for cycle ${cycleId} — ml outcome not backfilled: ${e}`,
        );
      }
    }

    return this._hydrate(entry);
  }

  /** Últimos N snapshots en orden cronológico. */
  async getHistory(limit = 90): Promise<NavEntry[]> {
    const rows = await this.db.navSnapshot.findMany({
      orderBy: { ts: 'asc' },
      take: limit,
    });
    return rows.map((r) => this._hydrate(r));
  }

  /** Snapshot más reciente. */
  async getLatest(): Promise<NavEntry | null> {
    const row = await this.db.navSnapshot.findFirst({ orderBy: { ts: 'desc' } });
    return row ? this._hydrate(row) : null;
  }

  /**
   * Equity curve como lista de [ts, equity] para el frontend.
   * Útil para gráficos y para el weekly-reporter.
   */
  async getEquityCurve(limit = 252): Promise<{ ts: string; equity: number }[]> {
    const rows = await this.db.navSnapshot.findMany({
      orderBy: { ts: 'asc' },
      take: limit,
      select: { ts: true, equity: true },
    });
    return rows.map((r) => ({ ts: r.ts.toISOString(), equity: r.equity }));
  }

  /**
   * Real-money equity curve as [{ ts, equity, hwm }] for the dashboard/reporter.
   *
   * Intentionally queries `orderBy: { ts: 'desc' }, take: limit` (most recent N rows)
   * and then reverses in memory before mapping, so the result is chronologically
   * ascending AND correctly bounded to the most recent N points. This is the correct
   * pattern for a "last N, in order" query — contrast with the pre-existing
   * `getHistory`/`getEquityCurve` (paper) methods, which use `orderBy: { ts: 'asc' },
   * take: limit` and therefore return the OLDEST N rows, not the most recent N. That
   * bug is left untouched (paper behavior must stay byte-for-byte identical); it must
   * NOT be copied here.
   */
  async getRealEquityCurve(limit = 252): Promise<{ ts: string; equity: number; hwm: number }[]> {
    const rows = await this.db.realNavSnapshot.findMany({
      orderBy: { ts: 'desc' },
      take: limit,
      select: { ts: true, equity: true, hwm: true },
    });
    return rows
      .slice()
      .reverse()
      .map((r) => ({ ts: r.ts.toISOString(), equity: r.equity, hwm: r.hwm }));
  }

  /** Estadísticas rápidas del NAV histórico. */
  async stats(): Promise<Record<string, unknown>> {
    const total = await this.db.navSnapshot.count();
    const first = await this.db.navSnapshot.findFirst({ orderBy: { ts: 'asc' } });
    const last = await this.db.navSnapshot.findFirst({ orderBy: { ts: 'desc' } });

    const pnl =
      last && first && first.equity > 0 ? (last.equity - first.equity) / first.equity : null;

    return {
      total_snapshots: total,
      first_ts: first?.ts,
      last_ts: last?.ts,
      equity_start: first?.equity,
      equity_current: last?.equity,
      total_return_pct: pnl != null ? Math.round(pnl * 10000) / 100 : null,
    };
  }

  private _hydrate(row: {
    id: string;
    ts: Date;
    cycle_id: string | null;
    provider_id: string | null;
    equity: number;
    cash: number;
    positions: string;
    total_pnl: number;
    meta: string | null;
  }): NavEntry {
    return {
      id: row.id,
      ts: row.ts,
      cycle_id: row.cycle_id,
      provider_id: row.provider_id,
      equity: row.equity,
      cash: row.cash,
      positions: row.positions ? (JSON.parse(row.positions) as unknown[]) : [],
      total_pnl: row.total_pnl,
    };
  }
}
