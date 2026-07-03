import { Module } from '@nestjs/common';
import { PretestSchedulerService } from './pretest-scheduler.service';
import { PrismaModule } from '../prisma/prisma.module';
import { PretestModule } from '../pretest/pretest.module';
import { KvService } from '../common/kv.service';

/**
 * Runs ALL active pretest (virtual) portfolios automatically on a configurable
 * interval. See PretestSchedulerService for the full rationale and safety
 * boundaries — this is purely a virtual-portfolio scheduler, it never touches
 * real execution.
 */
@Module({
  imports: [PrismaModule, PretestModule],
  providers: [PretestSchedulerService, KvService],
  exports: [PretestSchedulerService],
})
export class PretestSchedulerModule {}
