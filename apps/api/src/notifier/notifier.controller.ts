import { Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { TelegramService } from './telegram.service';

@ApiTags('notifier')
@Controller('notifier')
export class NotifierController {
  constructor(private readonly telegram: TelegramService) {}

  @Post('telegram/test')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Envía un mensaje de prueba a Telegram para verificar la configuración',
  })
  async testTelegram() {
    return this.telegram.sendTest();
  }
}
