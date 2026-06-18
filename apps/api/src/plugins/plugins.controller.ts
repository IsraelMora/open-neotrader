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
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { PluginsService } from './plugins.service';
import type { HydratedPlugin, PluginVerification } from './plugins.service';
import { InstallPluginDto } from './dto/install-plugin.dto';

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

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Desinstalar plugin' })
  remove(@Param('id') id: string): Promise<void> {
    return this.svc.remove(id);
  }
}
