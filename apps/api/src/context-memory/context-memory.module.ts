import { Module } from '@nestjs/common';
import { ContextMemoryService } from './context-memory.service';
import { ContextMemoryController } from './context-memory.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { KvService } from '../common/kv.service';
import { TotpRequiredGuard } from '../auth/guards/totp-required.guard';

@Module({
  imports: [PrismaModule],
  controllers: [ContextMemoryController],
  providers: [ContextMemoryService, KvService, TotpRequiredGuard],
  exports: [ContextMemoryService],
})
export class ContextMemoryModule {}
