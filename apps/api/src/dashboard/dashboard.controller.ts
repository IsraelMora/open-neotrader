import { Controller, Get, Query, ParseIntPipe, DefaultValuePipe } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { DashboardService } from './dashboard.service';

@ApiTags('dashboard')
@ApiBearerAuth()
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly svc: DashboardService) {}

  /**
   * Endpoint principal del dashboard — toda la información en una sola llamada.
   * El frontend hace UNA request y tiene lo necesario para renderizar
   * las tarjetas de resumen, la gráfica de equity y las tablas de stats.
   */
  @Get()
  @ApiOperation({
    summary:
      'Dashboard completo: resumen financiero, equity curve, providers y estadísticas de plugins',
    description: [
      'Retorna en una sola respuesta:',
      '• summary: capital inicial, equity actual, P&L total $/%,  tiempo en ejecución, ciclos',
      '• equity_curve: serie temporal [{ts, equity, cash, pnl}] para la gráfica de línea',
      '• provider_stats: qué providers tienen más snapshots y P&L (comparativa de brokers)',
      '• plugin_stats: señales emitidas, aprobadas y errores por estrategia instalada',
    ].join('\n'),
  })
  @ApiQuery({
    name: 'curve_limit',
    required: false,
    description: 'Puntos de equity curve (default 90)',
  })
  getDashboard(@Query('curve_limit', new DefaultValuePipe(90), ParseIntPipe) curveLimit: number) {
    return this.svc.getDashboard(curveLimit);
  }

  /** Solo el resumen numérico — para tarjetas KPI. */
  @Get('summary')
  @ApiOperation({ summary: 'Solo las métricas resumen (KPIs): equity, P&L, tiempo, ciclos' })
  summary() {
    return this.svc.getDashboard(0).then((d) => d.summary);
  }

  /** Solo la serie temporal para la gráfica de equity. */
  @Get('equity-curve')
  @ApiOperation({ summary: 'Serie temporal de equity para la gráfica de línea' })
  @ApiQuery({ name: 'limit', required: false })
  equityCurve(@Query('limit', new DefaultValuePipe(252), ParseIntPipe) limit: number) {
    return this.svc.getDashboard(limit).then((d) => d.equity_curve);
  }

  /** Comparativa de providers: cuál genera más P&L. */
  @Get('providers')
  @ApiOperation({ summary: 'Comparativa de providers: P&L, snapshots, retorno % por broker' })
  providers() {
    return this.svc.getDashboard(0).then((d) => d.provider_stats);
  }

  /** Estadísticas de plugins/estrategias instaladas. */
  @Get('plugins')
  @ApiOperation({ summary: 'Estadísticas de estrategias: señales, ciclos participados, errores' })
  pluginStats() {
    return this.svc.getDashboard(0).then((d) => d.plugin_stats);
  }
}
