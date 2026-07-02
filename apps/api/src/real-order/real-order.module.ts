/**
 * RealOrderModule — real-money order lifecycle tracking.
 *
 * Leaf module: imports PrismaModule + ProvidersModule (for ProviderGatewayService) and
 * provides its own KvService (R8: repeated submit_failed events trip the global
 * real-execution kill-switch, see real-execution-halt.util.ts), mirroring how other
 * feature modules provide KvService directly rather than via a shared CommonModule.
 * Consumed by TradeIntentModule — _executeReal delegates real order submission to
 * RealOrderService.submit (idempotent, crash-safe). Exported for that DI wiring.
 */
import { Module } from '@nestjs/common';
import { RealOrderService } from './real-order.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ProvidersModule } from '../providers/providers.module';
import { KvService } from '../common/kv.service';

@Module({
  imports: [PrismaModule, ProvidersModule],
  providers: [RealOrderService, KvService],
  exports: [RealOrderService],
})
export class RealOrderModule {}
