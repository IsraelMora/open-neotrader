import { Module } from '@nestjs/common';
import { LlmService } from './llm.service';
import { LlmController } from './llm.controller';
import { PluginsModule } from '../plugins/plugins.module';
import { KvService } from '../common/kv.service';

@Module({
  imports: [PluginsModule],
  providers: [LlmService, KvService],
  controllers: [LlmController],
  exports: [LlmService],
})
export class LlmModule {}
