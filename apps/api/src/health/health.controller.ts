import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

/** Health check público (Docker/load balancer) y métricas operacionales detalladas (requiere auth). */
@ApiTags('system')
@Controller('health')
export class HealthController {
  constructor(private readonly db: PrismaService) {}

  /** Endpoint mínimo para load balancers y Docker HEALTHCHECK. */
  @Public()
  @Get()
  @ApiOperation({ summary: 'Health check — usado por load balancers y Docker HEALTHCHECK' })
  async check() {
    let db = false;
    try {
      await this.db.$queryRaw`SELECT 1`;
      db = true;
    } catch {
      // DB no disponible → status degraded
    }
    return {
      status: db ? 'ok' : 'degraded',
      ts: new Date().toISOString(),
      services: { database: db ? 'up' : 'down' },
    };
  }

  /** Métricas operacionales completas — requiere auth. */
  @Get('detailed')
  @ApiOperation({ summary: 'Métricas operacionales: plugins, ciclos, alertas, BD (requiere auth)' })
  async detailed() {
    const [
      dbOk,
      activePlugins,
      totalPlugins,
      lastCycle,
      pendingAlerts,
      auditCount,
      pretestCount,
      userCount,
    ] = await Promise.allSettled([
      this.db.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
      this.db.plugin.count({ where: { active: true } }),
      this.db.plugin.count(),
      this.db.auditEntry.findFirst({
        where: { event_type: 'cycle_complete' },
        orderBy: { ts: 'desc' },
        select: { ts: true },
      }),
      this.db.alertEntry.count({ where: { resolved: false } }),
      this.db.auditEntry.count(),
      this.db.pretestPortfolio.count({ where: { is_active: true } }),
      this.db.user.count(),
    ]);

    const ok = (r: PromiseSettledResult<unknown>) => (r.status === 'fulfilled' ? r.value : null);

    const lastCycleTs = ok(lastCycle) as { ts: Date } | null;

    return {
      status: ok(dbOk) ? 'ok' : 'degraded',
      ts: new Date().toISOString(),
      uptime_seconds: Math.floor(process.uptime()),
      memory_mb: {
        rss: Math.round(process.memoryUsage().rss / 1_048_576),
        heap_used: Math.round(process.memoryUsage().heapUsed / 1_048_576),
        heap_total: Math.round(process.memoryUsage().heapTotal / 1_048_576),
      },
      services: {
        database: ok(dbOk) ? 'up' : 'down',
      },
      operational: {
        active_plugins: ok(activePlugins),
        total_plugins: ok(totalPlugins),
        pending_alerts: ok(pendingAlerts),
        audit_entries: ok(auditCount),
        active_pretests: ok(pretestCount),
        single_user_setup: (ok(userCount) as number | null) === 1,
        last_cycle_at: lastCycleTs?.ts ?? null,
        last_cycle_ago_min: lastCycleTs?.ts
          ? Math.round((Date.now() - lastCycleTs.ts.getTime()) / 60_000)
          : null,
      },
    };
  }
}
