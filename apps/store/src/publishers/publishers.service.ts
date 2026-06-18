import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Servicio de dominio para la gestión de publishers. */
@Injectable()
export class PublishersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Crea o actualiza el registro del publisher y asigna su nombre público.
   *
   * @param id          - Identificador único del publisher.
   * @param publicKey   - Clave pública DER en base64.
   * @param displayName - Nombre a mostrar; `null` para eliminarlo.
   */
  async setName(id: string, publicKey: string, displayName: string | null) {
    await this.prisma.publisher.upsert({
      where: { id },
      create: { id, publicKey, displayName },
      update: { displayName },
    });
    return { id, displayName };
  }
}
