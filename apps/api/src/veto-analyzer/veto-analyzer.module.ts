/**
 * VetoAnalyzerModule — read-side counterfactual analyzer for the veto decision ledger.
 *
 * Imports PrismaModule (direct Prisma access, no repository layer) and ProvidersModule
 * (for ProviderGatewayService.getOhlcv), mirroring BacktestModule's composition.
 */
import { Module } from '@nestjs/common';
import { VetoAnalyzerService } from './veto-analyzer.service';
import { VetoAnalyzerController } from './veto-analyzer.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { ProvidersModule } from '../providers/providers.module';

@Module({
  imports: [PrismaModule, ProvidersModule],
  controllers: [VetoAnalyzerController],
  providers: [VetoAnalyzerService],
  exports: [VetoAnalyzerService],
})
export class VetoAnalyzerModule {}
