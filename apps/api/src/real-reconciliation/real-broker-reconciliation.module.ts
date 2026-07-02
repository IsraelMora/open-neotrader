/**
 * RealReconciliationModule — reconciles RealOrder rows against broker truth.
 *
 * Leaf module: imports PrismaModule + ProvidersModule (for ProviderGatewayService).
 * Exports RealBrokerReconciliationService for future wiring (a polling loop /
 * @Interval trigger is a later slice, not implemented here).
 */
import { Module } from '@nestjs/common';
import { RealBrokerReconciliationService } from './real-broker-reconciliation.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ProvidersModule } from '../providers/providers.module';

@Module({
  imports: [PrismaModule, ProvidersModule],
  providers: [RealBrokerReconciliationService],
  exports: [RealBrokerReconciliationService],
})
export class RealReconciliationModule {}
