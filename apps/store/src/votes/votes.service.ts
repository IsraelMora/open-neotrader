import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class VotesService {
  constructor(private readonly prisma: PrismaService) {}

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
    await this.prisma.publisher.upsert({
      where: { id: voterId },
      create: { id: voterId, publicKey: voterKey },
      update: {},
    });
    await this.prisma.vote.upsert({
      where: { pluginId_voterId: { pluginId, voterId } },
      create: { pluginId, voterId, kind },
      update: { kind },
    });
    return { ok: true };
  }

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
    await this.prisma.publisher.upsert({
      where: { id: reporterId },
      create: { id: reporterId, publicKey: reporterKey },
      update: {},
    });
    // Idempotente por (plugin, reportante): un replay o reenvío no crea
    // reportes duplicados; solo actualiza el motivo.
    await this.prisma.report.upsert({
      where: { pluginId_reporterId: { pluginId, reporterId } },
      create: { pluginId, reporterId, reason },
      update: { reason },
    });
    return { ok: true };
  }
}
