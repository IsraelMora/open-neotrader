import { Module } from '@nestjs/common';
import { TradeIntentService } from './trade-intent.service';
import { TradeIntentController } from './trade-intent.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { ProvidersModule } from '../providers/providers.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    PrismaModule,
    ProvidersModule,
    // AuthModule exports TotpRequiredGuard used in TradeIntentController
    AuthModule,
  ],
  providers: [TradeIntentService],
  controllers: [TradeIntentController],
  exports: [TradeIntentService],
})
export class TradeIntentModule {}
