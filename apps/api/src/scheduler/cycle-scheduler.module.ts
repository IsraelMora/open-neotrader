import { Module } from '@nestjs/common';
import { CycleSchedulerController } from './cycle-scheduler.controller';
import { CycleSchedulerService } from './cycle-scheduler.service';
import { CycleExecutorModule } from '../cycle/cycle-executor.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PluginsModule } from '../plugins/plugins.module';
import { KvService } from '../common/kv.service';

@Module({
  imports: [CycleExecutorModule, PrismaModule, PluginsModule],
  controllers: [CycleSchedulerController],
  providers: [CycleSchedulerService, KvService],
  exports: [CycleSchedulerService],
})
export class CycleSchedulerModule {}
