import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  HttpException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { PluginsService } from './plugins.service';
import type { HydratedPlugin, PluginVerification, WriteSkillResult } from './plugins.service';
import { InstallPluginDto } from './dto/install-plugin.dto';
import { TotpRequiredGuard } from '../auth/guards/totp-required.guard';

/** Endpoints CRUD de plugins: instalación, activación, config, tools, skills y verificación. */
@ApiTags('plugins')
@ApiBearerAuth()
@Controller('plugins')
export class PluginsController {
  constructor(private readonly svc: PluginsService) {}

  @Get()
  @ApiOperation({ summary: 'Listar todos los plugins instalados' })
  async findAll(): Promise<{ plugins: HydratedPlugin[] }> {
    return { plugins: await this.svc.findAll() };
  }

  @Get('skills')
  @ApiOperation({ summary: 'Metadatos de skills activos (name + description desde SKILL.md)' })
  skills() {
    return this.svc.getSkillsMetadata();
  }

  @Get('tools')
  @ApiOperation({
    summary: 'Todos los tools declarados por plugins activos (tools.json de cada uno)',
  })
  allTools() {
    return this.svc.getProviderTools();
  }

  @Get('symbols')
  @ApiOperation({ summary: 'Símbolos del universo activo' })
  symbols(): Promise<string[]> {
    return this.svc.getActiveSymbols();
  }

  @Post('sync')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reescanea el directorio local de plugins y los registra en la BD (sin activarlos)',
  })
  sync(): Promise<{ registered: number; updated: number }> {
    return this.svc.syncLocalPlugins();
  }

  @Post('install')
  @ApiOperation({ summary: 'Instalar plugin desde URL git o ruta local' })
  install(@Body() dto: InstallPluginDto): Promise<HydratedPlugin> {
    return this.svc.install(dto.source);
  }

  @Get(':id')
  findOne(@Param('id') id: string): Promise<HydratedPlugin> {
    return this.svc.findById(id);
  }

  @Post(':id/activate')
  @ApiOperation({ summary: 'Activar plugin' })
  activate(@Param('id') id: string): Promise<HydratedPlugin> {
    return this.svc.activate(id);
  }

  @Post(':id/deactivate')
  @ApiOperation({ summary: 'Desactivar plugin' })
  deactivate(@Param('id') id: string): Promise<HydratedPlugin> {
    return this.svc.deactivate(id);
  }

  @Post(':id/update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Actualizar plugin (git pull)' })
  update(@Param('id') id: string): Promise<{ ok: boolean; output: string }> {
    return this.svc.update(id);
  }

  @Post(':id/config')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Guardar configuración de un plugin' })
  setConfig(
    @Param('id') id: string,
    @Body('config') config: Record<string, unknown>,
  ): Promise<HydratedPlugin> {
    return this.svc.setConfig(id, config);
  }

  @Patch(':id/verification')
  @ApiOperation({ summary: 'Cambiar estado de verificación' })
  verify(
    @Param('id') id: string,
    @Body('status') status: PluginVerification,
  ): Promise<HydratedPlugin> {
    return this.svc.updateVerification(id, status);
  }

  @Get(':id/schema')
  @ApiOperation({
    summary:
      'Config schema del plugin (JSON Schema) — el frontend lo usa para generar el formulario',
  })
  schema(@Param('id') id: string) {
    return this.svc.getConfigSchema(id);
  }

  @Patch(':id/config')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Actualizar config parcialmente (merge — no reemplaza campos no enviados)',
  })
  patchConfig(
    @Param('id') id: string,
    @Body('config') config: Record<string, unknown>,
  ): Promise<HydratedPlugin> {
    return this.svc.mergeConfig(id, config);
  }

  @Get(':id/tools')
  @ApiOperation({ summary: 'Tools declaradas por el plugin (tools.json)' })
  tools(@Param('id') id: string) {
    return this.svc.getPluginTools(id);
  }

  @Get(':id/credentials')
  @ApiOperation({ summary: 'Credenciales requeridas por el plugin (de manifest.toml)' })
  credentials(@Param('id') id: string) {
    return this.svc.getCredentialSpecs(id);
  }

  @Get(':id/manifest')
  @ApiOperation({ summary: 'Manifest completo del plugin (manifest.toml parseado)' })
  async manifest(@Param('id') id: string) {
    const p = await this.svc.findById(id);
    return this.svc.getManifest(p.installed_path);
  }

  @UseGuards(TotpRequiredGuard)
  @Post(':id/skill')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Guarded write of SKILL.md body (requires llm_writable:true in manifest)',
  })
  async writeSkill(
    @Param('id') id: string,
    @Body() body: { new_body: string },
  ): Promise<WriteSkillResult> {
    const plugin = await this.svc.findById(id);
    const result = await this.svc.writeSkillGuarded(plugin.name, body.new_body);
    if (!result.ok) {
      throw new HttpException({ ok: false, reason: result.reason }, HttpStatus.BAD_REQUEST);
    }
    return result;
  }

  @UseGuards(TotpRequiredGuard)
  @Post(':id/revert-skill')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revert SKILL.md to most recent KV snapshot' })
  async revertSkill(@Param('id') id: string): Promise<{ ok: boolean; reason?: string }> {
    const plugin = await this.svc.findById(id);
    const result = await this.svc.revertSkill(plugin.name);
    if (!result.ok) {
      throw new HttpException({ ok: false, reason: result.reason }, HttpStatus.BAD_REQUEST);
    }
    return result;
  }

  @Post(':id/scan')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'F3-s1: Re-run static AST analysis for a plugin (manual rescan)' })
  scan(@Param('id') id: string) {
    return this.svc.rescan(id);
  }

  @Get(':id/trust-report')
  @ApiOperation({
    summary:
      'F3-s1/s2/s3: Get current trust report (scan_result, smoke_test_result, reputation_score) for a plugin',
  })
  trustReport(@Param('id') id: string) {
    return this.svc.getTrustReport(id);
  }

  @Get(':id/reputation')
  @ApiOperation({ summary: 'F3-s3: Get persisted reputation score for a plugin (null = unrated)' })
  reputation(@Param('id') id: string) {
    return this.svc.getReputation(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Desinstalar plugin' })
  remove(@Param('id') id: string): Promise<void> {
    return this.svc.remove(id);
  }
}
