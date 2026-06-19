/**
 * PretestController — Unit tests for F4-S4 promote endpoint
 *
 * Tests the POST /pretest/:id/promote route:
 *  - TotpRequiredGuard enforcement
 *  - gate_not_ready → 409 ConflictException
 *  - needs_confirmation → 200 with pending
 *  - ok:true → 200 with applied/failed
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { PretestController } from './pretest.controller';
import { PretestService } from './pretest.service';
import { TotpRequiredGuard } from '../auth/guards/totp-required.guard';
import type { PromoteResult } from './pretest.service';

/** Stub PretestService with all methods stubbed */
function makePretestServiceStub(
  promoteResult: PromoteResult,
): jest.Mocked<Partial<PretestService>> {
  return {
    promote: jest.fn().mockResolvedValue(promoteResult),
    findAll: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue({}),
    create: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({}),
    reset: jest.fn().mockResolvedValue({}),
    delete: jest.fn().mockResolvedValue(undefined),
    compare: jest
      .fn()
      .mockResolvedValue({ portfolios: [], winner_by_return: '', winner_by_risk_adj: '' }),
    runAllActive: jest.fn().mockResolvedValue([]),
    gate: jest.fn().mockResolvedValue({ ready: true, reasons: [], metrics: {} }),
    runCycle: jest.fn().mockResolvedValue({}),
  };
}

describe('F4-S4 Phase 4 — PretestController POST /pretest/:id/promote', () => {
  let controller: PretestController;
  let svcMock: jest.Mocked<Partial<PretestService>>;

  async function buildModule(promoteResult: PromoteResult): Promise<void> {
    svcMock = makePretestServiceStub(promoteResult);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PretestController],
      providers: [{ provide: PretestService, useValue: svcMock }],
    })
      // Override TotpRequiredGuard to allow by default (we'll test the guard separately)
      .overrideGuard(TotpRequiredGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<PretestController>(PretestController);
  }

  it('4.1 — TotpRequiredGuard is applied to the promote route', () => {
    // Verify guard metadata is present on the controller/route
    // We test this by checking that the guard is decorated on the method
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/unbound-method
    const guards = Reflect.getMetadata('__guards__', PretestController.prototype.promote);
    expect(guards).toBeDefined();

    expect(guards).toContain(TotpRequiredGuard);
  });

  it('4.2 — controller maps reason:"gate_not_ready" → 409 ConflictException with gate_reasons', async () => {
    const gateNotReadyResult: PromoteResult = {
      ok: false,
      reason: 'gate_not_ready',
      gate_reasons: ['min_trades not met: 3 < 20', 'min_sharpe not met: 0.1 < 1.0'],
    };
    await buildModule(gateNotReadyResult);

    await expect(controller.promote('pf-1', {})).rejects.toThrow(ConflictException);

    // Verify the promote service was called
    expect(svcMock.promote).toHaveBeenCalledWith('pf-1', { confirm: undefined });
  });

  it('4.3 — controller maps reason:"needs_confirmation" → 200 with {ok:false,reason,pending}', async () => {
    const needsConfirmResult: PromoteResult = {
      ok: false,
      reason: 'needs_confirmation',
      pending: {
        plugin_ids: ['p1', 'p2'],
        plugin_configs: { p1: { a: 1 } },
      },
    };
    await buildModule(needsConfirmResult);

    const result = await controller.promote('pf-2', {});

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('needs_confirmation');
    expect(result.pending).toEqual(needsConfirmResult.pending);
    // No ConflictException thrown
    expect(svcMock.promote).toHaveBeenCalledWith('pf-2', { confirm: undefined });
  });

  it('4.4 — controller maps ok:true → 200 with {ok:true,applied,failed}', async () => {
    const appliedResult: PromoteResult = {
      ok: true,
      applied: [
        { plugin_id: 'p1', activated: true, config_set: true },
        { plugin_id: 'p2', activated: true, config_set: false },
      ],
      failed: [],
    };
    await buildModule(appliedResult);

    const result = await controller.promote('pf-3', { confirm: true });

    expect(result.ok).toBe(true);
    expect(result.applied).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
    expect(svcMock.promote).toHaveBeenCalledWith('pf-3', { confirm: true });
  });

  it('4.5 — promote() with confirm:true in body passes confirm through', async () => {
    const appliedResult: PromoteResult = { ok: true, applied: [], failed: [] };
    await buildModule(appliedResult);

    await controller.promote('pf-4', { confirm: true });

    expect(svcMock.promote).toHaveBeenCalledWith('pf-4', { confirm: true });
  });
});
