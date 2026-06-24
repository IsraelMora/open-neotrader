import { Module, forwardRef } from '@nestjs/common';
import { AgentsService } from './agents.service';
import { DebateService } from './debate.service';
import { LlmModule } from '../llm/llm.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { PluginsModule } from '../plugins/plugins.module';
import { ContextMemoryModule } from '../context-memory/context-memory.module';
import { AuditModule } from '../audit/audit.module';
import { AlertsModule } from '../alerts/alerts.module';
import { SnapshotModule } from '../snapshot/snapshot.module';
import { NotifierModule } from '../notifier/notifier.module';
import { PretestModule } from '../pretest/pretest.module';
import { KvService } from '../common/kv.service';
import { LongTermMemoryModule } from '../long-term-memory/long-term-memory.module';
import { ProvidersModule } from '../providers/providers.module';
import { MlSignalRecordModule } from '../ml-signal-record/ml-signal-record.module';
import { MlSignalRecordService } from '../ml-signal-record/ml-signal-record.service';
import { TradeIntentModule } from '../trade-intent/trade-intent.module';

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
    // forwardRef breaks the circular dependency:
    // AgentsModule → forwardRef(PretestModule) ↔ PretestModule → forwardRef(AgentsModule)
    // PretestService injects AgentsService (to run governed turns for pretest cycles).
    // AgentsService injects PretestService (to create/compare pretest portfolios in reflection).
    forwardRef(() => PretestModule),
    // LongTermMemoryModule is a leaf (PrismaModule only) — no circular dep risk.
    LongTermMemoryModule,
    // ProvidersModule exports ProviderGatewayService needed by AgentsService._isHighImpact.
    // providers never imports agents — no circular dep.
    ProvidersModule,
    // MlSignalRecordModule is a leaf (PrismaModule only) — no circular dep risk.
    MlSignalRecordModule,
    // TradeIntentModule exports TradeIntentService → AgentsService persists a
    // pending TradeIntent (HITL, paper-only) when the LLM emits a decision.
    TradeIntentModule,
  ],
  providers: [AgentsService, KvService, DebateService, MlSignalRecordService],
  exports: [AgentsService],
})
export class AgentsModule {}
// Note: AgentsController lives in PanelModule (not here) because it depends on PanelService.
// Hosting it here would create AgentsModule → PanelModule → AgentsModule circular dep.
