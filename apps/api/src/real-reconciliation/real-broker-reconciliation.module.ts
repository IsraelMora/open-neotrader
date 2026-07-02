/**
 * RealReconciliationModule — reconciles RealOrder rows against broker truth.
 *
 * Leaf module: imports PrismaModule + ProvidersModule (for ProviderGatewayService)
 * and provides its own KvService (interval config for the steady-state loop AND
 * the KV-persisted circuit breaker state, see CB_KEY in the service), mirroring
 * how other feature modules provide KvService directly rather than via a shared
 * CommonModule. Also imports AlertsModule — the circuit breaker emits a CRITICAL
 * RECONCILIATION_HALTED AlertEntry when it trips (AlertsModule only depends on
 * PrismaModule, so this does not introduce a cycle). Deliberately does NOT
 * import TradeIntentModule / depend on TradeIntentService — TradeIntentModule
 * imports THIS module (to fire-and-forget fastPollOrder after a real submit),
 * so the dependency must stay one-directional to avoid a circular module
 * dependency.
 * Exports RealBrokerReconciliationService for that wiring and for the
 * onModuleInit steady-state polling loop.
 */
import { Module } from '@nestjs/common';
import { RealBrokerReconciliationService } from './real-broker-reconciliation.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ProvidersModule } from '../providers/providers.module';
import { AlertsModule } from '../alerts/alerts.module';
import { KvService } from '../common/kv.service';

@Module({
  imports: [PrismaModule, ProvidersModule, AlertsModule],
  providers: [RealBrokerReconciliationService, KvService],
  exports: [RealBrokerReconciliationService],
})
export class RealReconciliationModule {}
