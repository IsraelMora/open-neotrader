import { Controller, Get, Post, Query, ParseIntPipe, DefaultValuePipe } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { SnapshotService } from './snapshot.service';

/** Endpoints de consulta de snapshots NAV: lista paginada, detalle y estadísticas por provider. */
@ApiTags('snapshot')
@ApiBearerAuth()
@Controller('snapshot')
export class SnapshotController {
  constructor(private readonly svc: SnapshotService) {}

  @Post()
  @ApiOperation({ summary: 'Tomar un snapshot del NAV actual desde el provider activo' })
  take() {
    return this.svc.takeSnapshot();
  }

  @Get('history')
  @ApiOperation({ summary: 'Historial de NAV (equity curve)' })
  @ApiQuery({ name: 'limit', required: false, description: 'Máx. entradas (default 90)' })
  history(@Query('limit', new DefaultValuePipe(90), ParseIntPipe) limit: number) {
    return this.svc.getHistory(limit);
  }

  @Get('latest')
  @ApiOperation({ summary: 'Snapshot más reciente' })
  latest() {
    return this.svc.getLatest();
  }

  @Get('equity-curve')
  @ApiOperation({ summary: 'Equity curve como [{ts, equity}] para gráficos' })
  @ApiQuery({ name: 'limit', required: false })
  equityCurve(@Query('limit', new DefaultValuePipe(252), ParseIntPipe) limit: number) {
    return this.svc.getEquityCurve(limit);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Estadísticas del NAV histórico (retorno total, fechas)' })
  stats() {
    return this.svc.stats();
  }
}
