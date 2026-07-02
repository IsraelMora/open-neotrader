/**
 * RealOrderModule — real-money order lifecycle tracking.
 *
 * Leaf module: imports PrismaModule + ProvidersModule (for ProviderGatewayService).
 * Consumed by TradeIntentModule — _executeReal delegates real order submission to
 * RealOrderService.submit (idempotent, crash-safe). Exported for that DI wiring.
 */
import { Module } from '@nestjs/common';
import { RealOrderService } from './real-order.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ProvidersModule } from '../providers/providers.module';

@Module({
  imports: [PrismaModule, ProvidersModule],
  providers: [RealOrderService],
  exports: [RealOrderService],
})
export class RealOrderModule {}
