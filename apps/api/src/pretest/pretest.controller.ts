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
  UseGuards,
  ConflictException,
} from '@nestjs/common';
import { ApiOperation, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsNumber,
  IsArray,
  IsBoolean,
  MinLength,
  MaxLength,
  Min,
  IsObject,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PretestService } from './pretest.service';
import { TotpRequiredGuard } from '../auth/guards/totp-required.guard';

class CreatePretestDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  description?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  initial_capital?: number;

  @IsArray()
  @IsString({ each: true })
  plugin_ids!: string[];

  @IsOptional()
  @IsObject()
  plugin_configs?: Record<string, Record<string, unknown>>;
}

class UpdatePretestDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  description?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  plugin_ids?: string[];

  @IsOptional()
  @IsObject()
  plugin_configs?: Record<string, Record<string, unknown>>;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

class RunCycleDto {
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  system_prompt?: string;
}

/** DTO for POST /pretest/:id/promote — operator confirm flag. */
class PromotePretestDto {
  @IsOptional()
  @IsBoolean()
  confirm?: boolean;
}

/** Endpoints de portfolios virtuales de pretest: CRUD, ejecución de ciclos y comparativa de rendimiento. */
@ApiTags('pretest')
@ApiBearerAuth()
@Controller('pretest')
export class PretestController {
  constructor(private readonly svc: PretestService) {}

  @Get()
  @ApiOperation({ summary: 'Listar todos los portfolios de pretest' })
  findAll() {
    return this.svc.findAll();
  }

  @Post()
  @ApiOperation({ summary: 'Crear nuevo portfolio de pretest con set de plugins y config propios' })
  create(@Body() dto: CreatePretestDto) {
    return this.svc.create(dto);
  }

  @Get('compare')
  @ApiOperation({ summary: 'Comparativa de rendimiento entre todos los portfolios de pretest' })
  compare() {
    return this.svc.compare();
  }

  @Post('run-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Ejecutar un ciclo en TODOS los portfolios activos (evaluación en paralelo)',
  })
  runAll() {
    return this.svc.runAllActive();
  }

  @Get(':id/gate')
  @ApiOperation({ summary: 'Evaluate significance gate for a pretest portfolio (read-only)' })
  getGate(@Param('id') id: string) {
    return this.svc.gate(id);
  }

  @Post(':id/gate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Evaluate significance gate for a pretest portfolio' })
  postGate(@Param('id') id: string) {
    return this.svc.gate(id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener un portfolio de pretest por ID' })
  findOne(@Param('id') id: string) {
    return this.svc.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Actualizar plugins, config o nombre del pretest' })
  update(@Param('id') id: string, @Body() dto: UpdatePretestDto) {
    return this.svc.update(id, dto);
  }

  @Post(':id/run')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ejecutar un ciclo de pretest para este portfolio virtual' })
  runCycle(@Param('id') id: string, @Body() dto: RunCycleDto) {
    return this.svc.runCycle(id, dto.system_prompt);
  }

  @Post(':id/reset')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reiniciar el estado del portfolio (mantiene plugins y config)' })
  reset(@Param('id') id: string) {
    return this.svc.reset(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Eliminar un portfolio de pretest' })
  delete(@Param('id') id: string) {
    return this.svc.delete(id);
  }

  /**
   * Promotes a gate-ready pretest portfolio to live.
   * Requires TOTP second factor — this operation activates real trading plugins.
   *
   * Response:
   *  - 409 ConflictException: gate not ready (state precondition not met).
   *  - 200 {ok:false, reason:'needs_confirmation', pending}: human confirm required.
   *  - 200 {ok:true, applied, failed}: promotion applied (partial or full).
   */
  @Post(':id/promote')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TotpRequiredGuard)
  @ApiOperation({ summary: 'Promote a gate-ready pretest portfolio to live (requires TOTP)' })
  async promote(@Param('id') id: string, @Body() dto: PromotePretestDto) {
    const result = await this.svc.promote(id, { confirm: dto.confirm });
    if (result.reason === 'gate_not_ready') {
      throw new ConflictException(result);
    }
    return result;
  }
}
