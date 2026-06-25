import { Module } from '@nestjs/common';
import { SnapshotService } from './snapshot.service';
import { SnapshotController } from './snapshot.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { ProvidersModule } from '../providers/providers.module';
import { LongTermMemoryModule } from '../long-term-memory/long-term-memory.module';
import { MlSignalRecordModule } from '../ml-signal-record/ml-signal-record.module';
import { MlSignalRecordService } from '../ml-signal-record/ml-signal-record.service';
import { KvService } from '../common/kv.service';

@Module({
  // LongTermMemoryModule is a leaf (PrismaModule only) — no circular dep risk.
  // MlSignalRecordModule is a leaf (PrismaModule only) — no circular dep risk.
  imports: [PrismaModule, ProvidersModule, LongTermMemoryModule, MlSignalRecordModule],
  providers: [SnapshotService, MlSignalRecordService, KvService],
  controllers: [SnapshotController],
  exports: [SnapshotService],
})
export class SnapshotModule {}
