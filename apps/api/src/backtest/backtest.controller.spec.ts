/**
 * BacktestController — unit tests.
 * Tests DTO validation and controller delegation.
 */
import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { Test, TestingModule } from '@nestjs/testing';
import { BacktestController } from './backtest.controller';
import { BacktestService } from './backtest.service';
import type { BacktestResponse } from './backtest.service';
import { RunBacktestDto } from './dto/run-backtest.dto';
import { CrossSectionalDto } from './dto/cross-sectional.dto';
import { CrossSectionalWalkForwardDto } from './dto/cross-sectional-walk-forward.dto';
import { WalkForwardTotpGuard } from './guards/walk-forward-totp.guard';

// ── DTO validation tests ──────────────────────────────────────────────────────

describe('RunBacktestDto — validation', () => {
  function dto(overrides: Record<string, unknown> = {}): RunBacktestDto {
    return plainToInstance(RunBacktestDto, {
      strategy: 'trend-following',
      symbols: ['AAPL'],
      ...overrides,
    });
  }

  it('accepts a minimal valid request', async () => {
    const errors = await validate(dto());
    expect(errors).toHaveLength(0);
  });

  it('rejects missing strategy', async () => {
    const errors = await validate(dto({ strategy: undefined }));
    expect(errors.some((e) => e.property === 'strategy')).toBe(true);
  });

  it('rejects an unknown strategy value', async () => {
    const errors = await validate(dto({ strategy: 'momentum-v2' }));
    expect(errors.some((e) => e.property === 'strategy')).toBe(true);
  });

  it('rejects empty symbols array', async () => {
    const errors = await validate(dto({ symbols: [] }));
    expect(errors.some((e) => e.property === 'symbols')).toBe(true);
  });

  it('rejects symbols with a non-string element', async () => {
    const errors = await validate(dto({ symbols: [123] }));
    expect(errors.some((e) => e.property === 'symbols')).toBe(true);
  });

  it('rejects limit below 10', async () => {
    const errors = await validate(dto({ limit: 5 }));
    expect(errors.some((e) => e.property === 'limit')).toBe(true);
  });

  it('rejects limit above 2000', async () => {
    const errors = await validate(dto({ limit: 9999 }));
    expect(errors.some((e) => e.property === 'limit')).toBe(true);
  });

  it('rejects capital below 100', async () => {
    const errors = await validate(dto({ capital: 10 }));
    expect(errors.some((e) => e.property === 'capital')).toBe(true);
  });

  it('rejects risk_per_trade above 1', async () => {
    const errors = await validate(dto({ risk_per_trade: 5 }));
    expect(errors.some((e) => e.property === 'risk_per_trade')).toBe(true);
  });

  it('accepts optional fields with valid values', async () => {
    const errors = await validate(
      dto({
        timeframe: '1w',
        limit: 300,
        capital: 50000,
        commission_pct: 0.002,
        slippage_pct: 0.001,
        risk_per_trade: 0.02,
        max_positions: 10,
        provider_id: 'alpaca',
      }),
    );
    expect(errors).toHaveLength(0);
  });

  it('accepts null provider_id', async () => {
    const errors = await validate(dto({ provider_id: null }));
    expect(errors).toHaveLength(0);
  });
});

describe('CrossSectionalDto — validation', () => {
  function dto(overrides: Record<string, unknown> = {}): CrossSectionalDto {
    return plainToInstance(CrossSectionalDto, {
      symbols: ['AAPL'],
      ...overrides,
    });
  }

  it('accepts skip=147 (Novy-Marx 12-7 style skip, unlocked by the raised cap)', async () => {
    const errors = await validate(dto({ skip: 147 }));
    expect(errors).toHaveLength(0);
  });

  it('rejects skip=201 (above the raised cap)', async () => {
    const errors = await validate(dto({ skip: 201 }));
    expect(errors.some((e) => e.property === 'skip')).toBe(true);
  });
});

describe('CrossSectionalWalkForwardDto — validation', () => {
  function dto(overrides: Record<string, unknown> = {}): CrossSectionalWalkForwardDto {
    return plainToInstance(CrossSectionalWalkForwardDto, {
      symbols: ['AAPL', 'MSFT'],
      ...overrides,
    });
  }

  it('accepts a minimal valid request', async () => {
    const errors = await validate(dto());
    expect(errors).toHaveLength(0);
  });

  it('accepts explicit n_windows and in_sample_pct within bounds', async () => {
    const errors = await validate(dto({ n_windows: 4, in_sample_pct: 0.6 }));
    expect(errors).toHaveLength(0);
  });

  it('rejects n_windows below 2', async () => {
    const errors = await validate(dto({ n_windows: 1 }));
    expect(errors.some((e) => e.property === 'n_windows')).toBe(true);
  });

  it('rejects n_windows above 20', async () => {
    const errors = await validate(dto({ n_windows: 21 }));
    expect(errors.some((e) => e.property === 'n_windows')).toBe(true);
  });

  it('rejects in_sample_pct below 0.3', async () => {
    const errors = await validate(dto({ in_sample_pct: 0.1 }));
    expect(errors.some((e) => e.property === 'in_sample_pct')).toBe(true);
  });

  it('rejects in_sample_pct above 0.9', async () => {
    const errors = await validate(dto({ in_sample_pct: 0.95 }));
    expect(errors.some((e) => e.property === 'in_sample_pct')).toBe(true);
  });

  it('still enforces the base CrossSectionalDto bounds (e.g. lookback)', async () => {
    const errors = await validate(dto({ lookback: 1 }));
    expect(errors.some((e) => e.property === 'lookback')).toBe(true);
  });
});

