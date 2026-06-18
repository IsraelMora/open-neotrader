import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SignatureGuard } from '../auth/signature.guard';
import { Publisher } from '../auth/publisher.decorator';
import { PluginsService } from './plugins.service';
import { PublishDto } from './dto/publish.dto';

/** Controlador REST para el catálogo de plugins (`/api/plugins`). */
@Controller('plugins')
export class PluginsController {
  constructor(private readonly plugins: PluginsService) {}

  /**
   * Lista plugins con soporte de filtrado, búsqueda por texto y paginación.
   *
   * @param type     - Filtra por tipo de plugin (ej. `skill`, `preset`).
   * @param q        - Búsqueda de texto libre en nombre y descripción.
   * @param sort     - Criterio de orden: `recent` (actualización) o por defecto creación.
   * @param page     - Página solicitada (base 1).
   * @param pageSize - Elementos por página (máximo 100, por defecto 20).
   */
  @Get()
  list(
    @Query('type') type?: string,
    @Query('q') q?: string,
    @Query('sort') sort?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.plugins.list({
      type,
      q,
      sort,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  /**
   * Descarga el payload y el manifiesto TOML de una versión concreta de un plugin.
   *
   * @param p - Identificador del publisher.
   * @param m - Identificador del manifiesto del plugin.
   * @param v - Versión solicitada.
   */
  @Get(':publisherId/:manifestId/:version/download')
  download(
    @Param('publisherId') p: string,
    @Param('manifestId') m: string,
    @Param('version') v: string,
  ) {
    return this.plugins.download(p, m, v);
  }

  /**
   * Devuelve el detalle de un plugin incluyendo versiones y contadores de votos/reportes.
   *
   * @param p - Identificador del publisher.
   * @param m - Identificador del manifiesto del plugin.
   */
  @Get(':publisherId/:manifestId')
  detail(@Param('publisherId') p: string, @Param('manifestId') m: string) {
    return this.plugins.detail(p, m);
  }

  /**
   * Publica o actualiza un plugin. Requiere firma válida en las cabeceras.
   *
   * @param pub - Publisher autenticado extraído por `@Publisher()`.
   * @param dto - Cuerpo con el manifiesto TOML y el payload en base64.
   */
  @Post()
  @UseGuards(SignatureGuard)
  async publish(
    @Publisher() pub: { id: string; publicKey: string },
    @Body() dto: PublishDto,
  ) {
    return this.plugins.publish(
      pub.id,
      pub.publicKey,
      dto.manifestToml,
      dto.payloadBase64,
    );
  }
}
