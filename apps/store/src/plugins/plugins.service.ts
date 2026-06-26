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

/** Servicio de dominio para gestión del catálogo de plugins. */
@Injectable()
export class PluginsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Publica o actualiza un plugin.
   *
   * Parsea y valida el manifiesto TOML, crea o actualiza el registro del plugin
   * y crea una nueva `PluginVersion`. Lanza `ConflictException` si la versión
   * ya existe.
   *
   * @param publisherId   - ID del publisher autenticado.
   * @param publicKey     - Clave pública DER en base64 del publisher.
   * @param manifestToml  - Manifiesto del plugin en formato TOML.
   * @param payloadBase64 - Contenido binario del plugin codificado en base64.
   */
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

    await this.ensurePublisher(publisherId, publicKey);

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

  /**
   * Devuelve una página de plugins aplicando filtros opcionales.
   *
   * @param params.type     - Filtra por tipo de plugin.
   * @param params.q        - Búsqueda de texto libre en nombre y descripción.
   * @param params.sort     - `recent` ordena por `updatedAt`; por defecto por `createdAt`.
   * @param params.page     - Página solicitada (base 1; mínimo 1).
   * @param params.pageSize - Tamaño de página (mínimo 1, máximo 100; por defecto 20).
   */
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

  /**
   * Devuelve el detalle completo de un plugin con sus versiones y contadores de interacción.
   *
   * @param publisherId - Identificador del publisher propietario.
   * @param manifestId  - Identificador del manifiesto del plugin.
   */
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
    const [likes, dislikes, reports] = await Promise.all([
      this.prisma.vote.count({ where: { pluginId: plugin.id, kind: 'like' } }),
      this.prisma.vote.count({
        where: { pluginId: plugin.id, kind: 'dislike' },
      }),
      this.prisma.report.count({ where: { pluginId: plugin.id } }),
    ]);
    return { ...plugin, counts: { likes, dislikes, reports } };
  }

  /**
   * Devuelve el manifiesto TOML y el payload en base64 de una versión específica.
   *
   * @param publisherId - Identificador del publisher.
   * @param manifestId  - Identificador del manifiesto del plugin.
   * @param version     - Versión exacta a descargar.
   */
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

  private async ensurePublisher(id: string, publicKey: string): Promise<void> {
    await this.prisma.publisher.upsert({
      where: { id },
      create: { id, publicKey },
      update: {},
    });
  }
}
