import { Injectable, BadRequestException, BadGatewayException } from '@nestjs/common';
import { ProviderGatewayService } from '../providers/provider-gateway.service';
import { SandboxGateway } from '../sandbox/sandbox.gateway';
import { RunBacktestDto } from './dto/run-backtest.dto';
import { CrossSectionalDto } from './dto/cross-sectional.dto';
import { StrategyService } from '../strategy/strategy.service';
import { PluginsService } from '../plugins/plugins.service';

/** Universo por defecto cuando una estrategia no define cycle.universe. */
const DEFAULT_UNIVERSE = ['SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META'];

/** Minimal shape needed to fetch + normalize OHLCV — satisfied by both DTOs. */
interface PriceQuery {
  symbols: string[];
  timeframe?: string;
  limit?: number;
  provider_id?: string | null;
}

export interface BacktestMetrics {
  total_return_pct: number;
  cagr_pct: number;
  sharpe_ratio: number;
  sortino_ratio: number;
  max_drawdown_pct: number;
  calmar_ratio: number;
  buy_hold_return_pct: number;
  alpha_pct: number;
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

/** Cross-sectional momentum portfolio backtest result. */
export interface CrossSectionalResponse {
  ok: true;
  metrics: {
    total_return_pct: number;
    cagr_pct: number;
    sharpe_ratio: number;
    max_drawdown_pct: number;
    buy_hold_return_pct: number;
    alpha_pct: number;
    total_cost_pct: number;
  };
  equity_curve: { date: string; equity: number }[];
  final_holdings: string[];
  n_dates: number;
  universe_size: number;
}

/** Walk-forward (anchored) validation result — overfit detection. */
export interface WalkForwardResponse {
  ok: true;
  verdict: 'ROBUSTO' | 'SOBREAJUSTADO' | 'INSUFICIENTE_DATOS';
  n_windows: number;
  avg_oos_sharpe: number;
  avg_robustness_ratio: number;
  robust_windows: number;
  total_windows: number;
  windows: Record<string, unknown>[];
  summary?: Record<string, unknown>;
}

@Injectable()
export class BacktestService {
  constructor(
    private readonly providerGateway: ProviderGatewayService,
    private readonly sandbox: SandboxGateway,
    private readonly strategies: StrategyService,
    private readonly plugins: PluginsService,
  ) {}

  /** Plugins que proveen backtest (declaran una skill 'backtester.*'). */
  async listProviders(): Promise<{ id: string; name: string; active: boolean }[]> {
    const all = await this.plugins.findAll();
    return all
      .filter((p) => (p.skills ?? []).some((s) => s.startsWith('backtester.')))
      .map((p) => ({ id: p.id, name: p.name, active: p.active }));
  }

  /**
   * Corre un backtest para cada estrategia seleccionada usando el provider de backtest
   * elegido (plugin) y devuelve la curva de equity de cada una → gráfico de competencia.
   */
  async compareStrategies(input: {
    strategy_ids: string[];
    provider_id?: string;
    timeframe?: string;
    bars?: number;
  }): Promise<{
    provider_id: string;
    timeframe: string;
    bars: number;
    series: Record<string, { ts: string; equity: number }[]>;
    errors: Record<string, string>;
  }> {
    const providerId = input.provider_id || 'backtester';
    const timeframe = input.timeframe || '1d';
    const bars = input.bars ?? 500;
    const series: Record<string, { ts: string; equity: number }[]> = {};
    const errors: Record<string, string> = {};

    for (const sid of input.strategy_ids) {
      try {
        const s = await this.strategies.get(sid);
        const universe = (s.config['cycle.universe'] ?? '')
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean);
        const symbols = universe.length >= 2 ? universe : DEFAULT_UNIVERSE;
        const prices = await this._buildPrices({ symbols, timeframe, limit: bars });
        const config: Record<string, unknown> = {
          initial_capital: Number(s.config['cycle.capital']) || 10000,
        };
        const resp = await this.sandbox.callPlugin(providerId, 'run_cross_sectional', {
          prices,
          config,
        });
        const result = resp.result as
          | { ok?: boolean; equity_curve?: { date: string; equity: number }[]; error?: string }
          | undefined;
        if (resp.ok && result?.ok && Array.isArray(result.equity_curve)) {
          series[s.name] = result.equity_curve.map((p) => ({ ts: p.date, equity: p.equity }));
        } else {
          errors[s.name] = String(resp.error ?? result?.error ?? 'backtest falló');
        }
      } catch (e) {
        errors[sid] = e instanceof Error ? e.message : String(e);
      }
    }
    return { provider_id: providerId, timeframe, bars, series, errors };
  }

