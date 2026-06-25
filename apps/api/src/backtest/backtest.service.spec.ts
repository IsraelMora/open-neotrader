/**
 * BacktestService — unit tests.
 * Mocks ProviderGatewayService and SandboxGateway — no network, no process spawn.
 */
import 'reflect-metadata';
import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { BacktestService } from './backtest.service';
import type { OhlcvBar } from '../providers/provider-gateway.service';
import type { SandboxGateway } from '../sandbox/sandbox.gateway';
import type { ProviderGatewayService } from '../providers/provider-gateway.service';
import { RunBacktestDto } from './dto/run-backtest.dto';
import { plainToInstance } from 'class-transformer';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeBar(overrides: Partial<OhlcvBar> = {}): OhlcvBar {
  return {
    ts: '2024-01-01T00:00:00Z',
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 1000,
    ...overrides,
  };
}

function makeBars(n: number): OhlcvBar[] {
  return Array.from({ length: n }, (_, i) => ({
    ts: `2024-${String(Math.floor(i / 30) + 1).padStart(2, '0')}-${String((i % 30) + 1).padStart(2, '0')}T00:00:00Z`,
    open: 100 + i * 0.1,
    high: 101 + i * 0.1,
    low: 99 + i * 0.1,
    close: 100.5 + i * 0.1,
    volume: 1000,
  }));
}

function makeDto(overrides: Partial<RunBacktestDto> = {}): RunBacktestDto {
  return plainToInstance(RunBacktestDto, {
    strategy: 'trend-following',
    symbols: ['AAPL'],
    timeframe: '1d',
    limit: 100,
    capital: 10000,
    ...overrides,
  });
}

const SANDBOX_SUCCESS: Record<string, unknown> = {
  ok: true,
  result: {
    ok: true,
    metrics: {
      total_return_pct: 5.2,
      cagr_pct: 10.4,
      sharpe_ratio: 1.1,
      sortino_ratio: 1.5,
      max_drawdown_pct: 3.0,
      calmar_ratio: 3.5,
      buy_hold_return_pct: 8.0,
      alpha_pct: 2.4,
      total_trades: 4,
      win_rate_pct: 75.0,
      profit_factor: 2.1,
      avg_win_pct: 2.5,
      avg_loss_pct: -1.2,
      avg_duration_days: 5,
      largest_win_pct: 4.0,
      largest_loss_pct: -2.0,
      time_in_market_pct: 40.0,
    },
    equity_curve: [{ date: '2024-01-01', equity: 10000 }],
    trades: [],
  },
};

/** Build a mock gateway and return both the mock object and the captured jest.fn references. */
function makeGateway(bars: OhlcvBar[] = makeBars(100)) {
  const getOhlcv = jest.fn().mockResolvedValue(bars);
  const gateway = { getOhlcv } as unknown as ProviderGatewayService;
  return { gateway, getOhlcv };
}

/** Build a mock sandbox and return both the mock object and the captured jest.fn reference. */
function makeSandbox(response: Record<string, unknown> = SANDBOX_SUCCESS) {
  const callPlugin = jest.fn().mockResolvedValue(response);
  const sandbox = { callPlugin } as unknown as SandboxGateway;
  return { sandbox, callPlugin };
}

