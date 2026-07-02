import { Module } from '@nestjs/common';
import { TradeIntentService } from './trade-intent.service';
import { TradeIntentController } from './trade-intent.controller';
import { ExecutionController } from './execution.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { ProvidersModule } from '../providers/providers.module';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { KvService } from '../common/kv.service';

@Module({
  imports: [
    PrismaModule,
    ProvidersModule,
    // AuthModule exports TotpRequiredGuard used in TradeIntentController
    AuthModule,
    // AuditModule exports AuditService — records walk-forward gate real→paper demotions
    AuditModule,
  ],
  providers: [TradeIntentService, KvService],
  controllers: [TradeIntentController, ExecutionController],
  exports: [TradeIntentService],
})
export class TradeIntentModule {}
