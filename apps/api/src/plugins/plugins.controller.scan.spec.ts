/**
 * plugins.controller.scan.spec.ts — Phase 4 TDD RED: scan endpoints
 *
 * F3-s1: Static AST Analysis — controller endpoint tests.
 * Tests:
 *   - POST /plugins/:id/scan → rescan, returns updated scan_result
 *   - GET /plugins/:id/trust-report → returns stored scan_result or null
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PluginsController } from './plugins.controller';
import { PluginsService } from './plugins.service';

const STORED_SCAN = {
  ok: true,
  findings: [
    {
      severity: 'warning',
      category: 'risky_import',
      file: 'plugin.py',
      line: 1,
      message: 'subprocess',
    },
  ],
  summary: { warn_count: 1, info_count: 0 },
};

function makeSvcMock(): jest.Mocked<
  Pick<
    PluginsService,
    'findById' | 'writeSkillGuarded' | 'revertSkill' | 'rescan' | 'getTrustReport'
  >
> {
  return {
    findById: jest.fn(),
    writeSkillGuarded: jest.fn(),
    revertSkill: jest.fn(),
    rescan: jest.fn(),
    getTrustReport: jest.fn(),
  };
}

describe('PluginsController — POST :id/scan (F3-s1)', () => {
  let controller: PluginsController;
  let svc: ReturnType<typeof makeSvcMock>;

  beforeEach(async () => {
    svc = makeSvcMock();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PluginsController],
      providers: [{ provide: PluginsService, useValue: svc }],
    }).compile();

    controller = module.get<PluginsController>(PluginsController);
  });

  afterEach(() => jest.clearAllMocks());

  it('f3s1-4.4 — POST /plugins/:id/scan calls rescan and returns updated plugin with scan_result', async () => {
    const updatedPlugin = {
      id: 'my-plugin',
      name: 'My Plugin',
      scan_result: JSON.stringify(STORED_SCAN),
    };
    svc.rescan.mockResolvedValue(
      updatedPlugin as unknown as Awaited<ReturnType<PluginsService['rescan']>>,
    );

    const result = await controller.scan('my-plugin');

    expect(svc.rescan).toHaveBeenCalledWith('my-plugin');
    expect(result).toEqual(updatedPlugin);
  });
});

describe('PluginsController — GET :id/trust-report (F3-s1)', () => {
  let controller: PluginsController;
  let svc: ReturnType<typeof makeSvcMock>;

  beforeEach(async () => {
    svc = makeSvcMock();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PluginsController],
      providers: [{ provide: PluginsService, useValue: svc }],
    }).compile();

    controller = module.get<PluginsController>(PluginsController);
  });

  afterEach(() => jest.clearAllMocks());

  it('f3s1-4.5 — GET /plugins/:id/trust-report with stored scan_result → returns { scan_result: {...} }', async () => {
    svc.getTrustReport.mockResolvedValue({
      scan_result: STORED_SCAN,
      smoke_test_result: null,
      reputation_score: null,
    });

    const result = await controller.trustReport('my-plugin');

    expect(svc.getTrustReport).toHaveBeenCalledWith('my-plugin');
    expect(result).toEqual({
      scan_result: STORED_SCAN,
      smoke_test_result: null,
      reputation_score: null,
    });
  });

  it('f3s1-4.6 — GET /plugins/:id/trust-report with null scan_result → returns { scan_result: null }', async () => {
    svc.getTrustReport.mockResolvedValue({
      scan_result: null,
      smoke_test_result: null,
      reputation_score: null,
    });

    const result = await controller.trustReport('unscanned-plugin');

    expect(svc.getTrustReport).toHaveBeenCalledWith('unscanned-plugin');
    expect(result).toEqual({ scan_result: null, smoke_test_result: null, reputation_score: null });
  });
});
