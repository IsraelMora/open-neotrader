import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import {
  BacktestService,
  BacktestResponse,
  WalkForwardResponse,
  CrossSectionalResponse,
} from './backtest.service';
import { RunBacktestDto } from './dto/run-backtest.dto';
import { CrossSectionalDto } from './dto/cross-sectional.dto';

/** Executes a strategy backtest over historical OHLCV data fetched from the active provider. */
@Controller('backtest')
export class BacktestController {
  constructor(private readonly backtestService: BacktestService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  run(@Body() dto: RunBacktestDto): Promise<BacktestResponse> {
    return this.backtestService.runBacktest(dto);
  }

  /** Walk-forward validation — robustness verdict (ROBUSTO / SOBREAJUSTADO) to spot overfit. */
  @Post('walk-forward')
  @HttpCode(HttpStatus.OK)
  walkForward(@Body() dto: RunBacktestDto): Promise<WalkForwardResponse> {
    return this.backtestService.runWalkForward(dto);
  }

  /**
   * Cross-sectional momentum portfolio backtest over `symbols` (the universe).
   * Params: top_n, rebalance_days, lookback, skip. No `strategy` field — this route
   * always runs the cross-sectional momentum engine.
   */
  @Post('cross-sectional')
  @HttpCode(HttpStatus.OK)
  crossSectional(@Body() dto: CrossSectionalDto): Promise<CrossSectionalResponse> {
    return this.backtestService.runCrossSectional(dto);
  }
}
