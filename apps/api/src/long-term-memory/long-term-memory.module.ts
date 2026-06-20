/** F6-s2: LongTermMemoryModule — leaf module; imports only PrismaModule. */
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { LongTermMemoryService } from './long-term-memory.service';

@Module({
  imports: [PrismaModule],
  providers: [LongTermMemoryService],
  exports: [LongTermMemoryService],
})
export class LongTermMemoryModule {}
