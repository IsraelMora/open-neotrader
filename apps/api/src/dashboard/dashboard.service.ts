import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PluginsService } from '../plugins/plugins.service';

export interface DashboardSummary {
  /** Capital inicial configurado (primer snapshot) */
  initial_capital: number | null;
  /** Equity actual (último snapshot) */
  current_equity: number | null;
  /** Cash disponible */
  current_cash: number | null;
  /** P&L total en $ */
  total_pnl: number | null;
  /** P&L total en % */
  pnl_pct: number | null;
  /** Fecha del primer ciclo registrado */
  running_since: string | null;
  /** Días en ejecución */
  running_days: number | null;
  /** Total de ciclos completados */
  total_cycles: number;
  /** Ciclos en las últimas 24h */
  cycles_last_24h: number;
  /** Plugins activos */
  active_plugins: number;
  /** Alertas sin resolver */
  pending_alerts: number;
}

export interface EquityPoint {
  ts: string;
  equity: number;
  cash: number;
  pnl: number;
}

export interface ProviderStat {
  provider_id: string;
  snapshots: number;
  latest_equity: number | null;
  latest_pnl: number | null;
  /** Rendimiento desde el primer snapshot de este provider */
  return_pct: number | null;
}

export interface PluginStat {
  plugin_id: string;
  name: string;
  type: string;
  active: boolean;
  signals_emitted: number;
  signals_approved: number; // señales que pasaron el veto
  cycles_ran: number; // cuántos ciclos participó
  errors: number;
}

export interface Dashboard {
  summary: DashboardSummary;
  equity_curve: EquityPoint[];
  provider_stats: ProviderStat[];
  plugin_stats: PluginStat[];
  generated_at: string;
}

/** Agrega métricas financieras y operacionales desde BD para el dashboard: resumen, equity curve, stats de providers y plugins. */
@Injectable()
export class DashboardService {
  constructor(
    private readonly db: PrismaService,
    private readonly plugins: PluginsService,
  ) {}

  /**
   * Construye el dashboard completo en paralelo.
   * `equityCurveLimit`: número máximo de puntos en la equity curve (default 90).
   */
  async getDashboard(equityCurveLimit = 90): Promise<Dashboard> {
    const [summary, equity_curve, provider_stats, plugin_stats] = await Promise.all([
      this._buildSummary(),
      this._buildEquityCurve(equityCurveLimit),
      this._buildProviderStats(),
      this._buildPluginStats(),
    ]);

    return {
      summary,
      equity_curve,
      provider_stats,
      plugin_stats,
      generated_at: new Date().toISOString(),
    };
  }

  // ── Summary ─────────────────────────────────────────────────────────────────

  private async _buildSummary(): Promise<DashboardSummary> {
    const [latestSnap, firstSnap, totalCycles, cyclesLast24h, activePlugins, pendingAlerts] =
      await Promise.all([
        this.db.navSnapshot.findFirst({ orderBy: { ts: 'desc' } }),
        this.db.navSnapshot.findFirst({ orderBy: { ts: 'asc' } }),
        this.db.auditEntry.count({ where: { event_type: 'cycle_complete' } }),
        this.db.auditEntry.count({
          where: {
            event_type: 'cycle_complete',
            ts: { gte: new Date(Date.now() - 86_400_000) },
          },
        }),
        this.db.plugin.count({ where: { active: true } }),
        this.db.alertEntry.count({ where: { resolved: false } }),
      ]);

    const initial_capital = firstSnap ? firstSnap.equity : null;
    const current_equity = latestSnap ? latestSnap.equity : null;
    const current_cash = latestSnap ? latestSnap.cash : null;
    const total_pnl = latestSnap ? latestSnap.total_pnl : null;
    const pnl_pct =
      initial_capital && initial_capital > 0 && total_pnl !== null
        ? (total_pnl / initial_capital) * 100
        : null;

    // Fecha de arranque = primer ciclo completado en audit
    const firstCycle = await this.db.auditEntry.findFirst({
      where: { event_type: 'cycle_start' },
      orderBy: { ts: 'asc' },
      select: { ts: true },
    });

    const running_since = firstCycle?.ts.toISOString() ?? null;
    const running_days = firstCycle
      ? Math.floor((Date.now() - firstCycle.ts.getTime()) / 86_400_000)
      : null;

    return {
      initial_capital,
      current_equity,
      current_cash,
      total_pnl,
      pnl_pct: pnl_pct !== null ? Math.round(pnl_pct * 100) / 100 : null,
      running_since,
      running_days,
      total_cycles: totalCycles,
      cycles_last_24h: cyclesLast24h,
      active_plugins: activePlugins,
      pending_alerts: pendingAlerts,
    };
  }

