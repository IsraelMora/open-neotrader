/**
 * AlertsService — Repositorio de alertas emitidas por plugins.
 *
 * La plataforma no detecta condiciones de riesgo por sí misma (no tiene
 * visibilidad del mercado). Los plugins discipline/extra emiten alertas
 * a través del contexto del ciclo (clave `emit_alerts`), y el framework
 * las persiste aquí para su consulta y notificación.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type AlertType =
  | 'DRAWDOWN'
  | 'FLASH_CRASH'
  | 'CORRELATION_SPIKE'
  | 'VOLUME_ANOMALY'
  | 'MACRO_EVENT'
  | 'RECONCILIATION_HALTED'
  | 'CUSTOM';

export type AlertSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface Alert {
  id: string;
  ts: Date;
  type: AlertType;
  severity: AlertSeverity;
  symbol: string | null;
  message: string;
  meta: Record<string, unknown> | null;
  resolved: boolean;
}

export interface CreateAlertDto {
  type: AlertType;
  severity: AlertSeverity;
  symbol?: string | null;
  message: string;
  meta?: Record<string, unknown> | null;
}

@Injectable()
export class AlertsService {
  constructor(private readonly db: PrismaService) {}

  async create(dto: CreateAlertDto): Promise<Alert> {
    const row = await this.db.alertEntry.create({
      data: {
        id: crypto.randomUUID(),
        type: dto.type,
        severity: dto.severity,
        symbol: dto.symbol ?? null,
        message: dto.message,
        meta: dto.meta ? JSON.stringify(dto.meta) : null,
      },
    });
    return this._hydrate(row);
  }

  /** Crear múltiples alertas de una vez (emitidas por un plugin en un ciclo). */
  async createBulk(dtos: CreateAlertDto[]): Promise<Alert[]> {
    if (dtos.length === 0) return [];
    const rows = await this.db.alertEntry.createManyAndReturn({
      data: dtos.map((dto) => ({
        id: crypto.randomUUID(),
        type: dto.type,
        severity: dto.severity,
        symbol: dto.symbol ?? null,
        message: dto.message,
        meta: dto.meta ? JSON.stringify(dto.meta) : null,
      })),
    });
    return rows.map((r) => this._hydrate(r));
  }

  async getRecent(limit = 50): Promise<Alert[]> {
    const rows = await this.db.alertEntry.findMany({
      orderBy: { ts: 'desc' },
      take: limit,
    });
    return rows.map((r) => this._hydrate(r));
  }

  async getActive(): Promise<Alert[]> {
    const rows = await this.db.alertEntry.findMany({
      where: { resolved: false },
      orderBy: { ts: 'desc' },
    });
    return rows.map((r) => this._hydrate(r));
  }

  async resolve(id: string): Promise<void> {
    await this.db.alertEntry.update({
      where: { id },
      data: { resolved: true, resolved_at: new Date() },
    });
  }

  async resolveAll(): Promise<void> {
    await this.db.alertEntry.updateMany({
      where: { resolved: false },
      data: { resolved: true, resolved_at: new Date() },
    });
  }

  async stats(): Promise<Record<string, unknown>> {
    const total = await this.db.alertEntry.count();
    const active = await this.db.alertEntry.count({ where: { resolved: false } });
    const byType = await this.db.alertEntry.groupBy({
      by: ['type'],
      _count: { type: true },
    });
    return {
      total,
      active,
      by_type: Object.fromEntries(byType.map((r) => [r.type, r._count.type])),
    };
  }

  private _hydrate(row: {
    id: string;
    ts: Date;
    type: string;
    severity: string;
    symbol: string | null;
    message: string;
    meta: string | null;
    resolved: boolean;
    resolved_at: Date | null;
  }): Alert {
    return {
      id: row.id,
      ts: row.ts,
      type: row.type as AlertType,
      severity: row.severity as AlertSeverity,
      symbol: row.symbol,
      message: row.message,
      meta: row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : null,
      resolved: row.resolved,
    };
  }
}
