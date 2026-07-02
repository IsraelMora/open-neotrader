/**
 * RealOrderModule — real-money order lifecycle tracking.
 *
 * Leaf module: imports PrismaModule + ProvidersModule (for ProviderGatewayService).
 * Not wired into any caller yet — see real-order.service.ts class doc. Registered
 * here only so Nest DI resolves cleanly and the service is available for the next
 * slice (rewiring _executeReal in trade-intent.service.ts).
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
