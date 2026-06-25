import {
  IsArray,
  ArrayNotEmpty,
  IsString,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  IsInt,
  IsObject,
  Min,
  Max,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Cross-sectional momentum portfolio backtest input. Unlike RunBacktestDto there is
 * NO `strategy` field — this route always runs the cross-sectional momentum engine
 * over the whole `symbols` universe.
 */
export class CrossSectionalDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  symbols!: string[];

  @IsOptional()
  @IsString()
  timeframe?: string = '1d';

  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(5000)
  @Type(() => Number)
  limit?: number = 1500;

  @IsOptional()
  @IsNumber()
  @Min(100)
  @Type(() => Number)
  capital?: number = 10000;

  @IsOptional()
  @ValidateIf((o: CrossSectionalDto) => o.provider_id !== null && o.provider_id !== undefined)
  @IsString()
  provider_id?: string | null = null;

  /** Number of top-momentum names to hold. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  @Type(() => Number)
  top_n?: number;

  /** Bars between rebalances (~21 = monthly). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(252)
  @Type(() => Number)
  rebalance_days?: number;

  /** Momentum lookback window in bars (~252 = 12 months). */
  @IsOptional()
  @IsInt()
  @Min(20)
  @Max(1000)
  @Type(() => Number)
  lookback?: number;

  /** Recent bars to skip (12-1 momentum → ~21). */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(60)
  @Type(() => Number)
  skip?: number;

  /** Commission charged on notional traded at each rebalance (0.001 = 0.1%). */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(0.1)
  @Type(() => Number)
  commission_pct?: number;

  /** Slippage charged on notional traded at each rebalance (0.0005 = 0.05%). */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(0.1)
  @Type(() => Number)
  slippage_pct?: number;

  /** Extra config overrides forwarded to the engine. */
  @IsOptional()
  @IsObject()
  params?: Record<string, unknown>;
}
