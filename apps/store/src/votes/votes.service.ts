import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Servicio de dominio para votos y reportes de plugins. */
@Injectable()
export class VotesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Registra o actualiza el voto de un publisher sobre un plugin.
   *
   * La operación es idempotente: un segundo voto del mismo publisher
   * sobreescribe el anterior en lugar de crear un duplicado.
   *
   * @param pluginId - ID interno del plugin.
   * @param voterId  - ID del publisher que vota.
   * @param voterKey - Clave pública DER en base64 del votante.
   * @param kind     - Tipo de voto: `like` o `dislike`.
   */
  async vote(
    pluginId: string,
    voterId: string,
    voterKey: string,
    kind: 'like' | 'dislike',
  ) {
    const plugin = await this.prisma.plugin.findUnique({
      where: { id: pluginId },
    });
    if (!plugin) throw new NotFoundException('plugin no encontrado');
    await this.ensurePublisher(voterId, voterKey);
    await this.prisma.vote.upsert({
      where: { pluginId_voterId: { pluginId, voterId } },
      create: { pluginId, voterId, kind },
      update: { kind },
    });
    return { ok: true };
  }

  /**
   * Registra o actualiza el reporte de un publisher sobre un plugin.
   *
   * Idempotente por `(pluginId, reporterId)`: un reenvío actualiza el motivo
   * sin crear duplicados.
   *
   * @param pluginId    - ID interno del plugin.
   * @param reporterId  - ID del publisher que reporta.
   * @param reporterKey - Clave pública DER en base64 del reportante.
   * @param reason      - Motivo del reporte.
   */
  async report(
    pluginId: string,
    reporterId: string,
    reporterKey: string,
    reason: string,
  ) {
    const plugin = await this.prisma.plugin.findUnique({
      where: { id: pluginId },
    });
    if (!plugin) throw new NotFoundException('plugin no encontrado');
    await this.ensurePublisher(reporterId, reporterKey);
    // Idempotente por (plugin, reportante): un replay o reenvío no crea
    // reportes duplicados; solo actualiza el motivo.
    await this.prisma.report.upsert({
      where: { pluginId_reporterId: { pluginId, reporterId } },
      create: { pluginId, reporterId, reason },
      update: { reason },
    });
    return { ok: true };
  }

  private async ensurePublisher(id: string, publicKey: string): Promise<void> {
    await this.prisma.publisher.upsert({
      where: { id },
      create: { id, publicKey },
      update: {},
    });
  }
}
