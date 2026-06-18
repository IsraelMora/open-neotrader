import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';

/**
 * Wrapper de PrismaClient adaptado para NestJS.
 *
 * Usa `PrismaBetterSqlite3` como driver y toma la URL de la base de datos
 * de `DATABASE_URL` (por defecto `file:./dev.db`). La conexión se establece
 * automáticamente al inicializar el módulo.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  constructor() {
    const url = process.env.DATABASE_URL ?? 'file:./dev.db';
    super({ adapter: new PrismaBetterSqlite3({ url }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }
}
