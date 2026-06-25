import { Module, forwardRef } from '@nestjs/common';
import { CycleExecutorService } from './cycle-executor.service';
import { CycleConfigController } from './cycle-config.controller';
import { AgentsModule } from '../agents/agents.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { PluginsModule } from '../plugins/plugins.module';
import { AuditModule } from '../audit/audit.module';
import { PanelModule } from '../panel/panel.module';
import { KvService } from '../common/kv.service';

@Module({
  imports: [AgentsModule, SandboxModule, PluginsModule, AuditModule, forwardRef(() => PanelModule)],
  controllers: [CycleConfigController],
  providers: [CycleExecutorService, KvService],
  exports: [CycleExecutorService],
})
export class CycleExecutorModule {}
