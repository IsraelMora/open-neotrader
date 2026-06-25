import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { BacktestService, BacktestResponse, WalkForwardResponse } from './backtest.service';
import { RunBacktestDto } from './dto/run-backtest.dto';

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
}