  // ── Equity Curve ────────────────────────────────────────────────────────────

  private async _buildEquityCurve(limit: number): Promise<EquityPoint[]> {
    const snaps = await this.db.navSnapshot.findMany({
      orderBy: { ts: 'asc' },
      take: limit,
      select: { ts: true, equity: true, cash: true, total_pnl: true },
    });

    return snaps.map((s) => ({
      ts: s.ts.toISOString(),
      equity: s.equity,
      cash: s.cash,
      pnl: s.total_pnl,
    }));
  }

  // ── Provider Stats ──────────────────────────────────────────────────────────

  private async _buildProviderStats(): Promise<ProviderStat[]> {
    // Agrupar snapshots por provider_id
    const grouped = await this.db.navSnapshot.groupBy({
      by: ['provider_id'],
      _count: { provider_id: true },
      where: { provider_id: { not: null } },
    });

    const stats: ProviderStat[] = [];
    for (const g of grouped) {
      if (!g.provider_id) continue;

      const [first, latest] = await Promise.all([
        this.db.navSnapshot.findFirst({
          where: { provider_id: g.provider_id },
          orderBy: { ts: 'asc' },
          select: { equity: true },
        }),
        this.db.navSnapshot.findFirst({
          where: { provider_id: g.provider_id },
          orderBy: { ts: 'desc' },
          select: { equity: true, total_pnl: true },
        }),
      ]);

      const return_pct =
        first && latest && first.equity > 0
          ? ((latest.equity - first.equity) / first.equity) * 100
          : null;

      stats.push({
        provider_id: g.provider_id,
        snapshots: g._count.provider_id,
        latest_equity: latest?.equity ?? null,
        latest_pnl: latest?.total_pnl ?? null,
        return_pct: return_pct !== null ? Math.round(return_pct * 100) / 100 : null,
      });
    }

    // Ordenar por P&L descendente
    return stats.sort((a, b) => (b.latest_pnl ?? 0) - (a.latest_pnl ?? 0));
  }

  // ── Plugin Stats ────────────────────────────────────────────────────────────

  private async _buildPluginStats(): Promise<PluginStat[]> {
    const allPlugins = await this.db.plugin.findMany({
      select: { id: true, name: true, type: true, active: true },
      orderBy: { name: 'asc' },
    });

    // Contar señales emitidas por plugin desde audit log
    const signalsByPlugin = await this.db.auditEntry.groupBy({
      by: ['plugin_id'],
      where: {
        event_type: 'signal',
        plugin_id: { not: null },
      },
      _count: { plugin_id: true },
    });

    // Ciclos en los que participó cada plugin (aproximado por logs)
    const cyclesByPlugin = await this.db.auditEntry.groupBy({
      by: ['plugin_id'],
      where: {
        event_type: { in: ['cycle_complete', 'signal', 'decision'] },
        plugin_id: { not: null },
      },
      _count: { plugin_id: true },
    });

    // Errores por plugin
    const errorsByPlugin = await this.db.auditEntry.groupBy({
      by: ['plugin_id'],
      where: {
        event_type: 'cycle_fail',
        plugin_id: { not: null },
      },
      _count: { plugin_id: true },
    });

    const signalMap = new Map(signalsByPlugin.map((r) => [r.plugin_id, r._count.plugin_id]));
    const cycleMap = new Map(cyclesByPlugin.map((r) => [r.plugin_id, r._count.plugin_id]));
    const errorMap = new Map(errorsByPlugin.map((r) => [r.plugin_id, r._count.plugin_id]));

    // Señales aprobadas = señales con sandbox_ok=true
    const approvedByPlugin = await this.db.auditEntry.groupBy({
      by: ['plugin_id'],
      where: { event_type: 'signal', sandbox_ok: true, plugin_id: { not: null } },
      _count: { plugin_id: true },
    });
    const approvedMap = new Map(approvedByPlugin.map((r) => [r.plugin_id, r._count.plugin_id]));

    return allPlugins.map((p) => ({
      plugin_id: p.id,
      name: p.name,
      type: p.type,
      active: p.active,
      signals_emitted: signalMap.get(p.id) ?? 0,
      signals_approved: approvedMap.get(p.id) ?? 0,
      cycles_ran: cycleMap.get(p.id) ?? 0,
      errors: errorMap.get(p.id) ?? 0,
    }));
  }
}
