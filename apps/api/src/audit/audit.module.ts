import { Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { PrismaModule } from '../prisma/prisma.module';
import { TotpRequiredGuard } from '../auth/guards/totp-required.guard';

@Module({
  imports: [PrismaModule],
  controllers: [AuditController],
  providers: [AuditService, TotpRequiredGuard],
  exports: [AuditService],
})
export class AuditModule {}
