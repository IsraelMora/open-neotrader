import { Module } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { DashboardController } from './dashboard.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { PluginsModule } from '../plugins/plugins.module';

@Module({
  imports: [PrismaModule, PluginsModule],
  providers: [DashboardService],
  controllers: [DashboardController],
})
export class DashboardModule {}
