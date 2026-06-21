import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { BacktestService, BacktestResponse } from './backtest.service';
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
}
