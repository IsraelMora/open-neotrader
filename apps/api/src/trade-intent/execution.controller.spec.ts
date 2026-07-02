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
    const controller = new ExecutionController(svc as unknown as TradeIntentService);

    await controller.setConfig({ real: true });

    expect(svc.setPolicy).toHaveBeenCalledWith({ real: true });
  });
});
