/**
 * F6-S2 PR2 — SnapshotService integration with LongTermMemoryService.
 *
 * Tests that:
 * - takeSnapshot calls longTermMemory.updateOutcome(cycleId, pnl, equity) when LTM is injected.
 * - updateOutcome() throws → snapshot still written, no rethrow.
 * - @Optional null (no LTM) → takeSnapshot still returns NavEntry, no crash.
 */
import { SnapshotService } from './snapshot.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { ProviderGatewayService, Portfolio } from '../providers/provider-gateway.service';
import type { LongTermMemoryService } from '../long-term-memory/long-term-memory.service';

const CYCLE_ID = 'snap-cycle-001';

const fakePortfolio: Portfolio = {
  provider_id: 'alpaca',
  equity: 10500,
  cash: 5000,
  buying_power: 5000,
  positions: [],
  total_market_value: 5500,
  total_pnl: 500,
  ts: new Date().toISOString(),
};

const fakeEntry = {
  id: 'snap-1',
  ts: new Date(),
  cycle_id: CYCLE_ID,
  provider_id: 'alpaca',
  equity: 10500,
  cash: 5000,
  positions: '[]',
  total_pnl: 500,
  meta: null,
};

function makeGateway(): jest.Mocked<Pick<ProviderGatewayService, 'getPortfolio'>> {
  return {
    getPortfolio: jest.fn().mockResolvedValue(fakePortfolio),
  };
}

function makePrisma(): jest.Mocked<Pick<PrismaService, 'navSnapshot'>> {
  return {
    navSnapshot: {
      create: jest.fn().mockResolvedValue(fakeEntry),
    } as unknown as PrismaService['navSnapshot'],
  };
}

function makeLtm(): jest.Mocked<Pick<LongTermMemoryService, 'updateOutcome'>> {
  return {
    updateOutcome: jest.fn().mockResolvedValue(undefined),
  };
}

function makeSnapshotService(
  prisma: ReturnType<typeof makePrisma>,
  gateway: ReturnType<typeof makeGateway>,
  ltm?: ReturnType<typeof makeLtm> | null,
): SnapshotService {
  return new (SnapshotService as unknown as new (
    db: unknown,
    gateway: unknown,
    longTermMemory?: unknown,
  ) => SnapshotService)(prisma, gateway, ltm ?? undefined);
}

describe('F6-S2 PR2 — SnapshotService + LongTermMemory', () => {
  it('2.5a — takeSnapshot calls updateOutcome with cycleId, pnl, equity after writing snapshot', async () => {
    const prisma = makePrisma();
    const gateway = makeGateway();
    const ltm = makeLtm();
    const service = makeSnapshotService(prisma, gateway, ltm);

    const result = await service.takeSnapshot(CYCLE_ID);

    expect(result).toBeDefined();
    expect(result!.cycle_id).toBe(CYCLE_ID);
    expect(ltm.updateOutcome).toHaveBeenCalledTimes(1);
    expect(ltm.updateOutcome).toHaveBeenCalledWith(CYCLE_ID, fakePortfolio.total_pnl, fakePortfolio.equity);
  });

  it('2.5b — updateOutcome() throws → snapshot still returned, no rethrow', async () => {
    const prisma = makePrisma();
    const gateway = makeGateway();
    const ltm = makeLtm();
    ltm.updateOutcome.mockRejectedValue(new Error('LTM down'));
    const service = makeSnapshotService(prisma, gateway, ltm);

    const result = await service.takeSnapshot(CYCLE_ID);

    // Snapshot must still be returned
    expect(result).toBeDefined();
    expect(result!.total_pnl).toBe(500);
  });

  it('2.5c — @Optional null (no LTM) → takeSnapshot runs fine, no crash', async () => {
    const prisma = makePrisma();
    const gateway = makeGateway();
    const service = makeSnapshotService(prisma, gateway, null);

    const result = await service.takeSnapshot(CYCLE_ID);

    expect(result).toBeDefined();
    expect(result!.equity).toBe(10500);
  });

  it('2.5d — takeSnapshot without cycleId → updateOutcome NOT called (no cycleId to update)', async () => {
    const prisma = makePrisma();
    // Return entry without cycle_id
    (prisma.navSnapshot.create as jest.Mock).mockResolvedValue({ ...fakeEntry, cycle_id: null });
    const gateway = makeGateway();
    const ltm = makeLtm();
    const service = makeSnapshotService(prisma, gateway, ltm);

    await service.takeSnapshot(); // no cycleId arg

    expect(ltm.updateOutcome).not.toHaveBeenCalled();
  });
});
