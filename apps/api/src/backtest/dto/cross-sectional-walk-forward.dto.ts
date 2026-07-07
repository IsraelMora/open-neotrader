import { IsOptional, IsNumber, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { CrossSectionalDto } from './cross-sectional.dto';

/**
 * Anchored walk-forward validation for the cross-sectional momentum portfolio engine.
 * Extends CrossSectionalDto (same universe/momentum/vol-targeting params) with the
 * walk-forward-only fields, mirroring RunBacktestDto's walk-forward fields exactly
 * (same decorators/bounds: n_windows 2-20, in_sample_pct 0.3-0.9).
 *
 * RESEARCH-ONLY DTO: unlike RunBacktestDto's walk-forward fields, there is
 * deliberately NO `strategy_row_id` field here — this backtest is portfolio-level,
 * not tied to a single Strategy row, and nothing from this route is ever persisted.
 * See BacktestController.crossSectionalWalkForward for the full rationale.
 */
export class CrossSectionalWalkForwardDto extends CrossSectionalDto {
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
}