  async runBacktest(dto: RunBacktestDto): Promise<BacktestResponse> {
    const prices = await this._buildPrices(dto);

    const response = await this.sandbox.callPlugin('backtester', 'run', {
      strategy_id: dto.strategy,
      prices,
      config: this._buildConfig(dto),
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

  /**
   * Anchored walk-forward validation — splits history into rolling in-sample/out-of-sample
   * windows and reports a robustness verdict. The honest tool to detect OVERFIT strategies
   * that look great in-sample but fail out-of-sample.
   */
  async runWalkForward(
    dto: RunBacktestDto & { n_windows?: number; in_sample_pct?: number; min_trades?: number },
  ): Promise<WalkForwardResponse> {
    const prices = await this._buildPrices(dto);
    const config = {
      ...this._buildConfig(dto),
      n_windows: dto.n_windows ?? 5,
      in_sample_pct: dto.in_sample_pct ?? 0.7,
      // Only override the plugin default (10) when explicitly provided.
      ...(dto.min_trades !== undefined ? { min_trades: dto.min_trades } : {}),
    };

    const response = await this.sandbox.callPlugin('backtester', 'run_walk_forward', {
      strategy_id: dto.strategy,
      prices,
      config,
    });

    if (!response.ok) {
      throw new BadGatewayException(`Sandbox error: ${response.error ?? 'unknown error'}`);
    }

    const result = response.result as WalkForwardResponse & { ok: boolean; error?: string };
    if (!result.ok) {
      throw new BadGatewayException(`Walk-forward error: ${result.error ?? 'unknown error'}`);
    }
    return result;
  }

  /**
   * Cross-sectional momentum portfolio backtest: ranks the universe (all `symbols`)
   * by 12-1 momentum, holds the top-N, rebalances. Reports alpha vs equal-weight buy&hold.
   */
  async runCrossSectional(dto: CrossSectionalDto): Promise<CrossSectionalResponse> {
    const prices = await this._buildPrices(dto);
    const config: Record<string, unknown> = {
      initial_capital: dto.capital ?? 10000,
      ...(dto.top_n !== undefined ? { top_n: dto.top_n } : {}),
      ...(dto.rebalance_days !== undefined ? { rebalance_days: dto.rebalance_days } : {}),
      ...(dto.lookback !== undefined ? { lookback: dto.lookback } : {}),
      ...(dto.skip !== undefined ? { skip: dto.skip } : {}),
      ...(dto.commission_pct !== undefined ? { commission_pct: dto.commission_pct } : {}),
      ...(dto.slippage_pct !== undefined ? { slippage_pct: dto.slippage_pct } : {}),
      ...(dto.vol_target !== undefined ? { vol_target: dto.vol_target } : {}),
      ...(dto.vol_window !== undefined ? { vol_window: dto.vol_window } : {}),
      ...(dto.max_leverage !== undefined ? { max_leverage: dto.max_leverage } : {}),
      ...(dto.params ?? {}),
    };

    const response = await this.sandbox.callPlugin('backtester', 'run_cross_sectional', {
      prices,
      config,
    });
    if (!response.ok) {
      throw new BadGatewayException(`Sandbox error: ${response.error ?? 'unknown error'}`);
    }
    const result = response.result as CrossSectionalResponse & { ok: boolean; error?: string };
    if (!result.ok) {
      throw new BadGatewayException(`Cross-sectional error: ${result.error ?? 'unknown error'}`);
    }
    return result;
  }

  private _buildConfig(dto: RunBacktestDto) {
    return {
      initial_capital: dto.capital ?? 10000,
      commission_pct: dto.commission_pct ?? 0.001,
      slippage_pct: dto.slippage_pct ?? 0.0005,
      risk_per_trade: dto.risk_per_trade ?? 0.01,
      max_positions: dto.max_positions ?? 5,
      // Arbitrary strategy params (MA periods, thresholds, ...) → reach the strategy's
      // analyze(window, config). Spread last so custom params win → fully configurable.
      ...(dto.params ?? {}),
    };
  }

  /** Fetch + normalize OHLCV for every requested symbol (ts → date). */
  private async _buildPrices(
    q: PriceQuery,
  ): Promise<
    Record<
      string,
      { date: string; open: number; high: number; low: number; close: number; volume: number }[]
    >
  > {
    const { symbols, timeframe = '1d', limit = 500, provider_id = null } = q;
    const barArrays = await Promise.all(
      symbols.map((symbol) =>
        this.providerGateway.getOhlcv(provider_id ?? null, symbol, timeframe, limit),
      ),
    );

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
        date: bar.ts.slice(0, 10),
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      }));
    }
    return prices;
  }
}
