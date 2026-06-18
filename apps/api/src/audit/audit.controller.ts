import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { IsDateString, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import type { FastifyReply } from 'fastify';
import { TotpRequiredGuard } from '../auth/guards/totp-required.guard';
import { AuditEventType, AuditService } from './audit.service';

class AuditQueryDto {
  @IsOptional()
  @IsString()
  event_type?: AuditEventType;

  @IsOptional()
  @IsString()
  plugin_id?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  @Type(() => Number)
  limit?: number;
}

/** Endpoints de consulta del log de auditoría: filtrado, exportación JSON-L y limpieza por antigüedad. */
@ApiTags('audit')
@ApiBearerAuth()
@UseGuards(TotpRequiredGuard)
@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @ApiOperation({ summary: 'Consultar el log de auditoría del agente' })
  @ApiQuery({ name: 'event_type', required: false })
  @ApiQuery({ name: 'plugin_id', required: false })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'limit', required: false })
  query(@Query() q: AuditQueryDto) {
    return this.audit.query({
      event_type: q.event_type,
      plugin_id: q.plugin_id,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
      limit: q.limit,
    });
  }

  @Get('stats')
  @ApiOperation({ summary: 'Estadísticas del log de auditoría' })
  stats() {
    return this.audit.stats();
  }

  @Get('export')
  @ApiOperation({
    summary: 'Exportar log de auditoría como JSON-L (newline-delimited JSON)',
    description:
      'Formato determinista, apto para versionar en git o procesar con jq. Máx 10,000 entradas.',
  })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'event_type', required: false })
  @ApiQuery({ name: 'plugin_id', required: false })
  async exportJsonL(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('event_type') event_type?: AuditEventType,
    @Query('plugin_id') plugin_id?: string,
    @Res() reply?: FastifyReply,
  ) {
    const data = await this.audit.exportJsonL({
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      event_type,
      plugin_id,
    });

    const ts = new Date().toISOString().slice(0, 10);
    reply!
      .header('Content-Type', 'application/x-ndjson')
      .header('Content-Disposition', `attachment; filename="audit-${ts}.jsonl"`)
      .send(data);
  }

  @Get('cycle/:id')
  @ApiOperation({ summary: 'Ver todos los eventos de un ciclo específico' })
  getCycle(@Param('id') id: string) {
    return this.audit.getCycleSummary(id);
  }

  @Delete('prune')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TotpRequiredGuard)
  @ApiOperation({
    summary: 'Eliminar entradas antiguas del log (requiere TOTP). Default: >90 días.',
  })
  @ApiQuery({ name: 'days', required: false, description: 'Retención en días (default 90)' })
  async prune(@Query('days') days?: string) {
    return this.audit.prune(days ? parseInt(days, 10) : 90);
  }
}
