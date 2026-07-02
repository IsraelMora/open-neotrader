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
 *
 * Also imports RealOrderModule (Fix 1) — RealBrokerReconciliationService's
 * steady-state tick delegates to RealOrderService.recoverInflight() to sweep
 * pending_submit/submit_failed rows every tick, not just at app boot (see
 * reconcileAllOpenOrders()'s doc). Checked for cycles: RealOrderModule imports
 * only PrismaModule + ProvidersModule, and does NOT import
 * RealReconciliationModule (nor anything that transitively does) — so this
 * import direction (RealReconciliation -> RealOrder) is safe, exactly like the
 * existing AlertsModule import above.
 *
 * Exports RealBrokerReconciliationService for that wiring and for the
 * onModuleInit steady-state polling loop.
 */
import { Module } from '@nestjs/common';
import { RealBrokerReconciliationService } from './real-broker-reconciliation.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ProvidersModule } from '../providers/providers.module';
import { AlertsModule } from '../alerts/alerts.module';
import { RealOrderModule } from '../real-order/real-order.module';
import { KvService } from '../common/kv.service';

@Module({
  imports: [PrismaModule, ProvidersModule, AlertsModule, RealOrderModule],
  providers: [RealBrokerReconciliationService, KvService],
  exports: [RealBrokerReconciliationService],
})
export class RealReconciliationModule {}
