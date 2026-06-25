import { Body, Controller, Get, HttpCode, HttpStatus, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsArray, IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { KvService } from '../common/kv.service';

/**
 * Operator config for the agent cycle's market-data inputs. Makes the universe,
 * data provider, timeframe, bar count and capital CONFIGURABLE instead of baked
 * into code — the service only keeps sane fallbacks when these are unset.
 */
class UpdateCycleConfigDto {
  @IsOptional() @IsArray() @IsString({ each: true }) universe?: string[];
  @IsOptional() @IsString() data_provider?: string;
  @IsOptional() @IsString() timeframe?: string;
  @IsOptional() @IsInt() @Min(10) bars?: number;
  @IsOptional() @IsNumber() @Min(0) capital?: number;
}

@ApiTags('cycle')
@ApiBearerAuth()
@Controller('cycle')
export class CycleConfigController {
  constructor(private readonly kv: KvService) {}

  @Get('config')
  @ApiOperation({ summary: 'Config del ciclo (universo, data provider, timeframe, bars, capital)' })
  async getConfig() {
    return {
      universe: (await this.kv.get('cycle.universe')) ?? '',
      data_provider: (await this.kv.get('cycle.data_provider')) ?? '',
      timeframe: (await this.kv.get('cycle.timeframe')) ?? '',
      bars: (await this.kv.get('cycle.bars')) ?? '',
      capital: (await this.kv.get('cycle.capital')) ?? '',
    };
  }

  @Patch('config')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Actualiza la config del ciclo (solo los campos enviados)' })
  async setConfig(@Body() dto: UpdateCycleConfigDto) {
    if (dto.universe !== undefined)
      await this.kv.set('cycle.universe', dto.universe.map((s) => s.trim().toUpperCase()).join(','));
    if (dto.data_provider !== undefined) await this.kv.set('cycle.data_provider', dto.data_provider);
    if (dto.timeframe !== undefined) await this.kv.set('cycle.timeframe', dto.timeframe);
    if (dto.bars !== undefined) await this.kv.set('cycle.bars', String(dto.bars));
    if (dto.capital !== undefined) await this.kv.set('cycle.capital', String(dto.capital));
    return this.getConfig();
  }
}
