import { Module } from '@nestjs/common';
import { PluginsService } from './plugins.service';
import { PluginsController } from './plugins.controller';
import { PluginEventsService } from './plugin-events.service';
import { LifecycleService } from './lifecycle.service';
import { PluginWatcherService } from './plugin-watcher.service';
import { SandboxModule } from '../sandbox/sandbox.module';

@Module({
  imports: [SandboxModule],
  providers: [PluginsService, PluginEventsService, LifecycleService, PluginWatcherService],
  controllers: [PluginsController],
  exports: [PluginsService, PluginEventsService],
})
export class PluginsModule {}
