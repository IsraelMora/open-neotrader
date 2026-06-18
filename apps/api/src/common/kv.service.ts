import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class KvService {
  constructor(private readonly db: PrismaService) {}

  async get(key: string): Promise<string | null> {
    const entry = await this.db.configEntry.findUnique({ where: { key } });
    return entry?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.db.configEntry.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }

  async delete(key: string): Promise<void> {
    await this.db.configEntry.deleteMany({ where: { key } }).catch(() => {});
  }
}