function makeService(gateway: ProviderGatewayService, sandbox: SandboxGateway): BacktestService {
  return new BacktestService(gateway, sandbox);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BacktestService — runBacktest', () => {
  it('returns metrics on happy path', async () => {
    const { gateway } = makeGateway();
    const { sandbox } = makeSandbox();
    const svc = makeService(gateway, sandbox);
    const result = await svc.runBacktest(makeDto());

    expect(result.ok).toBe(true);
    // toBeCloseTo for floating point comparisons
    expect(result.metrics.total_return_pct).toBeCloseTo(5.2);
    expect(result.equity_curve).toHaveLength(1);
  });

  it('calls getOhlcv with correct arguments', async () => {
    const { gateway, getOhlcv } = makeGateway();
    const { sandbox } = makeSandbox();
    const svc = makeService(gateway, sandbox);
    await svc.runBacktest(
      makeDto({ provider_id: 'alpaca', symbols: ['AAPL'], timeframe: '1d', limit: 200 }),
    );

    expect(getOhlcv).toHaveBeenCalledWith('alpaca', 'AAPL', '1d', 200);
  });

  it('passes null provider_id to getOhlcv when not specified', async () => {
    const { gateway, getOhlcv } = makeGateway();
    const { sandbox } = makeSandbox();
    const svc = makeService(gateway, sandbox);
    await svc.runBacktest(makeDto({ provider_id: null, symbols: ['AAPL'] }));

    expect(getOhlcv).toHaveBeenCalledWith(null, 'AAPL', expect.any(String), expect.any(Number));
  });

  it('fetches all symbols in parallel and passes all prices to sandbox', async () => {
    const { gateway, getOhlcv } = makeGateway();
    const { sandbox, callPlugin } = makeSandbox();
    const svc = makeService(gateway, sandbox);
    await svc.runBacktest(makeDto({ symbols: ['AAPL', 'MSFT'] }));

    expect(getOhlcv).toHaveBeenCalledTimes(2);
    const callArgs = callPlugin.mock.calls[0] as [
      string,
      string,
      { prices: Record<string, unknown> },
    ];
    expect(Object.keys(callArgs[2].prices)).toContain('AAPL');
    expect(Object.keys(callArgs[2].prices)).toContain('MSFT');
  });

  it('normalizes ts→date in prices passed to sandbox', async () => {
    const { gateway } = makeGateway([makeBar({ ts: '2024-03-15T09:30:00Z' })]);
    const { sandbox, callPlugin } = makeSandbox();
    const svc = makeService(gateway, sandbox);
    await svc.runBacktest(makeDto());

    const callArgs = callPlugin.mock.calls[0] as [
      string,
      string,
      { prices: Record<string, { date: string }[]> },
    ];
    const firstBar = callArgs[2].prices['AAPL'][0];
    expect(firstBar.date).toBe('2024-03-15');
    expect(firstBar).not.toHaveProperty('ts');
  });

  it('throws BadRequestException when a symbol returns empty OHLCV', async () => {
    const { gateway } = makeGateway([]);
    const { sandbox } = makeSandbox();
    const svc = makeService(gateway, sandbox);

    await expect(svc.runBacktest(makeDto())).rejects.toThrow(BadRequestException);
  });

  it('throws BadGatewayException when sandbox returns ok:false', async () => {
    const { gateway } = makeGateway();
    const { sandbox } = makeSandbox({ ok: false, error: 'sandbox timeout' });
    const svc = makeService(gateway, sandbox);

    await expect(svc.runBacktest(makeDto())).rejects.toThrow(BadGatewayException);
  });

  it('throws BadGatewayException when sandbox result.ok is false', async () => {
    const { gateway } = makeGateway();
    const { sandbox } = makeSandbox({
      ok: true,
      result: { ok: false, error: 'Unknown strategy' },
    });
    const svc = makeService(gateway, sandbox);

    await expect(svc.runBacktest(makeDto())).rejects.toThrow(BadGatewayException);
  });

  it('calls sandbox with correct strategy_id from dto', async () => {
    const { gateway } = makeGateway();
    const { sandbox, callPlugin } = makeSandbox();
    const svc = makeService(gateway, sandbox);
    await svc.runBacktest(makeDto({ strategy: 'mean-reversion' }));

    const callArgs = callPlugin.mock.calls[0] as [string, string, { strategy_id: string }];
    expect(callArgs[1]).toBe('run');
    expect(callArgs[2].strategy_id).toBe('mean-reversion');
  });
});

describe('BacktestService — runWalkForward', () => {
  const WF_OK = {
    ok: true,
    result: {
      ok: true,
      verdict: 'ROBUSTO',
      n_windows: 5,
      avg_oos_sharpe: 0.42,
      avg_robustness_ratio: 0.61,
      robust_windows: 3,
      total_windows: 5,
      windows: [],
    },
  };

  it('calls backtester.run_walk_forward and returns the verdict', async () => {
    const { gateway } = makeGateway();
    const { sandbox, callPlugin } = makeSandbox(WF_OK);
    const svc = makeService(gateway, sandbox);
    const result = await svc.runWalkForward(makeDto({ n_windows: 5, in_sample_pct: 0.7 }));

    expect(result.verdict).toBe('ROBUSTO');
    const [plugin, fn, payload] = callPlugin.mock.calls[0] as [
      string,
      string,
      { config: { n_windows: number; in_sample_pct: number } },
    ];
    expect(plugin).toBe('backtester');
    expect(fn).toBe('run_walk_forward');
    expect(payload.config.n_windows).toBe(5);
    expect(payload.config.in_sample_pct).toBe(0.7);
  });

  it('defaults n_windows=5 / in_sample_pct=0.7 when omitted', async () => {
    const { gateway } = makeGateway();
    const { sandbox, callPlugin } = makeSandbox(WF_OK);
    const svc = makeService(gateway, sandbox);
    await svc.runWalkForward(makeDto());
    const payload = (callPlugin.mock.calls[0] as unknown[])[2] as {
      config: { n_windows: number; in_sample_pct: number };
    };
    expect(payload.config.n_windows).toBe(5);
    expect(payload.config.in_sample_pct).toBe(0.7);
  });
});

describe('BacktestService — configurable strategy params', () => {
  it('merges dto.params into the config sent to the strategy', async () => {
    const { gateway } = makeGateway();
    const { sandbox, callPlugin } = makeSandbox();
    const svc = makeService(gateway, sandbox);
    await svc.runBacktest(makeDto({ params: { fast_period: 20, slow_period: 100 } }));

    const payload = (callPlugin.mock.calls[0] as unknown[])[2] as {
      config: { fast_period: number; slow_period: number; initial_capital: number };
    };
    expect(payload.config.fast_period).toBe(20);
    expect(payload.config.slow_period).toBe(100);
    // base config still present
    expect(payload.config.initial_capital).toBeDefined();
  });

  it('custom params also flow into walk-forward config', async () => {
    const { gateway } = makeGateway();
    const wf = {
      ok: true,
      result: { ok: true, verdict: 'ROBUSTO', n_windows: 3, avg_oos_sharpe: 0.3, avg_robustness_ratio: 0.5, robust_windows: 2, total_windows: 3, windows: [] },
    };
    const { sandbox, callPlugin } = makeSandbox(wf);
    const svc = makeService(gateway, sandbox);
    await svc.runWalkForward(makeDto({ params: { rsi_oversold: 25 } }));

    const payload = (callPlugin.mock.calls[0] as unknown[])[2] as { config: { rsi_oversold: number } };
    expect(payload.config.rsi_oversold).toBe(25);
  });
});
