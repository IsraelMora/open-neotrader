import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  parseAndValidateManifest,
  ManifestError,
} from '../common/manifest.validator';

@Injectable()
export class PluginsService {
  constructor(private readonly prisma: PrismaService) {}

  async publish(
    publisherId: string,
    publicKey: string,
    manifestToml: string,
    payloadBase64: string,
  ) {
    let m;
    try {
      m = parseAndValidateManifest(manifestToml);
    } catch (e) {
      if (e instanceof ManifestError) throw new BadRequestException(e.message);
      throw e;
    }
    const payload = Buffer.from(payloadBase64, 'base64');
    const checksum = createHash('sha256').update(payload).digest('hex');

    await this.prisma.publisher.upsert({
      where: { id: publisherId },
      create: { id: publisherId, publicKey },
      update: {},
    });

    const plugin = await this.prisma.plugin.upsert({
      where: { publisherId_manifestId: { publisherId, manifestId: m.id } },
      create: {
        publisherId,
        manifestId: m.id,
        type: m.type,
        name: m.name,
        description: m.description,
        latestVersion: m.version,
        repository: m.repository ?? null,
      },
      update: {
        name: m.name,
        description: m.description,
        latestVersion: m.version,
        repository: m.repository ?? null,
      },
    });

    const dup = await this.prisma.pluginVersion.findUnique({
      where: { pluginId_version: { pluginId: plugin.id, version: m.version } },
    });
    if (dup) throw new ConflictException(`versión ${m.version} ya publicada`);

    await this.prisma.pluginVersion.create({
      data: {
        pluginId: plugin.id,
        version: m.version,
        manifestToml,
        payload,
        checksum,
        signature: '',
      },
    });
    return { id: plugin.id, manifestId: m.id, version: m.version };
  }

  async list(params: {
    type?: string;
    q?: string;
    sort?: string;
    page?: number;
    pageSize?: number;
  }) {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20));
    const where: import('@prisma/client').Prisma.PluginWhereInput = {};
    if (params.type) where.type = params.type;
    if (params.q)
      where.OR = [
        { name: { contains: params.q } },
        { description: { contains: params.q } },
      ];
    const orderBy =
      params.sort === 'recent'
        ? { updatedAt: 'desc' as const }
        : { createdAt: 'desc' as const };
    const [items, total] = await Promise.all([
      this.prisma.plugin.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { _count: { select: { votes: true, reports: true } } },
      }),
      this.prisma.plugin.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  async detail(publisherId: string, manifestId: string) {
    const plugin = await this.prisma.plugin.findUnique({
      where: { publisherId_manifestId: { publisherId, manifestId } },
      include: {
        versions: {
          orderBy: { publishedAt: 'desc' },
          select: { version: true, publishedAt: true, checksum: true },
        },
        publisher: { select: { id: true, displayName: true } },
      },
    });
    if (!plugin) throw new NotFoundException('plugin no encontrado');
    const likes = await this.prisma.vote.count({
      where: { pluginId: plugin.id, kind: 'like' },
    });
    const dislikes = await this.prisma.vote.count({
      where: { pluginId: plugin.id, kind: 'dislike' },
    });
    const reports = await this.prisma.report.count({
      where: { pluginId: plugin.id },
    });
    return { ...plugin, counts: { likes, dislikes, reports } };
  }

  async download(publisherId: string, manifestId: string, version: string) {
    const plugin = await this.prisma.plugin.findUnique({
      where: { publisherId_manifestId: { publisherId, manifestId } },
    });
    if (!plugin) throw new NotFoundException('plugin no encontrado');
    const v = await this.prisma.pluginVersion.findUnique({
      where: { pluginId_version: { pluginId: plugin.id, version } },
    });
    if (!v) throw new NotFoundException('versión no encontrada');
    return {
      manifestToml: v.manifestToml,
      payloadBase64: Buffer.from(v.payload).toString('base64'),
      checksum: v.checksum,
    };
  }
}
