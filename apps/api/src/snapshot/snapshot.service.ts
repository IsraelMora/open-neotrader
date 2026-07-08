import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderGatewayService } from '../providers/provider-gateway.service';
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

  /**
   * Toma un snapshot del NAV actual desde la wallet paper del KERNEL (no del provider
   * por defecto — ver nota kernel-nav-source).
   *
   * kernel-nav-source: `getPortfolio(null)` lee la cuenta del PROVIDER POR DEFECTO
   * (Alpaca paper broker, saldo demo ~$100k), lo que conflaba el NAV paper del kernel
   * con lo que sea que devuelva el provider activo. La wallet paper real del kernel es
   * la fila Prisma `Portfolio` (`@@map("portfolio")`) identificada por `name: 'paper'`;
   * su columna JSON `data` ya trae el PaperState persistido por el fill path de
   * ejecución paper (equity/cash/positions/hwm). Se lee esa fila TAL CUAL — sin
   * mark-to-market ni fetch de cotizaciones — y ya no se llama al gateway.
   *
   * `provider_id` se etiqueta como `'kernel-paper'` para distinguir honestamente esta
   * fuente de un provider externo real (p.ej. 'alpaca'); no hay restricción de schema
   * sobre los valores de esta columna (String? libre).
   *
   * total-pnl-honesty: `total_pnl = equity - initial_equity`, donde `initial_equity` es
   * el campo opcional homónimo del PaperState (sembrado por un futuro flujo de
   * reset/init — este método NUNCA lo escribe, solo lo lee). Si `initial_equity` no
   * está seteado (wallet nunca reseteada), el baseline cae a `equity` y el P&L es 0 de
   * forma honesta — nunca se fabrica un número. Antes esto quedaba hardcodeado en 0
   * SIEMPRE, lo que envenenaba silenciosamente dashboard/episode_memory/ml_signal_record
   * con una etiqueta de P&L falsa de "breakeven" (BLOCKER).
   *
   * Guard de estado corrupto: si tras el parse `equity` o `cash` no son números finitos
   * (JSON válido pero datos basura), se trata como fallo — se loguea warn y se retorna
   * null SIN llamar a navSnapshot.create, para no persistir una fila parcial/NaN.
   */
  async takeSnapshot(cycleId?: string): Promise<NavEntry | null> {
    let paperRow: { data: string } | null;
    try {
      paperRow = await this.db.portfolio.findUnique({ where: { name: 'paper' } });
    } catch (err) {
      this.log.warn(`No se pudo leer la wallet paper del kernel para snapshot: ${err}`);
      return null;
    }

    if (!paperRow) {
      this.log.warn("No existe fila de portfolio 'paper' del kernel todavía — snapshot omitido");
      return null;
    }

    let paperState: {
      equity: number;
      cash: number;
      positions?: unknown[];
      initial_equity?: number;
    };
    try {
      paperState = JSON.parse(paperRow.data) as {
        equity: number;
        cash: number;
        positions?: unknown[];
        initial_equity?: number;
      };
    } catch (err) {
      this.log.warn(`No se pudo parsear la wallet paper del kernel para snapshot: ${err}`);
      return null;
    }

    if (!Number.isFinite(paperState.equity) || !Number.isFinite(paperState.cash)) {
      this.log.warn(
        'Estado de la wallet paper del kernel inválido (equity/cash no numérico) — snapshot omitido',
      );
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

    const equity = paperState.equity;
    const cash = paperState.cash;
    const positions = paperState.positions ?? [];
    const baselineEquity = paperState.initial_equity ?? equity;
    const totalPnl = equity - baselineEquity;

    const entry = await this.db.navSnapshot.create({
      data: {
        cycle_id: cycleId ?? null,
        provider_id: 'kernel-paper',
        strategy_id: strategyId,
        equity,
        cash,
        positions: JSON.stringify(positions),
        total_pnl: totalPnl,
      },
    });

    // ── F6-s2 PR2: backfill episode outcome after snapshot ───────────────────
    // Calls updateOutcome only when a cycleId is known and LTM is available.
    // Failure NEVER breaks the snapshot.
    if (cycleId && this.longTermMemory) {
      try {
        await this.longTermMemory.updateOutcome(cycleId, totalPnl, equity);
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
        await this.mlSignalRecord.updateOutcomeAggregate(cycleId, totalPnl, equity);
      } catch (e) {
        this.log.warn(
          `[ML] updateOutcomeAggregate failed for cycle ${cycleId} — ml outcome not backfilled: ${e}`,
        );
      }
    }

    return this._hydrate(entry);
  }

  /**
   * Últimos N snapshots en orden cronológico ascendente.
   *
   * Queries `orderBy: { ts: 'desc' }, take: limit` (most recent N rows) and reverses
   * in memory, so the result is bounded to the most recent window AND chronologically
   * ascending — same pattern as getRealEquityCurve. Do not go back to `orderBy: 'asc'`
   * + take: that returns the OLDEST N rows, not the most recent N.
   */
  async getHistory(limit = 90): Promise<NavEntry[]> {
    const rows = await this.db.navSnapshot.findMany({
      orderBy: { ts: 'desc' },
      take: limit,
    });
    return rows
      .slice()
      .reverse()
      .map((r) => this._hydrate(r));
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
   * pattern for a "last N, in order" query — `getHistory` now uses the same pattern
   * (panel-backend-drift fix). `getEquityCurve` (paper) still uses the older
   * `orderBy: { ts: 'asc' }, take: limit` pattern and is out of scope for that fix.
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
