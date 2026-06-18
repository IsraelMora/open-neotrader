import { Module } from '@nestjs/common';
import { WsGateway } from './ws.gateway';
import { LlmModule } from '../llm/llm.module';
import { PluginsModule } from '../plugins/plugins.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [LlmModule, PluginsModule, AuthModule],
  providers: [WsGateway],
})
export class WsModule {}
