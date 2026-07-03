/**
 * VetoAnalyzerModule — read-side counterfactual analyzer for the veto decision ledger.
 *
 * Imports PrismaModule (direct Prisma access, no repository layer) and ProvidersModule
 * (for ProviderGatewayService.getOhlcv), mirroring BacktestModule's composition. Also
 * provides its own KvService (PrismaModule-backed) so VetoAnalyzerService's automatic
 * backfill scheduler can read its KV-configured interval, the same way
 * RealReconciliationModule provides KvService directly rather than via a shared module.
 */
import { Module } from '@nestjs/common';
import { VetoAnalyzerService } from './veto-analyzer.service';
import { VetoAnalyzerController } from './veto-analyzer.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { ProvidersModule } from '../providers/providers.module';
import { KvService } from '../common/kv.service';

@Module({
  imports: [PrismaModule, ProvidersModule],
  controllers: [VetoAnalyzerController],
  providers: [VetoAnalyzerService, KvService],
  exports: [VetoAnalyzerService],
})
export class VetoAnalyzerModule {}
