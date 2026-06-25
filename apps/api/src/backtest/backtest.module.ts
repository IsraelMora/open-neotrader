import { Module } from '@nestjs/common';
import { BacktestController } from './backtest.controller';
import { BacktestService } from './backtest.service';
import { SandboxModule } from '../sandbox/sandbox.module';
import { ProvidersModule } from '../providers/providers.module';
import { StrategyModule } from '../strategy/strategy.module';
import { PluginsModule } from '../plugins/plugins.module';

@Module({
  imports: [SandboxModule, ProvidersModule, StrategyModule, PluginsModule],
  controllers: [BacktestController],
  providers: [BacktestService],
})
export class BacktestModule {}
