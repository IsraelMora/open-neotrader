import { Module } from '@nestjs/common';
import { StrategyBootstrapService } from './strategy-bootstrap.service';
import { PrismaModule } from '../prisma/prisma.module';
import { KvService } from '../common/kv.service';
import { LlmModule } from '../llm/llm.module';

/**
 * Runs the idempotent PAPER-mode momentum-rotation bootstrap on application boot.
 * See StrategyBootstrapService for the full rationale and safety boundaries.
 */
@Module({
  imports: [PrismaModule, LlmModule],
  providers: [StrategyBootstrapService, KvService],
  exports: [StrategyBootstrapService],
})
export class StrategyBootstrapModule {}
