import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { TotpRequiredGuard } from '../auth/guards/totp-required.guard';
import { RegistryService } from './registry.service';

/** Endpoints del catálogo de plugins: listado, detalle, instalación directa y estadísticas. */
@ApiTags('registry')
@ApiBearerAuth()
@UseGuards(TotpRequiredGuard)
@Controller('registry')
export class RegistryController {
  constructor(private readonly registry: RegistryService) {}

  @Get()
  @ApiOperation({ summary: 'Catálogo de plugins de la tienda con estado de instalación local' })
  @ApiQuery({ name: 'type', required: false })
  @ApiQuery({ name: 'tag', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'verified_only', required: false, type: Boolean })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  list(
    @Query('type') type?: string,
    @Query('tag') tag?: string,
    @Query('search') search?: string,
    @Query('verified_only') verifiedOnly?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.registry.listCatalog({
      type,
      tag,
      search,
      verified_only: verifiedOnly === 'true',
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get('stats')
  @ApiOperation({ summary: 'Estadísticas del catálogo de la tienda' })
  stats() {
    return this.registry.catalogStats();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle de un plugin de la tienda' })
  findOne(@Param('id') id: string) {
    return this.registry.getCatalogPlugin(id);
  }

  @Post(':id/install')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Instalar un plugin de la tienda via git clone',
    description:
      'Obtiene el repositorio git del plugin desde la tienda y lo clona localmente. ' +
      'El publisher debe haber declarado [plugin].repository en su manifest.toml. ' +
      'El plugin queda inactivo hasta que se active via PATCH /plugins/:id/activate.',
  })
  install(@Param('id') id: string) {
    return this.registry.installFromCatalog(id);
  }
}
