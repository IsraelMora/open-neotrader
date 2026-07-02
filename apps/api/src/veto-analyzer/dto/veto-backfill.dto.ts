import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';

/** OHLCV timeframes supported by ProviderGatewayService.getOhlcv's normalized bar format. */
const SUPPORTED_TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'];

/** Sane upper bound — protects the dynamic fetch-limit computation from pathological inputs. */
const MAX_HORIZON_BARS = 500;
/** Sane upper bound in basis points (100% round-trip cost). */
const MAX_COST_BPS = 10_000;

/**
 * Validated body for POST /veto-metrics/backfill.
 *
 * BackfillOptions (veto-analyzer.service.ts) is a bare TS interface, which Nest's global
 * ValidationPipe cannot validate — TS types erase to `Object` at runtime, so the metatype
 * check in ValidationPipe skips it entirely and malformed input (e.g. costBps: "abc",
 * horizonBars: -5) flows straight into the service and produces NaN. This DTO is a real
 * class with class-validator decorators so the global pipe actually enforces it.
 */
export class VetoBackfillDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_HORIZON_BARS)
  horizonBars?: number;

  @IsOptional()
  @IsIn(SUPPORTED_TIMEFRAMES)
  timeframe?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(MAX_COST_BPS)
  costBps?: number;

  @IsOptional()
  @IsBoolean()
  reprocessInsufficient?: boolean;
}
