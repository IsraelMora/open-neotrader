import {
  Controller,
  DefaultValuePipe,
  Get,
  ParseIntPipe,
  Post,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { TotpRequiredGuard } from '../auth/guards/totp-required.guard';
import { PanelService } from './panel.service';
import { RunCycleDto } from './dto/run-cycle.dto';
import { ChatDto } from './dto/chat.dto';
import { UniverseEditDto } from './dto/universe-edit.dto';

@ApiTags('panel')
@ApiBearerAuth()
@Controller()
export class PanelController {
  constructor(private readonly svc: PanelService) {}

  // ── Sistema ──────────────────────────────────────────────────────────────

  @Public()
  @Get('doctor')
  @ApiOperation({ summary: 'Diagnóstico: sandbox, plugins, estado general' })
  doctor() {
    return this.svc.doctor();
  }

  @Get('status')
  @ApiOperation({ summary: 'Estado del agente y plugins activos' })
  status() {
    return this.svc.getStatus();
  }

  @Get('run-status')
  @ApiOperation({ summary: '¿Hay un ciclo en ejecución ahora mismo?' })
  runStatus() {
    return this.svc.getRunStatus();
  }

  // ── Config ────────────────────────────────────────────────────────────────

  @Get('config')
  @ApiOperation({ summary: 'Leer toda la configuración (key-value store)' })
  getConfig() {
    return this.svc.getConfig();
  }

  @UseGuards(TotpRequiredGuard)
  @Post('config')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Guardar entradas en el config store' })
  saveConfig(@Body() cfg: Record<string, unknown>) {
    return this.svc.saveConfig(cfg);
  }

  @UseGuards(TotpRequiredGuard)
  @Delete('config/:key')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Eliminar una clave del config store' })
  deleteConfig(@Param('key') key: string) {
    return this.svc.deleteConfigKey(key);
  }

  // ── Ciclo del agente ──────────────────────────────────────────────────────

  @UseGuards(TotpRequiredGuard)
  @Post('run-cycle')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Lanzar un ciclo (dry_run o real). El prompt es opcional — lo pueden proporcionar los plugins.',
  })
  runCycle(@Body() dto: RunCycleDto) {
    return this.svc.runCycle(dto.dry_run ?? false, dto.prompt);
  }

  // ── Chat ──────────────────────────────────────────────────────────────────

  @UseGuards(TotpRequiredGuard)
  @Post('chat')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Conversación libre con el LLM + skills activos' })
  chat(@Body() dto: ChatDto) {
    return this.svc.chat(dto.question, dto.history);
  }

  // ── Portfolios ────────────────────────────────────────────────────────────

  @Get('portfolios')
  @ApiOperation({ summary: 'Portfolios registrados por plugins (clave libre)' })
  portfolios() {
    return this.svc.getPortfolios();
  }

  // ── Skills ────────────────────────────────────────────────────────────────

  @Get('skills')
  @ApiOperation({ summary: 'Metadatos de skills activos (desde SKILL.md de cada plugin)' })
  skills() {
    return this.svc.getSkills();
  }

  // ── Universo de activos ───────────────────────────────────────────────────

  @Get('universe/check')
  @ApiOperation({ summary: 'Consultar si un símbolo está en el universo registrado' })
  universeCheck(@Query('symbol') symbol: string) {
    return this.svc.checkUniverseSymbol(symbol);
  }

  @Post('universe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Añadir o quitar símbolo del universo. kind es libre — lo interpreta el plugin provider.',
  })
  universeEdit(@Body() dto: UniverseEditDto) {
    return this.svc.editUniverse(dto);
  }

  // ── Logs (streams libres) ─────────────────────────────────────────────────

  @Get('logs/:stream')
  @ApiOperation({
    summary: 'Últimas N entradas de un stream de log. Los plugins definen los streams que usan.',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  logs(
    @Param('stream') stream: string,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit: number,
  ) {
    return this.svc.getLogs(stream, limit);
  }

  // ── Métricas genéricas ────────────────────────────────────────────────────

  @Get('metrics/:key')
  @ApiOperation({
    summary: 'Leer una métrica del config store por clave. Los plugins escriben sus métricas aquí.',
  })
  metrics(@Param('key') key: string) {
    return this.svc.getMetrics(key);
  }

  // ── Plugins por tipo ──────────────────────────────────────────────────────

  @Get('plugins-by-type/:type')
  @ApiOperation({
    summary:
      'Plugins activos filtrados por tipo (skill, provider, discipline, universe, stack, extra)',
  })
  pluginsByType(@Param('type') type: string) {
    return this.svc.getActiveByType(type);
  }

  // ── Notificaciones ────────────────────────────────────────────────────────

  @Get('notifications')
  @ApiOperation({ summary: 'Notificaciones del sistema y de plugins activos' })
  notifications() {
    return this.svc.getNotifications();
  }
}
