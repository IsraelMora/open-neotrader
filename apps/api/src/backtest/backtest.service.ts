import { Injectable, BadRequestException, BadGatewayException } from '@nestjs/common';
import { ProviderGatewayService } from '../providers/provider-gateway.service';
import { SandboxGateway } from '../sandbox/sandbox.gateway';
import { RunBacktestDto } from './dto/run-backtest.dto';

export interface BacktestMetrics {
  total_return_pct: number;
  cagr_pct: number;
  sharpe_ratio: number;
  sortino_ratio: number;
  max_drawdown_pct: number;
  calmar_ratio: number;
  total_trades: number;
  win_rate_pct: number;
  profit_factor: number;
  avg_win_pct: number;
  avg_loss_pct: number;
  avg_duration_days: number;
  largest_win_pct: number;
  largest_loss_pct: number;
  time_in_market_pct: number;
}

export interface BacktestTrade {
  symbol: string;
  direction: string;
  entry_date: string;
  exit_date: string;
  entry_price: number;
  exit_price: number;
  pnl: number;
  pnl_pct: number;
  duration_days: number;
}

export interface BacktestResponse {
  ok: true;
  metrics: BacktestMetrics;
  equity_curve: { date: string; equity: number }[];
  trades: BacktestTrade[];
}

@Injectable()
export class BacktestService {
  constructor(
    private readonly providerGateway: ProviderGatewayService,
    private readonly sandbox: SandboxGateway,
  ) {}

  async runBacktest(dto: RunBacktestDto): Promise<BacktestResponse> {
    const {
      strategy,
      symbols,
      timeframe = '1d',
      limit = 500,
      capital = 10000,
      commission_pct = 0.001,
      slippage_pct = 0.0005,
      risk_per_trade = 0.01,
      max_positions = 5,
      provider_id = null,
    } = dto;

    // Fetch OHLCV for all symbols in parallel
    const barArrays = await Promise.all(
      symbols.map((symbol) =>
        this.providerGateway.getOhlcv(provider_id ?? null, symbol, timeframe, limit),
      ),
    );

    // Validate and normalize: ts → date, keep all numeric fields
    const prices: Record<
      string,
      { date: string; open: number; high: number; low: number; close: number; volume: number }[]
    > = {};

    for (let i = 0; i < symbols.length; i++) {
      const symbol = symbols[i];
      const bars = barArrays[i];

      if (!bars || bars.length === 0) {
        throw new BadRequestException(
          `No OHLCV data returned for symbol '${symbol}'. Check that the provider has data for this symbol.`,
        );
      }

      prices[symbol] = bars.map((bar) => ({
        date: bar.ts.slice(0, 10), // "2024-03-15T..." → "2024-03-15"
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      }));
    }

    const sandboxCfg = {
      initial_capital: capital,
      commission_pct,
      slippage_pct,
      risk_per_trade,
      max_positions,
    };

    const response = await this.sandbox.callPlugin('backtester', 'run', {
      strategy_id: strategy,
      prices,
      config: sandboxCfg,
    });

    if (!response.ok) {
      throw new BadGatewayException(`Sandbox error: ${response.error ?? 'unknown error'}`);
    }

    const result = response.result as {
      ok: boolean;
      error?: string;
      metrics?: BacktestMetrics;
      equity_curve?: { date: string; equity: number }[];
      trades?: BacktestTrade[];
    };

    if (!result.ok) {
      throw new BadGatewayException(`Backtest error: ${result.error ?? 'unknown error'}`);
    }

    return {
      ok: true,
      metrics: result.metrics!,
      equity_curve: result.equity_curve ?? [],
      trades: result.trades ?? [],
    };
  }
}
