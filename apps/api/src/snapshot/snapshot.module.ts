import { Module } from '@nestjs/common';
import { SnapshotService } from './snapshot.service';
import { SnapshotController } from './snapshot.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { ProvidersModule } from '../providers/providers.module';
import { LongTermMemoryModule } from '../long-term-memory/long-term-memory.module';

@Module({
  // LongTermMemoryModule is a leaf (PrismaModule only) — no circular dep risk.
  imports: [PrismaModule, ProvidersModule, LongTermMemoryModule],
  providers: [SnapshotService],
  controllers: [SnapshotController],
  exports: [SnapshotService],
})
export class SnapshotModule {}
