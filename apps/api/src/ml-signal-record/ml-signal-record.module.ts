/**
 * MlSignalRecordModule — ml-feature-extractor-s1.
 *
 * Leaf module: imports only PrismaModule. No dependency on AgentsModule or
 * SnapshotModule -> no circular dep risk. Exports MlSignalRecordService so
 * AgentsModule and SnapshotModule can inject it @Optional().
 */
import { Module } from '@nestjs/common';
import { MlSignalRecordService } from './ml-signal-record.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [MlSignalRecordService],
  exports: [MlSignalRecordService],
})
export class MlSignalRecordModule {}
