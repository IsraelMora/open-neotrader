import { Module } from '@nestjs/common';
import { PluginsService } from './plugins.service';
import { PluginsController } from './plugins.controller';
import { PluginEventsService } from './plugin-events.service';
import { LifecycleService } from './lifecycle.service';
import { PluginWatcherService } from './plugin-watcher.service';
import { SandboxModule } from '../sandbox/sandbox.module';
import { KvService } from '../common/kv.service';
import { AuditModule } from '../audit/audit.module';
import { TotpRequiredGuard } from '../auth/guards/totp-required.guard';

@Module({
  imports: [SandboxModule, AuditModule],
  providers: [
    PluginsService,
    PluginEventsService,
    LifecycleService,
    PluginWatcherService,
    KvService,
    TotpRequiredGuard,
  ],
  controllers: [PluginsController],
  exports: [PluginsService, PluginEventsService],
})
export class PluginsModule {}
