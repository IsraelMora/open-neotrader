import { Module } from '@nestjs/common';
import { NotifierController } from './notifier.controller';
import { TelegramService } from './telegram.service';
import { PluginsModule } from '../plugins/plugins.module';

@Module({
  imports: [PluginsModule],
  controllers: [NotifierController],
  providers: [TelegramService],
  exports: [TelegramService],
})
export class NotifierModule {}
