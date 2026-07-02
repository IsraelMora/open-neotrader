import { Controller, Post, Get, Body, HttpCode, HttpStatus, UseGuards } from '@nestjs/common';
import {
  BacktestService,
  BacktestResponse,
  WalkForwardResponse,
  CrossSectionalResponse,
} from './backtest.service';
import { RunBacktestDto } from './dto/run-backtest.dto';
import { CrossSectionalDto } from './dto/cross-sectional.dto';
import { BacktestCompareDto } from './dto/backtest-compare.dto';
import { WalkForwardTotpGuard } from './guards/walk-forward-totp.guard';

/** Executes a strategy backtest over historical OHLCV data fetched from the active provider. */
@Controller('backtest')
export class BacktestController {
  constructor(private readonly backtestService: BacktestService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  run(@Body() dto: RunBacktestDto): Promise<BacktestResponse> {
    return this.backtestService.runBacktest(dto);
  }

  /**
   * Walk-forward validation — robustness verdict (ROBUSTO / SOBREAJUSTADO) to spot overfit.
   * Guarded by WalkForwardTotpGuard: when `strategy_row_id` is present the verdict gets
   * PERSISTED onto that Strategy row — the only way to open/refresh the real-money gate —
   * so that path requires TOTP. Display-only runs (no strategy_row_id) stay TOTP-free.
   */
  @Post('walk-forward')
  @HttpCode(HttpStatus.OK)
  @UseGuards(WalkForwardTotpGuard)
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

  /** Plugins que proveen backtest (seleccionables como motor). */
  @Get('providers')
  providers() {
    return this.backtestService.listProviders();
  }

  /** Compara estrategias por backtest → curva de equity de cada una (gráfico de competencia). */
  @Post('compare')
  @HttpCode(HttpStatus.OK)
  compare(@Body() dto: BacktestCompareDto) {
    return this.backtestService.compareStrategies(dto);
  }
}
