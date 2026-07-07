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

type RealNavSnapshotRow = {
  ts: Date;
  equity: number;
  hwm: number;
};

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
    expect(ltm.updateOutcome).toHaveBeenCalledWith(
      CYCLE_ID,
      fakePortfolio.total_pnl,
      fakePortfolio.equity,
    );
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

/**
 * real-money-accounting — SnapshotService.getRealEquityCurve
 *
 * Tests that:
 * - Points are returned sorted chronologically (oldest → newest), shape { ts, equity, hwm }.
 * - findMany is called with orderBy: { ts: 'desc' }, take: limit (most-recent-N query),
 *   and the service reverses the result before returning (verified via output order,
 *   not just call args — the DB mock returns desc rows, we assert the mapped output is asc).
 * - No rows → returns [].
 */
describe('SnapshotService.getRealEquityCurve', () => {
  function makeRealPrisma(rows: RealNavSnapshotRow[]): {
    realNavSnapshot: jest.Mocked<Pick<PrismaService['realNavSnapshot'], 'findMany'>>;
  } {
    return {
      realNavSnapshot: {
        findMany: jest.fn().mockResolvedValue(rows),
      },
    };
  }

  function makeService(prisma: ReturnType<typeof makeRealPrisma>): SnapshotService {
    return new (SnapshotService as unknown as new (db: unknown) => SnapshotService)(prisma);
  }

  it('returns points sorted chronologically ascending with { ts, equity, hwm } shape', async () => {
    const rows: RealNavSnapshotRow[] = [
      { ts: new Date('2026-06-03T00:00:00Z'), equity: 300, hwm: 300 },
      { ts: new Date('2026-06-02T00:00:00Z'), equity: 200, hwm: 200 },
      { ts: new Date('2026-06-01T00:00:00Z'), equity: 100, hwm: 100 },
    ];
    const prisma = makeRealPrisma(rows);
    const service = makeService(prisma);

    const result = await service.getRealEquityCurve(3);

    expect(result).toEqual([
      { ts: '2026-06-01T00:00:00.000Z', equity: 100, hwm: 100 },
      { ts: '2026-06-02T00:00:00.000Z', equity: 200, hwm: 200 },
      { ts: '2026-06-03T00:00:00.000Z', equity: 300, hwm: 300 },
    ]);
  });

  it('queries with orderBy desc + take limit (most-recent-N), and returns the correct N most-recent rows in ascending order', async () => {
    // Simulate 5 total rows in the DB; the mock DB itself only returns the 3 most recent
    // (as findMany with take:3 would), already desc-ordered — exactly what Prisma would return.
    const mostRecentThreeDesc: RealNavSnapshotRow[] = [
      { ts: new Date('2026-06-05T00:00:00Z'), equity: 500, hwm: 500 },
      { ts: new Date('2026-06-04T00:00:00Z'), equity: 400, hwm: 400 },
      { ts: new Date('2026-06-03T00:00:00Z'), equity: 300, hwm: 300 },
    ];
    const prisma = makeRealPrisma(mostRecentThreeDesc);
    const service = makeService(prisma);

    const result = await service.getRealEquityCurve(3);

    expect(prisma.realNavSnapshot.findMany).toHaveBeenCalledWith({
      orderBy: { ts: 'desc' },
      take: 3,
      select: { ts: true, equity: true, hwm: true },
    });
    // Output must be the 3 most-recent rows, in ascending (chronological) order.
    expect(result).toEqual([
      { ts: '2026-06-03T00:00:00.000Z', equity: 300, hwm: 300 },
      { ts: '2026-06-04T00:00:00.000Z', equity: 400, hwm: 400 },
      { ts: '2026-06-05T00:00:00.000Z', equity: 500, hwm: 500 },
    ]);
  });

  it('returns [] when there are no rows', async () => {
    const prisma = makeRealPrisma([]);
    const service = makeService(prisma);

    const result = await service.getRealEquityCurve();

    expect(result).toEqual([]);
  });

  it('defaults limit to 252 when not provided', async () => {
    const prisma = makeRealPrisma([]);
    const service = makeService(prisma);

    await service.getRealEquityCurve();

    expect(prisma.realNavSnapshot.findMany).toHaveBeenCalledWith({
      orderBy: { ts: 'desc' },
      take: 252,
      select: { ts: true, equity: true, hwm: true },
    });
  });
});

/**
 * panel-backend-drift Fix 1 — SnapshotService.getHistory oldest-N ordering bug.
 *
 * getHistory used `orderBy: { ts: 'asc' }, take: limit`, which returns the OLDEST
 * `limit` rows instead of the most recent `limit` rows. This mirrors the correct
 * pattern already used by getRealEquityCurve: query `orderBy: { ts: 'desc' },
 * take: limit` then reverse in memory, so the result stays chronologically
 * ascending (oldest-of-the-window first) AND is bounded to the most recent window.
 */
describe('SnapshotService.getHistory — most-recent-N window bug', () => {
  type NavSnapshotRow = {
    id: string;
    ts: Date;
    cycle_id: string | null;
    provider_id: string | null;
    equity: number;
    cash: number;
    positions: string;
    total_pnl: number;
    meta: string | null;
  };

  function makeRow(n: number): NavSnapshotRow {
    return {
      id: `snap-${n}`,
      ts: new Date(2026, 0, n), // increasing ts as n increases
      cycle_id: null,
      provider_id: 'alpaca',
      equity: 1000 + n,
      cash: 500,
      positions: '[]',
      total_pnl: n,
      meta: null,
    };
  }

  function makePrismaWithMostRecentDesc(
    allRowsAsc: NavSnapshotRow[],
    limit: number,
  ): { navSnapshot: jest.Mocked<Pick<PrismaService['navSnapshot'], 'findMany'>> } {
    // Simulate what Prisma would actually return for orderBy desc + take limit:
    // the most recent `limit` rows, in descending order.
    const mostRecentDesc = allRowsAsc
      .slice()
      .reverse()
      .slice(0, limit);
    return {
      navSnapshot: {
        findMany: jest.fn().mockResolvedValue(mostRecentDesc),
      },
    };
  }

  function makeService(prisma: ReturnType<typeof makePrismaWithMostRecentDesc>): SnapshotService {
    return new (SnapshotService as unknown as new (db: unknown) => SnapshotService)(prisma);
  }

  it('returns the MOST RECENT `limit` rows (not the oldest), in ascending order', async () => {
    // 10 synthetic rows, increasing ts; ask for the most recent 5.
    const allRowsAsc = Array.from({ length: 10 }, (_, i) => makeRow(i + 1));
    const prisma = makePrismaWithMostRecentDesc(allRowsAsc, 5);
    const service = makeService(prisma);

    const result = await service.getHistory(5);

    // Expect rows 6..10 (the most recent 5), ascending.
    expect(result.map((r) => r.id)).toEqual(['snap-6', 'snap-7', 'snap-8', 'snap-9', 'snap-10']);
    // Ascending chronological order preserved.
    for (let i = 1; i < result.length; i++) {
      expect(result[i].ts.getTime()).toBeGreaterThan(result[i - 1].ts.getTime());
    }
  });

  it('queries with orderBy desc + take limit (most-recent-N pattern)', async () => {
    const allRowsAsc = Array.from({ length: 10 }, (_, i) => makeRow(i + 1));
    const prisma = makePrismaWithMostRecentDesc(allRowsAsc, 5);
    const service = makeService(prisma);

    await service.getHistory(5);

    expect(prisma.navSnapshot.findMany).toHaveBeenCalledWith({
      orderBy: { ts: 'desc' },
      take: 5,
    });
  });
});
