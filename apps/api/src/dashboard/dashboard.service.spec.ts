/**
 * panel-backend-drift Fix 1 — DashboardService._buildEquityCurve oldest-N ordering bug.
 *
 * Same bug as SnapshotService.getHistory: the equity curve builder used
 * `orderBy: { ts: 'asc' }, take: limit`, returning the OLDEST `limit` snapshots
 * instead of the most recent `limit`. Fixed with the same desc+take+reverse pattern.
 */
import { DashboardService } from './dashboard.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { PluginsService } from '../plugins/plugins.service';

type NavSnapshotEquityRow = {
  ts: Date;
  equity: number;
  cash: number;
  total_pnl: number;
};

function makeRow(n: number): NavSnapshotEquityRow {
  return {
    ts: new Date(2026, 0, n),
    equity: 1000 + n,
    cash: 500,
    total_pnl: n,
  };
}

/** Minimal own shape (not derived from PrismaService's overloaded delegate types) so
 * mocked methods stay plain jest.fn() references — avoids @typescript-eslint/unbound-method
 * false positives that trigger when Pick<PrismaService, ...> carries the real delegates. */
interface FakePrisma {
  navSnapshot: {
    findFirst: jest.Mock;
    findMany: jest.Mock;
    groupBy: jest.Mock;
  };
  auditEntry: {
    count: jest.Mock;
    findFirst: jest.Mock;
    groupBy: jest.Mock;
  };
  plugin: {
    count: jest.Mock;
    findMany: jest.Mock;
  };
  alertEntry: {
    count: jest.Mock;
  };
}

function makePrisma(mostRecentDesc: NavSnapshotEquityRow[]): FakePrisma {
  return {
    navSnapshot: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue(mostRecentDesc),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    auditEntry: {
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(null),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    plugin: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    alertEntry: {
      count: jest.fn().mockResolvedValue(0),
    },
  };
}

function makeService(prisma: ReturnType<typeof makePrisma>): DashboardService {
  return new DashboardService(prisma as unknown as PrismaService, {} as unknown as PluginsService);
}

describe('DashboardService.getDashboard().equity_curve — most-recent-N window bug', () => {
  it('returns the MOST RECENT `limit` snapshots (not the oldest), in ascending order', async () => {
    // 10 synthetic rows increasing ts; ask for the most recent 5.
    const allRowsAsc = Array.from({ length: 10 }, (_, i) => makeRow(i + 1));
    const mostRecentDesc = allRowsAsc.slice().reverse().slice(0, 5);
    const prisma = makePrisma(mostRecentDesc);
    const service = makeService(prisma);

    const dashboard = await service.getDashboard(5);

    expect(dashboard.equity_curve.map((p) => p.equity)).toEqual([1006, 1007, 1008, 1009, 1010]);
    for (let i = 1; i < dashboard.equity_curve.length; i++) {
      expect(new Date(dashboard.equity_curve[i].ts).getTime()).toBeGreaterThan(
        new Date(dashboard.equity_curve[i - 1].ts).getTime(),
      );
    }
  });

  it('queries navSnapshot.findMany with orderBy desc + take limit (most-recent-N pattern)', async () => {
    const allRowsAsc = Array.from({ length: 10 }, (_, i) => makeRow(i + 1));
    const mostRecentDesc = allRowsAsc.slice().reverse().slice(0, 5);
    const prisma = makePrisma(mostRecentDesc);
    const service = makeService(prisma);

    await service.getDashboard(5);

    expect(prisma.navSnapshot.findMany).toHaveBeenCalledWith({
      orderBy: { ts: 'desc' },
      take: 5,
      select: { ts: true, equity: true, cash: true, total_pnl: true },
    });
  });
});
