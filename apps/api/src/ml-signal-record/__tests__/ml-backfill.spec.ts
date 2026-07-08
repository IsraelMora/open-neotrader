/**
 * ml-backfill.spec.ts — Task 4.1 TDD RED → 4.2 GREEN
 *
 * ml-feature-extractor-s1: tests for outcome backfill in SnapshotService.takeSnapshot.
 *
 * Tests:
 * - takeSnapshot calls updateOutcomeAggregate(cycleId, total_pnl, equity) after writing snapshot.
 * - updateOutcomeAggregate throws → takeSnapshot still completes and returns NavEntry normally.
 * - @Optional absent → takeSnapshot result unchanged, no ml_signal_record write occurs.
 * - No-lookahead: backfill for C10 uses the snapshot's realized pnl (AFTER C10's decision).
 */
import { SnapshotService } from '../../snapshot/snapshot.service';
import { MlSignalRecordService } from '../ml-signal-record.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { ProviderGatewayService } from '../../providers/provider-gateway.service';
import type { LongTermMemoryService } from '../../long-term-memory/long-term-memory.service';

const CYCLE_ID = 'ml-snap-cycle-001';

// kernel-nav-source: takeSnapshot now reads the kernel's own paper wallet (Prisma
// `portfolio` row named 'paper') instead of gateway.getPortfolio(null). total_pnl is
// derived as `equity - initial_equity` (baseline defaults to `equity` — i.e. 0 P&L —
// when initial_equity is unknown, never a fabricated number). This fixture carries a
// real initial_equity so the pnl assertions below are meaningful (not tautological
// 0===0): equity 10500 - initial_equity 10000 = 500.
const INITIAL_EQUITY = 10000;
const EQUITY = 10500;
const EXPECTED_PNL = EQUITY - INITIAL_EQUITY;

const fakePaperState = {
  equity: EQUITY,
  cash: 5000,
  positions: [] as unknown[],
  hwm: EQUITY,
  initial_equity: INITIAL_EQUITY,
};

const fakePaperRow = {
  name: 'paper',
  data: JSON.stringify(fakePaperState),
  updatedAt: new Date(),
};

const fakeEntry = {
  id: 'snap-ml-1',
  ts: new Date(),
  cycle_id: CYCLE_ID,
  provider_id: 'kernel-paper',
  equity: EQUITY,
  cash: 5000,
  positions: '[]',
  total_pnl: EXPECTED_PNL,
  meta: null,
};

function makeGateway(): jest.Mocked<Pick<ProviderGatewayService, 'getPortfolio'>> {
  return {
    getPortfolio: jest.fn().mockResolvedValue(undefined),
  };
}

interface MockPrisma {
  navSnapshot: jest.Mocked<Pick<PrismaService['navSnapshot'], 'create'>>;
  portfolio: jest.Mocked<Pick<PrismaService['portfolio'], 'findUnique'>>;
}

function makePrisma(): MockPrisma {
  return {
    navSnapshot: {
      create: jest.fn().mockResolvedValue(fakeEntry),
    },
    portfolio: {
      findUnique: jest.fn().mockResolvedValue(fakePaperRow),
    },
  };
}

function makeLtm(): jest.Mocked<Pick<LongTermMemoryService, 'updateOutcome'>> {
  return {
    updateOutcome: jest.fn().mockResolvedValue(undefined),
  };
}

function makeMlSvc(opts?: {
  throws?: boolean;
}): jest.Mocked<Pick<MlSignalRecordService, 'updateOutcomeAggregate'>> {
  return {
    updateOutcomeAggregate: opts?.throws
      ? jest.fn().mockRejectedValue(new Error('ML DB error'))
      : jest.fn().mockResolvedValue(undefined),
  };
}

/**
 * Build SnapshotService with MlSignalRecordService wired.
 * Constructor: (db, gateway, longTermMemory?, mlSignalRecord?)
 */
function makeSnapshotServiceWithMl(
  prisma: ReturnType<typeof makePrisma>,
  gateway: ReturnType<typeof makeGateway>,
  ltm?: ReturnType<typeof makeLtm> | null,
  mlSvc?: ReturnType<typeof makeMlSvc> | null,
): SnapshotService {
  return new (SnapshotService as unknown as new (
    db: unknown,
    gateway: unknown,
    longTermMemory?: unknown,
    mlSignalRecord?: unknown,
  ) => SnapshotService)(prisma, gateway, ltm ?? undefined, mlSvc ?? undefined);
}

