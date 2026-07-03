import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { PluginsModule } from './plugins/plugins.module';
import { SandboxModule } from './sandbox/sandbox.module';
import { LlmModule } from './llm/llm.module';
import { AgentsModule } from './agents/agents.module';
import { PanelModule } from './panel/panel.module';
import { StoreModule } from './store/store.module';
import { CredentialsModule } from './credentials/credentials.module';
import { HealthModule } from './health/health.module';
import { EventsModule } from './events/events.module';
import { CycleSchedulerModule } from './scheduler/cycle-scheduler.module';
import { AuditModule } from './audit/audit.module';
import { NotifierModule } from './notifier/notifier.module';
import { ProvidersModule } from './providers/providers.module';
import { BackupModule } from './backup/backup.module';
import { RegistryModule } from './registry/registry.module';
import { WsModule } from './ws/ws.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { ContextMemoryModule } from './context-memory/context-memory.module';
import { LongTermMemoryModule } from './long-term-memory/long-term-memory.module';
import { SnapshotModule } from './snapshot/snapshot.module';
import { AlertsModule } from './alerts/alerts.module';
import { PretestModule } from './pretest/pretest.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { BacktestModule } from './backtest/backtest.module';
import { TradeIntentModule } from './trade-intent/trade-intent.module';
import { StrategyModule } from './strategy/strategy.module';
import { VetoAnalyzerModule } from './veto-analyzer/veto-analyzer.module';
import { RealOrderModule } from './real-order/real-order.module';
import { RealReconciliationModule } from './real-reconciliation/real-broker-reconciliation.module';
import { StrategyBootstrapModule } from './strategy-bootstrap/strategy-bootstrap.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { CorrelationMiddleware } from './common/correlation.middleware';

@Module({
  imports: [
    // envFilePath = DOTENV_PATH (volumen persistente en prod) → las credenciales de
    // providers escritas vía /credentials sobreviven a los redeploys.
    ConfigModule.forRoot({ isGlobal: true, envFilePath: process.env['DOTENV_PATH'] ?? '.env' }),
    EventEmitterModule.forRoot({ wildcard: false, maxListeners: 50 }),

    // Rate limiting: 120 req/min por IP en rutas normales, 10/min en rutas de auth
    ThrottlerModule.forRoot([
      { name: 'default', ttl: 60_000, limit: 120 },
      { name: 'auth', ttl: 60_000, limit: 10 },
    ]),

    PrismaModule,
    AuthModule,
    UsersModule,
    PluginsModule,
    SandboxModule,
    LlmModule,
    AgentsModule,
    PanelModule,
    StoreModule,
    CredentialsModule,
    HealthModule,
    EventsModule,
    CycleSchedulerModule,
    AuditModule,
    NotifierModule,
    ProvidersModule,
    BackupModule,
    RegistryModule,
    WsModule,
    OnboardingModule,
    ContextMemoryModule,
    LongTermMemoryModule,
    SnapshotModule,
    AlertsModule,
    PretestModule,
    DashboardModule,
    BacktestModule,
    TradeIntentModule,
    StrategyModule,
    VetoAnalyzerModule,
    // Fix 3: RealOrderModule is listed BEFORE RealReconciliationModule here. Historically
    // this ordering mattered because RealOrderService.onModuleInit -> recoverInflight()
    // was the ONLY thing that ever re-checked pending_submit/submit_failed rows, and
    // Nest generally initializes providers in import-array order — so this array
    // position determined which module's onModuleInit ran first on boot. Since Fix 1
    // (RealBrokerReconciliationService.reconcileAllOpenOrders() now sweeps those same
    // rows via RealOrderService.recoverInflight() on EVERY steady-state tick, not just
    // at boot), correctness no longer depends on this array position at all — a stuck
    // row is recovered by the very next tick regardless of which module's
    // onModuleInit ran first, or even if RealOrderModule's onModuleInit never ran (see
    // the "Fix 3: boot-order independence" tests in
    // real-broker-reconciliation.service.spec.ts). This ordering is kept purely for
    // defense-in-depth / faster convergence (one fewer tick to wait for on a cold
    // boot) — it is NOT load-bearing for correctness anymore.
    RealOrderModule,
    RealReconciliationModule,
    StrategyBootstrapModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(CorrelationMiddleware).forRoutes('*');
  }
}
