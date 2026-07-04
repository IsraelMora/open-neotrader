import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type AuditEventType =
  | 'cycle_start'
  | 'cycle_complete'
  | 'cycle_fail'
  | 'cycle_aborted'
  | 'signal'
  | 'decision'
  | 'plugin_activate'
  | 'plugin_deactivate'
  | 'credential_set'
  | 'tool_call_dropped'
  | 'parse_miss'
  | 'chat_turn'
  | 'pretest_turn'
  | 'notification_sent'
  | 'skill_written'
  | 'skill_reverted'
  | 'skill_write_denied'
  | 'kernel_source_not_allowed'
  | 'reflection_turn'
  | 'pretest_variant_created'
  | 'pretest_compared'
  | 'pretest_cap_reached'
  | 'pretest_promoted'
  | 'pretest_promote_requested'
  | 'promotion_gate_blocked'
  | 'plugin_content_changed'
  | 'react_iteration'
  | 'react_budget_exhausted'
  | 'tool_call_cap_reached'
  | 'lesson_recorded'
  // F6-S3: Multi-agent debate / consensus events
  | 'debate_started'
  | 'debate_stance'
  | 'debate_consensus'
  | 'debate_skipped'
  // ml-feature-extractor-s2: on-device model training
  | 'ml_model_trained'
  // ml-feature-extractor-s3: live confidence adjustment via on_cycle hook
  | 'ml_signals_adjusted'
  // adaptive-parameters: kernel__tune_plugin_param success
  | 'param_tuned'
  // measurable-veto-shield: real→paper demotion because the applied strategy lacks a
  // recent ROBUSTO walk-forward verdict (walk-forward gate before live trading)
  | 'walk_forward_gate_demotion'
  // kernel web search: benign, read-only info event — never a decision/signal.
  | 'kernel_web_search'
  // kernel web search: per-cycle defense-in-depth cap reached (MAX_WEB_SEARCH_CALLS_PER_CYCLE)
  // — one or more web_search calls dropped gracefully in this iteration, cycle unaffected.
  | 'web_search_cycle_cap_reached'
  // vol-managed exposure: the vol-target discipline's on_cycle hook failed (or returned
  // an unusable value) during a pretest cycle — exposureScalar fails safe to 0 (100% cash)
  // but a persistently-failing hook would otherwise be invisible outside server logs.
  | 'vol_target_exposure_failed'
  // risk-discipline: prop-firm-style daily/weekly loss circuit-breaker tripped — new paper
  // entries (long/short) are blocked until the next UTC day/week. Exit/hold unaffected.
  | 'loss_circuit_breaker_tripped';

export interface AuditPayload {
  cycle_id?: string;
  event_type: AuditEventType;
  plugin_id?: string;
  symbol?: string;
  action?: string;
  llm_text?: string;
  signals_count?: number;
  skills_read?: string[];
  skills_written?: string[];
  sandbox_ok?: boolean;
  error?: string;
  meta?: Record<string, unknown>;
}

/** Registra y consulta el log inmutable de eventos del agente: ciclos, señales, decisiones y errores. */
@Injectable()
export class AuditService {
  constructor(private readonly db: PrismaService) {}

  /** Persiste un evento de auditoría. Trunca llm_text a 2000 chars y error a 500. */
  async log(payload: AuditPayload): Promise<void> {
    await this.db.auditEntry.create({
      data: {
        cycle_id: payload.cycle_id,
        event_type: payload.event_type,
        plugin_id: payload.plugin_id,
        symbol: payload.symbol,
        action: payload.action,
        llm_text: payload.llm_text?.slice(0, 2000), // truncar para BD
        signals_count: payload.signals_count,
        skills_read: payload.skills_read ? JSON.stringify(payload.skills_read) : undefined,
        skills_written: payload.skills_written ? JSON.stringify(payload.skills_written) : undefined,
        sandbox_ok: payload.sandbox_ok,
        error: payload.error?.slice(0, 500),
        meta: payload.meta ? JSON.stringify(payload.meta) : undefined,
      },
    });
  }

