import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';

/** Cliente Prisma configurado con el adapter better-sqlite3; se conecta al módulo init. */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  constructor() {
    const url = process.env['DATABASE_URL'] ?? 'file:./neurotrader.db';
    super({ adapter: new PrismaBetterSqlite3({ url }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }
}
