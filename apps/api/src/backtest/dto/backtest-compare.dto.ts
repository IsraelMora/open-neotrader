import {
  IsArray,
  ArrayNotEmpty,
  IsString,
  IsNotEmpty,
  IsOptional,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';

/** Comparación de estrategias por backtest: corre cada una con el provider elegido. */
export class BacktestCompareDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  strategy_ids!: string[];

  /** Plugin de backtest a usar (default 'backtester'). */
  @IsOptional()
  @IsString()
  provider_id?: string;

  @IsOptional()
  @IsString()
  timeframe?: string;

  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(5000)
  @Type(() => Number)
  bars?: number;
}