// ── Controller tests ──────────────────────────────────────────────────────────

const MOCK_RESPONSE: BacktestResponse = {
  ok: true,
  metrics: {
    total_return_pct: 8.5,
    cagr_pct: 17.0,
    sharpe_ratio: 1.3,
    sortino_ratio: 1.8,
    max_drawdown_pct: 4.2,
    calmar_ratio: 4.0,
    buy_hold_return_pct: 12.0,
    alpha_pct: 13.0,
    total_trades: 6,
    win_rate_pct: 66.7,
    profit_factor: 2.5,
    avg_win_pct: 3.0,
    avg_loss_pct: -1.5,
    avg_duration_days: 7,
    largest_win_pct: 5.0,
    largest_loss_pct: -2.5,
    time_in_market_pct: 50.0,
  },
  equity_curve: [],
  trades: [],
};

describe('BacktestController', () => {
  let controller: BacktestController;
  let runBacktestMock: jest.Mock;

  beforeEach(async () => {
    runBacktestMock = jest.fn().mockResolvedValue(MOCK_RESPONSE);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [BacktestController],
      providers: [
        {
          provide: BacktestService,
          useValue: { runBacktest: runBacktestMock },
        },
      ],
    }).compile();

    controller = module.get<BacktestController>(BacktestController);
  });

  it('POST /backtest delegates to BacktestService.runBacktest', async () => {
    const dto = plainToInstance(RunBacktestDto, {
      strategy: 'trend-following',
      symbols: ['AAPL'],
    });

    const result = await controller.run(dto);

    expect(runBacktestMock).toHaveBeenCalledWith(dto);
    expect(result.ok).toBe(true);
    expect(result.metrics.total_return_pct).toBeCloseTo(8.5);
  });

  it('returns the service result directly', async () => {
    const dto = plainToInstance(RunBacktestDto, {
      strategy: 'mean-reversion',
      symbols: ['SPY'],
    });

    const result = await controller.run(dto);
    expect(result).toEqual(MOCK_RESPONSE);
  });

  it('POST /backtest/walk-forward route is guarded by WalkForwardTotpGuard', () => {
    const controllerProto: Record<string, object> =
      BacktestController.prototype as unknown as Record<string, object>;
    const guards = Reflect.getMetadata('__guards__', controllerProto['walkForward']) as
      | unknown[]
      | undefined;
    expect(guards).toBeDefined();
    expect(guards).toContain(WalkForwardTotpGuard);
  });

  it('POST /backtest route has no WalkForwardTotpGuard (relies on the global JwtAuthGuard only)', () => {
    const controllerProto: Record<string, object> =
      BacktestController.prototype as unknown as Record<string, object>;
    const guards = Reflect.getMetadata('__guards__', controllerProto['run']) as
      | unknown[]
      | undefined;
    expect(guards ?? []).not.toContain(WalkForwardTotpGuard);
  });

  it(
    'POST /backtest/cross-sectional/walk-forward has no WalkForwardTotpGuard ' +
      '(research-only, nothing persisted)',
    () => {
      const controllerProto: Record<string, object> =
        BacktestController.prototype as unknown as Record<string, object>;
      const guards = Reflect.getMetadata(
        '__guards__',
        controllerProto['crossSectionalWalkForward'],
      ) as unknown[] | undefined;
      expect(guards ?? []).not.toContain(WalkForwardTotpGuard);
    },
  );
});

describe('BacktestController — crossSectionalWalkForward', () => {
  let controller: BacktestController;
  let runCrossSectionalWalkForwardMock: jest.Mock;

  const MOCK_CS_WF_RESPONSE = {
    ok: true as const,
    verdict: 'ROBUSTO' as const,
    n_windows: 3,
    avg_oos_sharpe: 0.5,
    median_oos_sharpe: 0.45,
    avg_robustness_ratio: 0.6,
    robust_windows: 2,
    total_windows: 3,
    windows: [],
  };

  beforeEach(async () => {
    runCrossSectionalWalkForwardMock = jest.fn().mockResolvedValue(MOCK_CS_WF_RESPONSE);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [BacktestController],
      providers: [
        {
          provide: BacktestService,
          useValue: { runCrossSectionalWalkForward: runCrossSectionalWalkForwardMock },
        },
      ],
    }).compile();

    controller = module.get<BacktestController>(BacktestController);
  });

  it('delegates to BacktestService.runCrossSectionalWalkForward', async () => {
    const dto = plainToInstance(CrossSectionalWalkForwardDto, {
      symbols: ['AAPL', 'MSFT', 'NVDA'],
      n_windows: 3,
      in_sample_pct: 0.7,
    });

    const result = await controller.crossSectionalWalkForward(dto);

    expect(runCrossSectionalWalkForwardMock).toHaveBeenCalledWith(dto);
    expect(result).toEqual(MOCK_CS_WF_RESPONSE);
  });
});
