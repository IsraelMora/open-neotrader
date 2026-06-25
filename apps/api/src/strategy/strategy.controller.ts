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
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { StrategyService } from './strategy.service';
import { CreateStrategyDto, UpdateStrategyDto, SetActiveDto } from './dto/strategy.dto';

/** Gestión de estrategias: perfiles nombrados de configuración del ciclo que compiten en paper. */
@ApiTags('strategies')
@ApiBearerAuth()
@Controller('strategies')
export class StrategyController {
  constructor(private readonly svc: StrategyService) {}

  @Get()
  @ApiOperation({ summary: 'Lista todas las estrategias' })
  list() {
    return this.svc.list();
  }

  /** Config actual del ciclo (para crear una estrategia desde la configuración vigente). */
  @Get('config/current')
  @ApiOperation({ summary: 'Snapshot de la configuración actual del ciclo' })
  currentConfig() {
    return this.svc.captureCurrentConfig();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle de una estrategia' })
  get(@Param('id') id: string) {
    return this.svc.get(id);
  }

  @Post()
  @ApiOperation({ summary: 'Crea una estrategia (captura la config actual si no se pasa)' })
  create(@Body() dto: CreateStrategyDto) {
    return this.svc.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Actualiza nombre/descripción/config/modo de una estrategia' })
  update(@Param('id') id: string, @Body() dto: UpdateStrategyDto) {
    return this.svc.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Elimina una estrategia' })
  remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }

  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Activa/desactiva la participación de la estrategia en la competencia' })
  setActive(@Param('id') id: string, @Body() dto: SetActiveDto) {
    return this.svc.setActive(id, dto.active);
  }

  @Post(':id/apply')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Aplica la config de la estrategia al ciclo activo (KV global)' })
  apply(@Param('id') id: string) {
    return this.svc.apply(id);
  }
}
