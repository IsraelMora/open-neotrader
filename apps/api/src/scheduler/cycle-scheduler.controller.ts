import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CycleSchedulerService } from './cycle-scheduler.service';

class SchedulerConfigDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  /**
   * Override manual del intervalo en ms.
   * null → usar el de los plugins activos (automático).
   * Número → forzar este intervalo.
   */
  @IsOptional()
  @ValidateIf((o: SchedulerConfigDto) => o.override_interval_ms !== null)
  @IsInt()
  @Min(60_000)
  @Max(7 * 24 * 3_600_000)
  @Type(() => Number)
  override_interval_ms?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  prompt?: string;
}

class RunNowDto {
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  prompt?: string;
}

@ApiTags('scheduler')
@Controller('scheduler')
export class CycleSchedulerController {
  constructor(private readonly scheduler: CycleSchedulerService) {}

  @Get('status')
  @ApiOperation({
    summary: 'Estado completo del scheduler',
    description:
      'Muestra el intervalo efectivo calculado desde los plugins activos, el override manual, y cuándo es el próximo ciclo.',
  })
  async status() {
    return this.scheduler.getStatus();
  }

  @Patch('config')
  @ApiOperation({
    summary: 'Configura el scheduler',
    description:
      'override_interval_ms=null → modo automático (lee frecuencia de manifest.toml de plugins activos). Un número fuerza ese intervalo manualmente.',
  })
  async configure(@Body() dto: SchedulerConfigDto) {
    return this.scheduler.updateConfig(dto);
  }

  @Post('run-now')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Dispara un ciclo inmediato' })
  async runNow(@Body() dto: RunNowDto) {
    await this.scheduler.runNow(dto.prompt);
    return { accepted: true };
  }

  @Get('circuit-breaker')
  @ApiOperation({ summary: 'Estado del circuit breaker (fallos consecutivos del LLM)' })
  async circuitBreaker() {
    return this.scheduler.getCircuitBreaker();
  }

  @Post('circuit-breaker/reset')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reinicia el circuit breaker manualmente' })
  async resetCb() {
    await this.scheduler.resetCircuitBreaker();
    return { ok: true };
  }
}
