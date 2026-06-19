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
