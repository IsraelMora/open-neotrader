import { Module } from '@nestjs/common';
import { StrategyController } from './strategy.controller';
import { StrategyService } from './strategy.service';
import { KvService } from '../common/kv.service';
import { StoreModule } from '../store/store.module';

@Module({
  imports: [StoreModule],
  controllers: [StrategyController],
  providers: [StrategyService, KvService],
  exports: [StrategyService],
})
export class StrategyModule {}