// ── Core backfill call ────────────────────────────────────────────────────────

describe('SnapshotService + MlSignalRecordService (ml-feature-extractor-s1)', () => {
  it('takeSnapshot calls updateOutcomeAggregate(cycleId, total_pnl, equity) after snapshot write', async () => {
    const prisma = makePrisma();
    const gateway = makeGateway();
    const mlSvc = makeMlSvc();
    const svc = makeSnapshotServiceWithMl(prisma, gateway, null, mlSvc);

    const result = await svc.takeSnapshot(CYCLE_ID);

    expect(result).toBeDefined();
    expect(result!.cycle_id).toBe(CYCLE_ID);
    expect(mlSvc.updateOutcomeAggregate).toHaveBeenCalledTimes(1);
    expect(mlSvc.updateOutcomeAggregate).toHaveBeenCalledWith(
      CYCLE_ID,
      fakeEntry.total_pnl,
      fakePaperState.equity,
    );
  });

  it('updateOutcomeAggregate throws → takeSnapshot still returns NavEntry (fail-soft)', async () => {
    const prisma = makePrisma();
    const gateway = makeGateway();
    const mlSvc = makeMlSvc({ throws: true });
    const svc = makeSnapshotServiceWithMl(prisma, gateway, null, mlSvc);

    const result = await svc.takeSnapshot(CYCLE_ID);

    expect(result).toBeDefined();
    expect(result!.total_pnl).toBe(fakeEntry.total_pnl);
  });

  it('@Optional absent (no mlSignalRecord) → takeSnapshot runs fine, no crash', async () => {
    const prisma = makePrisma();
    const gateway = makeGateway();
    const svc = makeSnapshotServiceWithMl(prisma, gateway, null, null);

    const result = await svc.takeSnapshot(CYCLE_ID);

    expect(result).toBeDefined();
    expect(result!.equity).toBe(10500);
  });

  it('no cycleId → updateOutcomeAggregate NOT called', async () => {
    const prisma = makePrisma();
    (prisma.navSnapshot.create as jest.Mock).mockResolvedValue({ ...fakeEntry, cycle_id: null });
    const gateway = makeGateway();
    const mlSvc = makeMlSvc();
    const svc = makeSnapshotServiceWithMl(prisma, gateway, null, mlSvc);

    await svc.takeSnapshot(); // no cycleId

    expect(mlSvc.updateOutcomeAggregate).not.toHaveBeenCalled();
  });

  it('no-lookahead: updateOutcomeAggregate uses portfolio values from the CURRENT snapshot (posterior to decision)', async () => {
    // The test verifies that the pnl/equity passed are the CURRENT snapshot's realized values,
    // not the decision cycle's own close. The timing is enforced by CALL SITE (same snapshot as LTM).
    const prisma = makePrisma();
    const gateway = makeGateway();
    const mlSvc = makeMlSvc();
    const svc = makeSnapshotServiceWithMl(prisma, gateway, null, mlSvc);

    // This snapshot processes the PREVIOUS cycle's outcome (cycleId = C10)
    // The portfolio values here are realized AFTER C10's decision
    await svc.takeSnapshot(CYCLE_ID);

    const [calledCycleId, calledPnl, calledEquity] = (mlSvc.updateOutcomeAggregate as jest.Mock)
      .mock.calls[0] as [string, number, number];
    expect(calledCycleId).toBe(CYCLE_ID);
    expect(calledPnl).toBe(fakeEntry.total_pnl); // realized AFTER the decision
    expect(calledEquity).toBe(fakePaperState.equity); // realized AFTER the decision
  });

  it('both LTM and ML backfill are called in same takeSnapshot (no interference)', async () => {
    const prisma = makePrisma();
    const gateway = makeGateway();
    const ltm = makeLtm();
    const mlSvc = makeMlSvc();
    const svc = makeSnapshotServiceWithMl(prisma, gateway, ltm, mlSvc);

    await svc.takeSnapshot(CYCLE_ID);

    expect(ltm.updateOutcome).toHaveBeenCalledWith(
      CYCLE_ID,
      fakeEntry.total_pnl,
      fakePaperState.equity,
    );
    expect(mlSvc.updateOutcomeAggregate).toHaveBeenCalledWith(
      CYCLE_ID,
      fakeEntry.total_pnl,
      fakePaperState.equity,
    );
  });
});
