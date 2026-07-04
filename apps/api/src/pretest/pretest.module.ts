import { Module, forwardRef } from '@nestjs/common';
import { PretestService } from './pretest.service';
import { PretestController } from './pretest.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { PluginsModule } from '../plugins/plugins.module';
import { LlmModule } from '../llm/llm.module';
import { ContextMemoryModule } from '../context-memory/context-memory.module';
import { ProvidersModule } from '../providers/providers.module';
import { AgentsModule } from '../agents/agents.module';
import { KvService } from '../common/kv.service';
import { AuditModule } from '../audit/audit.module';
import { GovernedPaperExecutionService } from '../execution/governed-paper-execution.service';

@Module({
  imports: [
    PrismaModule,
    SandboxModule,
    PluginsModule,
    // LlmModule provides LlmService which PretestService injects directly.
    // Must be declared here so PretestModule is self-contained (not relying on
    // AppModule-level LlmModule registration).
    LlmModule,
    ContextMemoryModule,
    ProvidersModule,
    // forwardRef breaks the circular dependency:
    // PretestModule → forwardRef(AgentsModule) ↔ AgentsModule → forwardRef(PretestModule)
    forwardRef(() => AgentsModule),
    AuditModule,
  ],
  // GovernedPaperExecutionService — the shared kernel-gated execution core, also used by
  // TradeIntentModule. Declared here too (not exported from a shared module) since it only
  // depends on ProviderGatewayService + optional AuditService, both already imported above.
  providers: [PretestService, KvService, GovernedPaperExecutionService],
  controllers: [PretestController],
  exports: [PretestService],
})
export class PretestModule {}
