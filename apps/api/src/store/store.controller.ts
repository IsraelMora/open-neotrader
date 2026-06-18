import { Controller, Get, Post, Body, Param, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { StoreService } from './store.service';

/** Endpoints proxy hacia la tienda remota: búsqueda, detalle, publicación, votos, reportes e identidad. */
@ApiTags('store')
@ApiBearerAuth()
@Controller('store')
export class StoreController {
  constructor(private readonly svc: StoreService) {}

  @Get('plugins')
  @ApiOperation({ summary: 'Explorar catálogo de la tienda' })
  browse(@Query() qs: Record<string, string>) {
    return this.svc.browse(qs);
  }

  @Get('plugins/:publisherId/:manifestId')
  @ApiOperation({ summary: 'Detalle de un plugin en la tienda' })
  detail(@Param('publisherId') publisherId: string, @Param('manifestId') manifestId: string) {
    return this.svc.detail(publisherId, manifestId);
  }

  @Post('install')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Instalar plugin desde la tienda' })
  install(@Body() body: { publisherId: string; manifestId: string; version: string }) {
    return this.svc.install(body.publisherId, body.manifestId, body.version);
  }

  @Post('publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Publicar un plugin en la tienda' })
  publish(@Body() body: { pluginId: string }) {
    return this.svc.publish(body.pluginId);
  }

  @Post('vote')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Votar por un plugin' })
  vote(@Body() body: { pluginId: string; kind: 'like' | 'dislike' }) {
    return this.svc.vote(body.pluginId, body.kind);
  }

  @Post('report')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reportar un plugin' })
  report(@Body() body: { pluginId: string; reason: string }) {
    return this.svc.report(body.pluginId, body.reason);
  }

  @Get('identity')
  @ApiOperation({ summary: 'Identidad pública del usuario en la tienda' })
  getIdentity() {
    return this.svc.getIdentity();
  }

  @Post('identity')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Actualizar nombre público en la tienda' })
  setIdentity(@Body() body: { display_name: string | null }) {
    return this.svc.setIdentity(body.display_name);
  }
}
