import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { ApiOperation, ApiTags, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { AlertsService } from './alerts.service';

@ApiTags('alerts')
@ApiBearerAuth()
@Controller('alerts')
export class AlertsController {
  constructor(private readonly svc: AlertsService) {}

  @Get()
  @ApiOperation({ summary: 'Alertas recientes' })
  @ApiQuery({ name: 'limit', required: false })
  recent(@Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number) {
    return this.svc.getRecent(limit);
  }

  @Get('active')
  @ApiOperation({ summary: 'Alertas activas (no resueltas)' })
  active() {
    return this.svc.getActive();
  }

  @Get('stats')
  @ApiOperation({ summary: 'Estadísticas de alertas por tipo' })
  stats() {
    return this.svc.stats();
  }

  @Post(':id/resolve')
  @ApiOperation({ summary: 'Marcar una alerta como resuelta' })
  resolve(@Param('id') id: string) {
    return this.svc.resolve(id);
  }

  @Post('resolve-all')
  @ApiOperation({ summary: 'Resolver todas las alertas activas' })
  resolveAll() {
    return this.svc.resolveAll();
  }
}
