import { Module } from '@nestjs/common';
import { BacktestController } from './backtest.controller';
import { BacktestService } from './backtest.service';
import { SandboxModule } from '../sandbox/sandbox.module';
import { ProvidersModule } from '../providers/providers.module';

@Module({
  imports: [SandboxModule, ProvidersModule],
  controllers: [BacktestController],
  providers: [BacktestService],
})
export class BacktestModule {}
