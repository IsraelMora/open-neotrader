import { Module } from '@nestjs/common';
import { StoreController } from './store.controller';
import { StoreService } from './store.service';
import { KvService } from '../common/kv.service';

@Module({
  controllers: [StoreController],
  providers: [StoreService, KvService],
  exports: [StoreService],
})
export class StoreModule {}
