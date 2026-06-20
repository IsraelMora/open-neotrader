import { Module, forwardRef } from '@nestjs/common';
import { CycleExecutorService } from './cycle-executor.service';
import { AgentsModule } from '../agents/agents.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { PluginsModule } from '../plugins/plugins.module';
import { AuditModule } from '../audit/audit.module';
import { PanelModule } from '../panel/panel.module';

@Module({
  imports: [AgentsModule, SandboxModule, PluginsModule, AuditModule, forwardRef(() => PanelModule)],
  providers: [CycleExecutorService],
  exports: [CycleExecutorService],
})
export class CycleExecutorModule {}
