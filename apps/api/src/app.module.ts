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
