import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Almacén clave-valor persistente respaldado por la tabla configEntry de Prisma. */
@Injectable()
export class KvService {
  private readonly log = new Logger(KvService.name);

  constructor(private readonly db: PrismaService) {}

  /** Devuelve el valor asociado a la clave, o null si no existe. */
  async get(key: string): Promise<string | null> {
    const entry = await this.db.configEntry.findUnique({ where: { key } });
    return entry?.value ?? null;
  }

  /** Inserta o actualiza el valor de una clave (upsert). */
  async set(key: string, value: string): Promise<void> {
    await this.db.configEntry.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }

  /** Elimina una entrada por clave; no lanza si no existe (pero deja rastro si falla la DB). */
  async delete(key: string): Promise<void> {
    await this.db.configEntry.deleteMany({ where: { key } }).catch((err: unknown) => {
      this.log.warn(
        `no se pudo borrar la clave KV '${key}': ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }
}
