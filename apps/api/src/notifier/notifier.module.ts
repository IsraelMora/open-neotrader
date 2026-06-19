import { Module } from '@nestjs/common';
import { NotifierController } from './notifier.controller';
import { TelegramService } from './telegram.service';
import { NotifierBridge } from './notifier-bridge';
import { PluginsModule } from '../plugins/plugins.module';

@Module({
  imports: [PluginsModule],
  controllers: [NotifierController],
  providers: [TelegramService, NotifierBridge],
  exports: [TelegramService, NotifierBridge],
})
export class NotifierModule {}
