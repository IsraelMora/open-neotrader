/**
 * veto-analyzer.controller.spec.ts — TDD RED → GREEN.
 *
 * GET / delegates to getMetrics (parses optional from/to query into Dates).
 * POST /backfill delegates to backfill and is additionally guarded by TotpRequiredGuard
 * (mirrors AuditController.prune usage of TotpRequiredGuard on a mutating route).
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { VetoAnalyzerController } from './veto-analyzer.controller';
import { TotpRequiredGuard } from '../auth/guards/totp-required.guard';
import { VetoBackfillDto } from './dto/veto-backfill.dto';
import type { VetoAnalyzerService } from './veto-analyzer.service';

function makeVetoAnalyzer(): jest.Mocked<
  Pick<VetoAnalyzerService, 'getMetrics' | 'backfill' | 'getPluginValue'>
> {
  return {
    getMetrics: jest.fn().mockResolvedValue({
      net_value: 0,
      counts_by_verdict: { approved: 0, blocked: 0, modified: 0 },
      evaluated_count: 0,
      unsupported_action_count: 0,
      insufficient_data_count: 0,
      losses_avoided: 0,
      profits_forgone: 0,
      by_discipline: {},
    }),
    backfill: jest.fn().mockResolvedValue({
      evaluated: 0,
      insufficientData: 0,
      unsupportedAction: 0,
      errors: 0,
    }),
    getPluginValue: jest.fn().mockResolvedValue({
      plugins: [],
      totals: { evaluated_count: 0, net_value: 0, wins: 0, win_rate: 0, avg_cf_pnl: 0 },
    }),
  };
}

describe('VetoAnalyzerController', () => {
  it('GET / delegates to vetoAnalyzer.getMetrics() with no window when no query params', async () => {
    const svc = makeVetoAnalyzer();
    const controller = new VetoAnalyzerController(svc as unknown as VetoAnalyzerService);

    await controller.getMetrics({});

    expect(svc.getMetrics).toHaveBeenCalledWith({ from: undefined, to: undefined });
  });

  it('GET / parses from/to query strings into Date objects', async () => {
    const svc = makeVetoAnalyzer();
    const controller = new VetoAnalyzerController(svc as unknown as VetoAnalyzerService);

    await controller.getMetrics({
      from: '2024-01-01T00:00:00.000Z',
      to: '2024-01-31T00:00:00.000Z',
    });

    expect(svc.getMetrics).toHaveBeenCalledWith({
      from: new Date('2024-01-01T00:00:00.000Z'),
      to: new Date('2024-01-31T00:00:00.000Z'),
    });
  });

  it('POST /backfill delegates to vetoAnalyzer.backfill() with the request body', async () => {
    const svc = makeVetoAnalyzer();
    const controller = new VetoAnalyzerController(svc as unknown as VetoAnalyzerService);

    await controller.backfill({ horizonBars: 10 });

    expect(svc.backfill).toHaveBeenCalledWith({ horizonBars: 10 });
  });

  const controllerProto: Record<string, object> =
    VetoAnalyzerController.prototype as unknown as Record<string, object>;

  it('POST /backfill route is guarded by TotpRequiredGuard', () => {
    const guards = Reflect.getMetadata('__guards__', controllerProto['backfill']) as
      | unknown[]
      | undefined;
    expect(guards).toBeDefined();
    expect(guards).toContain(TotpRequiredGuard);
  });

  it('GET / route has no TotpRequiredGuard (relies on the global JwtAuthGuard only)', () => {
    const guards = Reflect.getMetadata('__guards__', controllerProto['getMetrics']) as
      | unknown[]
      | undefined;
    expect(guards ?? []).not.toContain(TotpRequiredGuard);
  });

  it('GET /plugin-value delegates to vetoAnalyzer.getPluginValue() with no window when no query params', async () => {
    const svc = makeVetoAnalyzer();
    const controller = new VetoAnalyzerController(svc as unknown as VetoAnalyzerService);

    await controller.getPluginValue({});

    expect(svc.getPluginValue).toHaveBeenCalledWith({ from: undefined, to: undefined });
  });

  it('GET /plugin-value parses from/to query strings into Date objects', async () => {
    const svc = makeVetoAnalyzer();
    const controller = new VetoAnalyzerController(svc as unknown as VetoAnalyzerService);

    await controller.getPluginValue({
      from: '2024-01-01T00:00:00.000Z',
      to: '2024-01-31T00:00:00.000Z',
    });

    expect(svc.getPluginValue).toHaveBeenCalledWith({
      from: new Date('2024-01-01T00:00:00.000Z'),
      to: new Date('2024-01-31T00:00:00.000Z'),
    });
  });

  it('GET /plugin-value route has no TotpRequiredGuard (read-only aggregate, JwtAuthGuard only)', () => {
    const guards = Reflect.getMetadata('__guards__', controllerProto['getPluginValue']) as
      | unknown[]
      | undefined;
    expect(guards ?? []).not.toContain(TotpRequiredGuard);
  });
});

// ── Fix 4: POST /backfill body must be validated by a real DTO (not a bare TS interface) ──

describe('VetoBackfillDto validation (mirrors VetoMetricsQueryDto pattern)', () => {
  it('rejects a non-numeric costBps ("abc")', async () => {
    const dto = plainToInstance(VetoBackfillDto, { costBps: 'abc' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'costBps')).toBe(true);
  });

  it('rejects a negative horizonBars (-5)', async () => {
    const dto = plainToInstance(VetoBackfillDto, { horizonBars: -5 });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'horizonBars')).toBe(true);
  });

  it('rejects a non-integer horizonBars (2.5)', async () => {
    const dto = plainToInstance(VetoBackfillDto, { horizonBars: 2.5 });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'horizonBars')).toBe(true);
  });

  it('rejects a non-boolean reprocessInsufficient', async () => {
    const dto = plainToInstance(VetoBackfillDto, { reprocessInsufficient: 'yes' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'reprocessInsufficient')).toBe(true);
  });

  it('accepts a fully valid body with no errors', async () => {
    const dto = plainToInstance(VetoBackfillDto, {
      horizonBars: 10,
      timeframe: '1h',
      costBps: 5,
      reprocessInsufficient: true,
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('accepts an empty body (all fields optional)', async () => {
    const dto = plainToInstance(VetoBackfillDto, {});
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });
});
