import { Module } from '@nestjs/common';
import { EventsGateway } from './events.gateway';
import { PluginsModule } from '../plugins/plugins.module';

@Module({
  imports: [PluginsModule],
  controllers: [EventsGateway],
})
export class EventsModule {}