  /** Consulta el log con filtros opcionales por tipo, ciclo, plugin y rango de fechas. */
  async query(opts: {
    event_type?: AuditEventType;
    cycle_id?: string;
    plugin_id?: string;
    from?: Date;
    to?: Date;
    limit?: number;
  }) {
    const limit = Math.min(opts.limit ?? 100, 1000);
    return this.db.auditEntry.findMany({
      where: {
        ...(opts.event_type ? { event_type: opts.event_type } : {}),
        ...(opts.cycle_id ? { cycle_id: opts.cycle_id } : {}),
        ...(opts.plugin_id ? { plugin_id: opts.plugin_id } : {}),
        ...(opts.from || opts.to
          ? {
              ts: {
                ...(opts.from ? { gte: opts.from } : {}),
                ...(opts.to ? { lte: opts.to } : {}),
              },
            }
          : {}),
      },
      orderBy: { ts: 'desc' },
      take: limit,
    });
  }

  /** Devuelve todos los eventos de un ciclo en orden cronológico. */
  async getCycleSummary(cycleId: string) {
    const entries = await this.db.auditEntry.findMany({
      where: { cycle_id: cycleId },
      orderBy: { ts: 'asc' },
    });
    return entries;
  }

  /**
   * Exporta el log de auditoría como JSON-L (una línea JSON por evento).
   * Formato determinista, apto para versionar en git o procesar con jq.
   * Limita a 10,000 entradas por exportación.
   */
  async exportJsonL(opts: {
    from?: Date;
    to?: Date;
    event_type?: AuditEventType;
    plugin_id?: string;
  }): Promise<string> {
    const entries = await this.db.auditEntry.findMany({
      where: {
        ...(opts.event_type ? { event_type: opts.event_type } : {}),
        ...(opts.plugin_id ? { plugin_id: opts.plugin_id } : {}),
        ...(opts.from || opts.to
          ? {
              ts: {
                ...(opts.from ? { gte: opts.from } : {}),
                ...(opts.to ? { lte: opts.to } : {}),
              },
            }
          : {}),
      },
      orderBy: { ts: 'asc' },
      take: 10_000,
    });

    return entries
      .map((e) =>
        JSON.stringify({
          ts: e.ts.toISOString(),
          cycle_id: e.cycle_id,
          event_type: e.event_type,
          plugin_id: e.plugin_id,
          symbol: e.symbol,
          action: e.action,
          signals_count: e.signals_count,
          sandbox_ok: e.sandbox_ok,
          error: e.error,
          skills_read: e.skills_read ? (JSON.parse(e.skills_read) as string[]) : null,
          skills_written: e.skills_written ? (JSON.parse(e.skills_written) as string[]) : null,
          meta: e.meta ? (JSON.parse(e.meta) as Record<string, unknown>) : null,
        }),
      )
      .join('\n');
  }

  /** Estadísticas del log: total de entradas, fechas extremas y conteo por tipo de evento. */
  async stats(): Promise<Record<string, unknown>> {
    const total = await this.db.auditEntry.count();
    const byType = await this.db.auditEntry.groupBy({
      by: ['event_type'],
      _count: { event_type: true },
    });
    const oldest = await this.db.auditEntry.findFirst({
      orderBy: { ts: 'asc' },
      select: { ts: true },
    });
    const newest = await this.db.auditEntry.findFirst({
      orderBy: { ts: 'desc' },
      select: { ts: true },
    });

    return {
      total,
      oldest: oldest?.ts,
      newest: newest?.ts,
      by_event_type: Object.fromEntries(byType.map((r) => [r.event_type, r._count.event_type])),
    };
  }

  /**
   * Elimina entradas del log más antiguas que `retentionDays` días.
   * Devuelve el número de entradas eliminadas.
   * El objetivo es limitar el crecimiento del DB en instalaciones de larga duración.
   */
  async prune(retentionDays = 90): Promise<{ deleted: number; cutoff: Date }> {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
    const result = await this.db.auditEntry.deleteMany({
      where: { ts: { lt: cutoff } },
    });
    return { deleted: result.count, cutoff };
  }
}
