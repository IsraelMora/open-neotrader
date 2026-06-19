import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { AgentsController } from './agents.controller';
import { PanelService } from '../panel/panel.service';
import type { ReflectionTurnResult } from './agents.service';

// ── Stubs ─────────────────────────────────────────────────────────────────────

function makePanelStub(opts: {
  reflectResult?: ReflectionTurnResult;
  reflectThrows?: Error;
}): Partial<PanelService> {
  return {
    reflectNow: opts.reflectThrows
      ? jest.fn().mockRejectedValue(opts.reflectThrows)
      : jest.fn().mockResolvedValue(
          opts.reflectResult ?? { skipped: false, cycle_id: 'ref-001', skills_written: 0 },
        ),
  };
}

async function buildModule(panelStub: Partial<PanelService>): Promise<TestingModule> {
  return Test.createTestingModule({
    controllers: [AgentsController],
    providers: [
      {
        provide: PanelService,
        useValue: panelStub,
      },
    ],
  })
    .overrideGuard(require('../auth/guards/jwt-auth.guard').JwtAuthGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(require('../auth/guards/totp-required.guard').TotpRequiredGuard)
    .useValue({ canActivate: () => true })
    .compile();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('F4-S2 Phase 4 — AgentsController POST /agents/reflect', () => {
  it('4.1a — no reflection plugin → 200 {skipped:true}', async () => {
    const panelStub = makePanelStub({
      reflectResult: { skipped: true, reason: 'no_reflection_plugin' },
    });
    const module = await buildModule(panelStub);
    const controller = module.get(AgentsController);

    const result = await controller.reflect();

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('no_reflection_plugin');
  });

  it('4.1b — reflection runs successfully → 200 {skipped:false, cycle_id}', async () => {
    const panelStub = makePanelStub({
      reflectResult: { skipped: false, cycle_id: 'cycle-xyz', skills_written: 1 },
    });
    const module = await buildModule(panelStub);
    const controller = module.get(AgentsController);

    const result = await controller.reflect();

    expect(result.skipped).toBe(false);
    expect(result.cycle_id).toBe('cycle-xyz');
  });

  it('4.1c — cycle running → 409 ConflictException propagated', async () => {
    const panelStub = makePanelStub({
      reflectThrows: new ConflictException('A cycle is currently running'),
    });
    const module = await buildModule(panelStub);
    const controller = module.get(AgentsController);

    await expect(controller.reflect()).rejects.toThrow(ConflictException);
  });
});
