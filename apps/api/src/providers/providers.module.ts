import { Module } from '@nestjs/common';
import { ProviderGatewayService } from './provider-gateway.service';
import { ProviderGatewayController } from './provider-gateway.controller';
import { OhlcvCacheService } from './ohlcv-cache.service';

@Module({
  controllers: [ProviderGatewayController],
  providers: [ProviderGatewayService, OhlcvCacheService],
  exports: [ProviderGatewayService, OhlcvCacheService],
})
export class ProvidersModule {}
