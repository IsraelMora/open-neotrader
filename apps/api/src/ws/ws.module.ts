import { Module } from '@nestjs/common';
import { WsGateway } from './ws.gateway';
import { AgentsModule } from '../agents/agents.module';
import { PluginsModule } from '../plugins/plugins.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AgentsModule, PluginsModule, AuthModule],
  providers: [WsGateway],
})
export class WsModule {}
