/**
 * execution.controller.spec.ts — TDD RED → GREEN.
 *
 * H1 (HIGH): PATCH /execution/config can flip the kill-switch to real=true (or
 * autonomous=true) with only a plain JWT — no second factor. Every other
 * money-adjacent mutation in this codebase (TradeIntentController approve/reject,
 * VetoAnalyzerController backfill) requires TotpRequiredGuard. This endpoint must
 * too — mirrors the existing pattern exactly (guard applied via @UseGuards on the
 * route, verified via Reflect metadata like veto-analyzer.controller.spec.ts).
 *
 * GET /execution/config stays TOTP-free (read-only, relies on the global JwtAuthGuard).
 */
import 'reflect-metadata';
import { ExecutionController } from './execution.controller';
import { TotpRequiredGuard } from '../auth/guards/totp-required.guard';
import type { TradeIntentService } from './trade-intent.service';
import type { RealBrokerReconciliationService } from '../real-reconciliation/real-broker-reconciliation.service';

/** Stub reconciliation collaborator — adoption tests override adoptBrokerPosition/getActiveBrokerPluginId. */
function makeReconciliation(
  overrides: Partial<
    Pick<RealBrokerReconciliationService, 'adoptBrokerPosition' | 'getActiveBrokerPluginId'>
  > = {},
): RealBrokerReconciliationService {
  return {
    adoptBrokerPosition: jest.fn(),
    getActiveBrokerPluginId: jest.fn().mockResolvedValue('alpaca'),
    ...overrides,
  } as unknown as RealBrokerReconciliationService;
}

describe('ExecutionController — TOTP guard on the paper→real kill-switch', () => {
  const controllerProto: Record<string, object> =
    ExecutionController.prototype as unknown as Record<string, object>;

  it('PATCH /execution/config route is guarded by TotpRequiredGuard', () => {
    const guards = Reflect.getMetadata('__guards__', controllerProto['setConfig']) as
      | unknown[]
      | undefined;
    expect(guards).toBeDefined();
    expect(guards).toContain(TotpRequiredGuard);
  });

  it('GET /execution/config route has no TotpRequiredGuard (relies on the global JwtAuthGuard only)', () => {
    const guards = Reflect.getMetadata('__guards__', controllerProto['getConfig']) as
      | unknown[]
      | undefined;
    expect(guards ?? []).not.toContain(TotpRequiredGuard);
  });

  it('setConfig still delegates to svc.setPolicy with the request body (behavior unchanged)', async () => {
    const svc: jest.Mocked<Pick<TradeIntentService, 'setPolicy'>> = {
      setPolicy: jest.fn().mockResolvedValue({ real: true }),
    };
    const controller = new ExecutionController(
      svc as unknown as TradeIntentService,
      makeReconciliation(),
    );

    await controller.setConfig({ real: true });

    expect(svc.setPolicy).toHaveBeenCalledWith({ real: true });
  });
});

describe('ExecutionController — real-money kill-switch endpoints', () => {
  const controllerProto: Record<string, object> =
    ExecutionController.prototype as unknown as Record<string, object>;

  it('GET /execution/real-halt route has no TotpRequiredGuard (relies on the global JwtAuthGuard only)', () => {
    const guards = Reflect.getMetadata('__guards__', controllerProto['getRealHalt']) as
      | unknown[]
      | undefined;
    expect(guards ?? []).not.toContain(TotpRequiredGuard);
  });

  it('POST /execution/real-halt/clear route is guarded by TotpRequiredGuard', () => {
    const guards = Reflect.getMetadata('__guards__', controllerProto['clearRealHalt']) as
      | unknown[]
      | undefined;
    expect(guards).toBeDefined();
    expect(guards).toContain(TotpRequiredGuard);
  });

  it('getRealHalt delegates to svc.getRealExecutionHaltStatus', async () => {
    const svc: jest.Mocked<Pick<TradeIntentService, 'getRealExecutionHaltStatus'>> = {
      getRealExecutionHaltStatus: jest
        .fn()
        .mockResolvedValue({ halted: true, reason: 'broker position drift detected' }),
    };
    const controller = new ExecutionController(
      svc as unknown as TradeIntentService,
      makeReconciliation(),
    );

    const result = await controller.getRealHalt();

    expect(svc.getRealExecutionHaltStatus).toHaveBeenCalled();
    expect(result).toEqual({ halted: true, reason: 'broker position drift detected' });
  });

  it('clearRealHalt delegates to svc.clearRealExecutionHalt', async () => {
    const svc: jest.Mocked<Pick<TradeIntentService, 'clearRealExecutionHalt'>> = {
      clearRealExecutionHalt: jest.fn().mockResolvedValue({ halted: false, reason: null }),
    };
    const controller = new ExecutionController(
      svc as unknown as TradeIntentService,
      makeReconciliation(),
    );

    const result = await controller.clearRealHalt();

    expect(svc.clearRealExecutionHalt).toHaveBeenCalled();
    expect(result).toEqual({ halted: false, reason: null });
  });
});

describe('ExecutionController — broker-position adoption endpoint', () => {
  const controllerProto: Record<string, object> =
    ExecutionController.prototype as unknown as Record<string, object>;

  it('POST /execution/adopt-position route is guarded by TotpRequiredGuard (money-ledger admin action)', () => {
    const guards = Reflect.getMetadata('__guards__', controllerProto['adoptPosition']) as
      | unknown[]
      | undefined;
    expect(guards).toBeDefined();
    expect(guards).toContain(TotpRequiredGuard);
  });

  it('adoptPosition resolves the active broker and delegates to reconciliation.adoptBrokerPosition(symbol, brokerPluginId, note)', async () => {
    const adoptBrokerPosition = jest
      .fn()
      .mockResolvedValue({ adopted: { id: 'ro_adopted' }, driftedSymbols: [] });
    const getActiveBrokerPluginId = jest.fn().mockResolvedValue('alpaca');
    const reconciliation = makeReconciliation({ adoptBrokerPosition, getActiveBrokerPluginId });
    const controller = new ExecutionController({} as TradeIntentService, reconciliation);

    const result = await controller.adoptPosition({ symbol: 'SPY', note: 'legacy' });

    expect(getActiveBrokerPluginId).toHaveBeenCalled();
    expect(adoptBrokerPosition).toHaveBeenCalledWith('SPY', 'alpaca', 'legacy');
    expect(result).toEqual({ adopted: { id: 'ro_adopted' }, driftedSymbols: [] });
  });
});
