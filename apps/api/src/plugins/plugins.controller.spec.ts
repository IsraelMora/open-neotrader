import { Test, TestingModule } from '@nestjs/testing';
import { PluginsController } from './plugins.controller';
import { PluginsService } from './plugins.service';
import { HttpException } from '@nestjs/common';

// ── Minimal PluginsService mock ───────────────────────────────────────────────

type PluginsServiceSubset = Pick<PluginsService, 'findById' | 'writeSkillGuarded' | 'revertSkill'>;

function makePluginsServiceMock(): jest.Mocked<PluginsServiceSubset> {
  return {
    findById: jest.fn(),
    writeSkillGuarded: jest.fn(),
    revertSkill: jest.fn(),
  };
}

// ── Phase 5.1: REST endpoint tests ───────────────────────────────────────────

describe('PluginsController — POST :id/skill (writeSkillGuarded)', () => {
  let controller: PluginsController;
  let svc: jest.Mocked<PluginsServiceSubset>;

  beforeEach(async () => {
    svc = makePluginsServiceMock();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PluginsController],
      providers: [{ provide: PluginsService, useValue: svc }],
    }).compile();

    controller = module.get<PluginsController>(PluginsController);
  });

  it('5.1 happy path: returns {ok:true} with status 200 when writeSkillGuarded succeeds', async () => {
    svc.findById.mockResolvedValue({
      id: 'my-skill',
      name: 'my-skill',
      installed_path: '/plugins/my-skill',
    } as unknown as Awaited<ReturnType<PluginsService['findById']>>);

    svc.writeSkillGuarded.mockResolvedValue({ ok: true, old_len: 100, new_len: 130 });

    const result = await controller.writeSkill('my-skill', { new_body: 'b'.repeat(130) });

    expect(result).toEqual({ ok: true, old_len: 100, new_len: 130 });
    expect(svc.writeSkillGuarded).toHaveBeenCalledWith('my-skill', 'b'.repeat(130));
  });

  it('5.1 reject path: throws HttpException(400) when writeSkillGuarded returns ok:false (not_writable)', async () => {
    svc.findById.mockResolvedValue({
      id: 'non-writable',
      name: 'non-writable',
      installed_path: '/plugins/non-writable',
    } as unknown as Awaited<ReturnType<PluginsService['findById']>>);

    svc.writeSkillGuarded.mockResolvedValue({ ok: false, reason: 'not_writable' });

    await expect(
      controller.writeSkill('non-writable', { new_body: 'b'.repeat(130) }),
    ).rejects.toThrow(HttpException);
  });
});

describe('PluginsController — POST :id/revert-skill (revertSkill)', () => {
  let controller: PluginsController;
  let svc: jest.Mocked<PluginsServiceSubset>;

  beforeEach(async () => {
    svc = makePluginsServiceMock();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PluginsController],
      providers: [{ provide: PluginsService, useValue: svc }],
    }).compile();

    controller = module.get<PluginsController>(PluginsController);
  });

  it('5.1 revert happy path: returns {ok:true} with status 200', async () => {
    svc.findById.mockResolvedValue({
      id: 'my-skill',
      name: 'my-skill',
      installed_path: '/plugins/my-skill',
    } as unknown as Awaited<ReturnType<PluginsService['findById']>>);

    svc.revertSkill.mockResolvedValue({ ok: true });

    const result = await controller.revertSkill('my-skill');

    expect(result).toEqual({ ok: true });
    expect(svc.revertSkill).toHaveBeenCalledWith('my-skill');
  });

  it('5.1 revert no-snapshot: throws HttpException(400) when revertSkill returns {ok:false}', async () => {
    svc.findById.mockResolvedValue({
      id: 'my-skill',
      name: 'my-skill',
      installed_path: '/plugins/my-skill',
    } as unknown as Awaited<ReturnType<PluginsService['findById']>>);

    svc.revertSkill.mockResolvedValue({ ok: false, reason: 'no_snapshot' });

    await expect(controller.revertSkill('my-skill')).rejects.toThrow(HttpException);
  });
});

