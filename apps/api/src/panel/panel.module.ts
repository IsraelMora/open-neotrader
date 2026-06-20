import { Module, forwardRef } from '@nestjs/common';
import { PanelController } from './panel.controller';
import { PanelService } from './panel.service';
import { AgentsModule } from '../agents/agents.module';
import { LlmModule } from '../llm/llm.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { PluginsModule } from '../plugins/plugins.module';
import { AuditModule } from '../audit/audit.module';
import { AgentsController } from '../agents/agents.controller';
import { CycleExecutorModule } from '../cycle/cycle-executor.module';

@Module({
  imports: [
    AgentsModule,
    LlmModule,
    SandboxModule,
    PluginsModule,
    AuditModule,
    forwardRef(() => CycleExecutorModule),
  ],
  // AgentsController lives here (not in AgentsModule) because it depends on PanelService,
  // which is provided by this module. Hosting it here avoids a circular module dependency
  // (AgentsModule → PanelModule → AgentsModule).
  controllers: [PanelController, AgentsController],
  providers: [PanelService],
  // Re-export CycleExecutorModule (via forwardRef) so PanelController and AgentsController
  // (hosted in this module) can resolve CycleExecutorService.
  exports: [PanelService, forwardRef(() => CycleExecutorModule)],
})
export class PanelModule {}
