import { Test, TestingModule } from '@nestjs/testing';
import { PretestSchedulerService } from './pretest-scheduler.service';
import { KvService } from '../common/kv.service';
import { PretestService } from '../pretest/pretest.service';

describe('PretestSchedulerService', () => {
  let service: PretestSchedulerService;
  let kv: { get: jest.Mock; set: jest.Mock };
  let pretest: { runAllActive: jest.Mock };

  beforeEach(async () => {
    kv = { get: jest.fn(), set: jest.fn() };
    pretest = { runAllActive: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PretestSchedulerService,
        { provide: KvService, useValue: kv },
        { provide: PretestService, useValue: pretest },
      ],
    }).compile();

    service = module.get(PretestSchedulerService);
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
  });

  const tick = () => (service as unknown as { tick: () => Promise<void> }).tick();

  // _currentSlot / _isDue are private pure helpers; we test them directly
  // because their arithmetic is the core contract of the fixed-slot scheduler.
  describe('slot arithmetic', () => {
    it('currentSlot floors time to multiples of the interval since epoch', () => {
      const interval = 4 * 60 * 60_000; // 4h
      const t = 4 * interval + 12 * 60_000; // 4 slots + 12 min
      expect(
        (service as unknown as { _currentSlot: (n: number, i: number) => number })._currentSlot(
          t,
          interval,
        ),
      ).toBe(4 * interval);
    });

    it('currentSlot with 1h interval aligns to wall-clock hours', () => {
      const interval = 3_600_000;
      const t = 5 * interval + 123_456;
      expect(
        (service as unknown as { _currentSlot: (n: number, i: number) => number })._currentSlot(
          t,
          interval,
        ),
      ).toBe(5 * interval);
    });

    it('isDue is true when there is no previous run', () => {
      expect(
        (
          service as unknown as { _isDue: (n: number, i: number, l: number | null) => boolean }
        )._isDue(1_000, 100, null),
      ).toBe(true);
    });

    it('isDue is true when current slot is strictly after last run', () => {
      const interval = 100;
      expect(
        (
          service as unknown as { _isDue: (n: number, i: number, l: number | null) => boolean }
        )._isDue(250, interval, 100),
      ).toBe(true);
    });

    it('isDue is false when current slot equals last run', () => {
      const interval = 100;
      expect(
        (
          service as unknown as { _isDue: (n: number, i: number, l: number | null) => boolean }
        )._isDue(199, interval, 100),
      ).toBe(false);
    });

    it('isDue is false when still inside the same slot', () => {
      const interval = 100;
      expect(
        (
          service as unknown as { _isDue: (n: number, i: number, l: number | null) => boolean }
        )._isDue(150, interval, 100),
      ).toBe(false);
    });

    it('currentSlot at the exact boundary belongs to the new slot', () => {
      const interval = 100;
      expect(
        (service as unknown as { _currentSlot: (n: number, i: number) => number })._currentSlot(
          300,
          interval,
        ),
      ).toBe(300);
      expect(
        (
          service as unknown as { _isDue: (n: number, i: number, l: number | null) => boolean }
        )._isDue(300, interval, 200),
      ).toBe(true);
      expect(
        (
          service as unknown as { _isDue: (n: number, i: number, l: number | null) => boolean }
        )._isDue(300, interval, 300),
      ).toBe(false);
    });
  });

  describe('tick execution', () => {
    it('does NOT run at boot time inside the same slot', async () => {
      const interval = 4 * 60 * 60_000;
      const now = 5 * interval + 5 * 60_000; // 5 slots + 5 min
      jest.useFakeTimers({ doNotFake: ['setImmediate'] });
      jest.setSystemTime(now);

      kv.get.mockResolvedValue(String(interval));
      await service.onModuleInit();

      pretest.runAllActive.mockResolvedValue([]);
      await tick();

      expect(pretest.runAllActive).not.toHaveBeenCalled();
    });

    it('runs when the next slot boundary is reached', async () => {
      const interval = 4 * 60 * 60_000;
      const boot = 5 * interval + 5 * 60_000;
      jest.useFakeTimers({ doNotFake: ['setImmediate'] });
      jest.setSystemTime(boot);

      kv.get.mockResolvedValue(String(interval));
      await service.onModuleInit();

      pretest.runAllActive.mockResolvedValue([]);

      // Advance to the next slot boundary
      jest.setSystemTime(6 * interval);
      await tick();

      expect(pretest.runAllActive).toHaveBeenCalledTimes(1);
    });

    it('runs once per slot even if tick is called multiple times', async () => {
      const interval = 4 * 60 * 60_000;
      const boot = 5 * interval + 1_000;
      jest.useFakeTimers({ doNotFake: ['setImmediate'] });
      jest.setSystemTime(boot);

      kv.get.mockResolvedValue(String(interval));
      await service.onModuleInit();

      pretest.runAllActive.mockResolvedValue([]);

      jest.setSystemTime(6 * interval);
      await tick();
      await tick();
      await tick();

      expect(pretest.runAllActive).toHaveBeenCalledTimes(1);
    });

    it('skips to the current slot after a long downtime (no catch-up storm)', async () => {
      const interval = 4 * 60 * 60_000;
      const boot = 5 * interval + 5 * 60_000;
      jest.useFakeTimers({ doNotFake: ['setImmediate'] });
      jest.setSystemTime(boot);

      kv.get.mockResolvedValue(String(interval));
      await service.onModuleInit();

      pretest.runAllActive.mockResolvedValue([]);

      // Jump 3 slots ahead (12h downtime)
      jest.setSystemTime(9 * interval);
      await tick();

      expect(pretest.runAllActive).toHaveBeenCalledTimes(1);
      // Next tick in the same slot should not run again
      await tick();
      expect(pretest.runAllActive).toHaveBeenCalledTimes(1);
    });

    it('does nothing when scheduler is disabled', async () => {
      kv.get.mockResolvedValue('-1');
      await service.onModuleInit();
      pretest.runAllActive.mockResolvedValue([]);

      await tick();

      expect(pretest.runAllActive).not.toHaveBeenCalled();
    });

    it('is resilient to runAllActive failure and schedules the next slot', async () => {
      const interval = 4 * 60 * 60_000;
      const boot = 5 * interval + 5 * 60_000;
      jest.useFakeTimers({ doNotFake: ['setImmediate'] });
      jest.setSystemTime(boot);

      kv.get.mockResolvedValue(String(interval));
      await service.onModuleInit();

      pretest.runAllActive.mockRejectedValue(new Error('boom'));

      jest.setSystemTime(6 * interval);
      await expect(tick()).resolves.not.toThrow();

      // After failure, next slot should still be able to run
      pretest.runAllActive.mockResolvedValue([]);
      jest.setSystemTime(7 * interval);
      await tick();
      expect(pretest.runAllActive).toHaveBeenCalledTimes(2);
    });

    it('skips a tick while a previous run is still in flight (overlap guard)', async () => {
      const interval = 4 * 60 * 60_000;
      const boot = 5 * interval + 5 * 60_000;
      jest.useFakeTimers({ doNotFake: ['setImmediate'] });
      jest.setSystemTime(boot);

      kv.get.mockResolvedValue(String(interval));
      await service.onModuleInit();

      // Hold the first run unresolved
      let releaseRun: (value: unknown[]) => void;
      const runPromise = new Promise<unknown[]>((resolve) => {
        releaseRun = resolve;
      });
      pretest.runAllActive.mockReturnValue(runPromise);

      jest.setSystemTime(6 * interval);
      const firstTick = tick();

      // Second tick while the first is still pending must not start another run
      await tick();
      expect(pretest.runAllActive).toHaveBeenCalledTimes(1);

      releaseRun!([]);
      await firstTick;
    });

    it('adapts to an interval change at the next tick', async () => {
      const interval4h = 4 * 60 * 60_000;
      const interval6h = 6 * 60 * 60_000;
      const boot = 2 * interval4h + 5 * 60_000; // 08:05 with 4h slots
      jest.useFakeTimers({ doNotFake: ['setImmediate'] });
      jest.setSystemTime(boot);

      // Start with 4h interval
      kv.get.mockResolvedValue(String(interval4h));
      await service.onModuleInit();
      pretest.runAllActive.mockResolvedValue([]);

      // Next 4h slot (12:00) runs
      jest.setSystemTime(3 * interval4h);
      await tick();
      expect(pretest.runAllActive).toHaveBeenCalledTimes(1);

      // Switch to 6h interval while inside the 12:00-18:00 window.
      // With 6h slots the boundaries are 12:00 and 18:00, so the current slot
      // is still 12:00 and no new run should happen yet.
      kv.get.mockResolvedValue(String(interval6h));
      jest.setSystemTime(3 * interval4h + 30 * 60_000); // 12:30
      await tick();
      expect(pretest.runAllActive).toHaveBeenCalledTimes(1);

      // 18:00 boundary (6h slot) runs
      jest.setSystemTime(3 * interval6h);
      await tick();
      expect(pretest.runAllActive).toHaveBeenCalledTimes(2);
    });

    it('falls back to the default interval when KV read fails during init', async () => {
      const defaultInterval = 6 * 60 * 60_000;
      // Boot at 05:00 with default 6h slots -> slot 00:00
      const boot = defaultInterval + 5 * 60 * 60_000;
      jest.useFakeTimers({ doNotFake: ['setImmediate'] });
      jest.setSystemTime(boot);

      // First KV read (onModuleInit) fails; subsequent reads use the default interval.
      kv.get.mockRejectedValueOnce(new Error('KV down'));
      kv.get.mockResolvedValue(String(defaultInterval));
      await service.onModuleInit();
      pretest.runAllActive.mockResolvedValue([]);

      // Next 6h slot (12:00) runs
      jest.setSystemTime(2 * defaultInterval);
      await tick();
      expect(pretest.runAllActive).toHaveBeenCalledTimes(1);
    });
  });
});