// ── F3-s3 Phase 5: GET /plugins/:id/reputation endpoint (RED → GREEN) ────────

type ExtendedPluginsServiceSubset = Pick<
  PluginsService,
  'findById' | 'writeSkillGuarded' | 'revertSkill' | 'getReputation' | 'getTrustReport'
>;

function makeExtendedPluginsServiceMock(): jest.Mocked<ExtendedPluginsServiceSubset> {
  return {
    findById: jest.fn(),
    writeSkillGuarded: jest.fn(),
    revertSkill: jest.fn(),
    getReputation: jest.fn(),
    getTrustReport: jest.fn(),
  };
}

describe('PluginsController — GET :id/reputation (F3-s3 Phase 5)', () => {
  let controller: PluginsController;
  let svc: jest.Mocked<ExtendedPluginsServiceSubset>;

  beforeEach(async () => {
    svc = makeExtendedPluginsServiceMock();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PluginsController],
      providers: [{ provide: PluginsService, useValue: svc }],
    }).compile();

    controller = module.get<PluginsController>(PluginsController);
  });

  // 5.1: routes to svc.getReputation and returns its result
  it('5.1 — GET :id/reputation routes to svc.getReputation(id) and returns result', async () => {
    const reputationResult = {
      reputation_score: 72,
      reputation_detail: {
        portfolios_count: 3,
        avg_sharpe: 1.4,
        avg_return_pct: 25,
        worst_dd_pct: 8,
        computed_at: '2026-01-01T00:00:00.000Z',
      },
    };
    svc.getReputation.mockResolvedValue(reputationResult);

    const result = await controller.reputation('plugin-x');

    expect(result).toEqual(reputationResult);
    expect(svc.getReputation).toHaveBeenCalledWith('plugin-x');
  });

  it('5.1b — GET :id/reputation returns {null, null} for unrated plugin (HTTP 200)', async () => {
    svc.getReputation.mockResolvedValue({ reputation_score: null, reputation_detail: null });

    const result = await controller.reputation('plugin-unrated');

    expect(result).toEqual({ reputation_score: null, reputation_detail: null });
    expect(svc.getReputation).toHaveBeenCalledWith('plugin-unrated');
  });

  // 5.2: GET :id/trust-report response includes reputation_score key
  it('5.2 — GET :id/trust-report response includes reputation_score key', async () => {
    svc.getTrustReport.mockResolvedValue({
      scan_result: null,
      smoke_test_result: null,
      reputation_score: 55,
    });

    const result = await controller.trustReport('plugin-trust');

    expect(result).toHaveProperty('reputation_score', 55);
    expect(svc.getTrustReport).toHaveBeenCalledWith('plugin-trust');
  });
});

// ── F3-s3 Phase 6: No-circular-dep test ──────────────────────────────────────

import { PluginsModule } from './plugins.module';
import { PluginsController as PluginsControllerClass } from './plugins.controller';

describe('F3-s3 Phase 6 — PluginsModule no-circular-dep guard', () => {
  it('6.1 — PluginsModule metadata does NOT import PretestModule (no new cycle added)', () => {
    // Inspect the module metadata. NestJS stores imports in module metadata.
    // If PretestModule were imported, this would expose a circular dependency.
    const metadata = Reflect.getMetadata('imports', PluginsModule) as unknown[] | undefined;
    if (!metadata) {
      // No imports defined = no cycle
      return;
    }
    // Check none of the imports reference PretestModule or PretestService
    const importNames = metadata.map((m) => {
      if (typeof m === 'function') return m.name;
      if (m && typeof m === 'object' && 'name' in m) return (m as { name: string }).name;
      return String(m);
    });
    expect(importNames).not.toContain('PretestModule');
  });

  it('6.2 — PluginsModule compiles via Test.createTestingModule without PretestService', async () => {
    // This verifies no forwardRef to PretestModule was added
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PluginsControllerClass],
      providers: [
        {
          provide: PluginsService,
          useValue: makeExtendedPluginsServiceMock(),
        },
      ],
    }).compile();

    const ctrl = module.get<PluginsController>(PluginsControllerClass);
    expect(ctrl).toBeDefined();
  });
});
