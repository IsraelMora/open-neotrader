import { Module } from '@nestjs/common';
import { AgentsService } from './agents.service';
import { LlmModule } from '../llm/llm.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { PluginsModule } from '../plugins/plugins.module';
import { ContextMemoryModule } from '../context-memory/context-memory.module';
import { AuditModule } from '../audit/audit.module';
import { AlertsModule } from '../alerts/alerts.module';

@Module({
  imports: [
    LlmModule,
    SandboxModule,
    PluginsModule,
    ContextMemoryModule,
    AuditModule,
    AlertsModule,
  ],
  providers: [AgentsService],
  exports: [AgentsService],
})
export class AgentsModule {}
