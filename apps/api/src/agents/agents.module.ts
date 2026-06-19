import { Module } from '@nestjs/common';
import { AgentsService } from './agents.service';
import { LlmModule } from '../llm/llm.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { PluginsModule } from '../plugins/plugins.module';
import { ContextMemoryModule } from '../context-memory/context-memory.module';
import { AuditModule } from '../audit/audit.module';
import { AlertsModule } from '../alerts/alerts.module';
import { SnapshotModule } from '../snapshot/snapshot.module';
import { NotifierModule } from '../notifier/notifier.module';

@Module({
  imports: [
    LlmModule,
    SandboxModule,
    PluginsModule,
    ContextMemoryModule,
    AuditModule,
    AlertsModule,
    SnapshotModule,
    NotifierModule,
    // PretestModule is NOT imported here to avoid a circular module dependency
    // (PretestModule → AgentsModule → PretestModule). AgentsService.pretest is injected
    // optionally (?); the assembler degrades gracefully when PretestService is absent.
    // Wire PretestService into AgentsService via AppModule custom provider if needed.
  ],
  providers: [AgentsService],
  exports: [AgentsService],
})
export class AgentsModule {}
// Note: AgentsController lives in PanelModule (not here) because it depends on PanelService.
// Hosting it here would create AgentsModule → PanelModule → AgentsModule circular dep.
