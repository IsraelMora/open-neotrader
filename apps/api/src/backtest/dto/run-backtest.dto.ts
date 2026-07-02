import {
  IsString,
  IsNotEmpty,
  IsArray,
  ArrayNotEmpty,
  IsEnum,
  IsOptional,
  IsNumber,
  IsInt,
  IsObject,
  Min,
  Max,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';

const SUPPORTED_STRATEGIES = ['trend-following', 'mean-reversion', 'session-breakout'] as const;
type SupportedStrategy = (typeof SUPPORTED_STRATEGIES)[number];

export class RunBacktestDto {
  @IsEnum(SUPPORTED_STRATEGIES)
  strategy!: SupportedStrategy;

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
  @Min(10)
  @Max(2000)
  @Type(() => Number)
  limit?: number = 500;

  @IsOptional()
  @IsNumber()
  @Min(100)
  @Type(() => Number)
  capital?: number = 10000;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  commission_pct?: number = 0.001;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  slippage_pct?: number = 0.0005;

  @IsOptional()
  @IsNumber()
  @Min(0.0001)
  @Max(1)
  @Type(() => Number)
  risk_per_trade?: number = 0.01;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  @Type(() => Number)
  max_positions?: number = 5;

  /**
   * Optional provider ID. When null, BacktestService uses the default active provider.
   * IsNullable does not exist in class-validator — use ValidateIf to skip string
   * validation when the value is explicitly null.
   */
  @IsOptional()
  @ValidateIf((o: RunBacktestDto) => o.provider_id !== null && o.provider_id !== undefined)
  @IsString()
  provider_id?: string | null = null;

  // ── Walk-forward only (ignored by plain backtest) ────────────────────────
  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(20)
  @Type(() => Number)
  n_windows?: number;

  @IsOptional()
  @IsNumber()
  @Min(0.3)
  @Max(0.9)
  @Type(() => Number)
  in_sample_pct?: number;

  /** Min trades per OOS window to count it as valid. Lower = usable for low-frequency
   *  strategies, but less statistical confidence. Default 10 (set in the plugin). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  min_trades?: number;

  /**
   * Arbitrary strategy parameters (e.g. MA periods, lookback, thresholds) merged into
   * the config passed to the strategy's analyze(). Lets you backtest ANY configuration
   * instead of the manifest defaults. Keys depend on the strategy.
   * Example: { "fast_ma": 20, "slow_ma": 100, "rsi_oversold": 25 }
   */
  @IsOptional()
  @IsObject()
  params?: Record<string, unknown>;

  /**
   * Walk-forward gate only: the DB Strategy row id (Strategy.id, a UUID) to record the
   * walk-forward verdict against. Distinct from `strategy` above, which is a strategy-KIND
   * string ("trend-following" | ...), not a Strategy row id. When set, a successful
   * walk-forward run persists its verdict on that row (best-effort) so real-money
   * execution can be gated on a recent ROBUSTO verdict. Absent → nothing is persisted.
   */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  strategy_row_id?: string;
}
