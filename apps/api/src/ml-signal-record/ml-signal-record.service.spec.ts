/**
 * ml-signal-record.service.spec.ts — Task 2.1 TDD RED → 2.2 GREEN
 *
 * ml-feature-extractor-s1: unit tests for MlSignalRecordService.
 * All methods are fail-soft: catch → log.warn, never throw.
 */
import { MlSignalRecordService } from './ml-signal-record.service';
import type { PrismaService } from '../prisma/prisma.service';

// ── Helpers ───────────────────────────────────────────────────────────────────

type TxClient = {
  $executeRaw: jest.Mock;
};

function makePrisma(opts?: {
  txThrows?: boolean;
  executeRawThrows?: boolean;
  queryRawResult?: unknown[];
}): jest.Mocked<Pick<PrismaService, '$transaction' | '$executeRaw' | '$queryRaw'>> {
  const txClient: TxClient = { $executeRaw: jest.fn().mockResolvedValue(1) };

  const $transaction = opts?.txThrows
    ? jest.fn().mockRejectedValue(new Error('DB error'))
    : jest.fn().mockImplementation(async (fn: (tx: TxClient) => Promise<void>) => {
        await fn(txClient);
      });

  const $executeRaw = opts?.executeRawThrows
    ? jest.fn().mockRejectedValue(new Error('DB error'))
    : jest.fn().mockResolvedValue(1);

  const $queryRaw = jest.fn().mockResolvedValue(opts?.queryRawResult ?? []);

  return { $transaction, $executeRaw, $queryRaw };
}

function makeService(
  prisma: ReturnType<typeof makePrisma>,
): MlSignalRecordService {
  return new (MlSignalRecordService as unknown as new (
    db: unknown,
  ) => MlSignalRecordService)(prisma);
}

// ── computeActiveSkillHash ─────────────────────────────────────────────────────

describe('MlSignalRecordService.computeActiveSkillHash', () => {
  it('same ids in different order → same hash', () => {
    const svc = makeService(makePrisma());
    const h1 = svc.computeActiveSkillHash(['momentum', 'trend', 'mean-rev']);
    const h2 = svc.computeActiveSkillHash(['mean-rev', 'momentum', 'trend']);
    expect(h1).toBe(h2);
  });

  it('different set of ids → different hash', () => {
    const svc = makeService(makePrisma());
    const h1 = svc.computeActiveSkillHash(['momentum']);
    const h2 = svc.computeActiveSkillHash(['trend']);
    expect(h1).not.toBe(h2);
  });

  it('empty array → stable (no throw)', () => {
    const svc = makeService(makePrisma());
    const h1 = svc.computeActiveSkillHash([]);
    const h2 = svc.computeActiveSkillHash([]);
    expect(h1).toBe(h2);
    expect(typeof h1).toBe('string');
    expect(h1.length).toBe(16);
  });

  it('result is 16 hex chars', () => {
    const svc = makeService(makePrisma());
    const h = svc.computeActiveSkillHash(['momentum', 'trend']);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ── recordSignals ──────────────────────────────────────────────────────────────

describe('MlSignalRecordService.recordSignals', () => {
  it('2 symbols → 2 rows inserted via $transaction', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma);

    await svc.recordSignals(
      'C1',
      [
        {
          symbol: 'AAPL',
          skill_vector: [{ plugin_id: 'momentum', action: 'buy', confidence: 0.8 }],
          action: 'buy',
        },
        {
          symbol: 'MSFT',
          skill_vector: [{ plugin_id: 'trend', action: 'sell', confidence: 0.6 }],
          action: 'sell',
        },
      ],
      'hash123',
    );

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // The tx callback should have called $executeRaw twice (one per symbol)
    const txFn = (prisma.$transaction as jest.Mock).mock.calls[0][0] as (tx: TxClient) => Promise<void>;
    const txClient: TxClient = { $executeRaw: jest.fn().mockResolvedValue(1) };
    await txFn(txClient);
    expect(txClient.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it('skill_vector stored as JSON string round-trip', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma);
    const skillVector = [{ plugin_id: 'momentum', action: 'buy', confidence: 0.82 }];

    await svc.recordSignals('C2', [{ symbol: 'AAPL', skill_vector: skillVector, action: 'buy' }], 'hashABC');

    // Intercept what was passed to $executeRaw inside the transaction
    const txFn = (prisma.$transaction as jest.Mock).mock.calls[0][0] as (tx: TxClient) => Promise<void>;
    const txClient: TxClient = { $executeRaw: jest.fn().mockResolvedValue(1) };
    await txFn(txClient);

    const rawCall = (txClient.$executeRaw as jest.Mock).mock.calls[0];
    // The tagged template literal produces an array where strings and values alternate
    // We need to verify the serialized JSON is in the call args
    const callArgs = rawCall.flat(Infinity);
    const jsonArg = callArgs.find(
      (a: unknown) => typeof a === 'string' && a.includes('"momentum"'),
    );
    expect(jsonArg).toBeDefined();
    const parsed = JSON.parse(jsonArg as string);
    expect(parsed).toEqual([{ plugin_id: 'momentum', action: 'buy', confidence: 0.82 }]);
  });

  it('active_skill_hash passed through to the INSERT', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma);

    await svc.recordSignals('C3', [{ symbol: 'TSLA', skill_vector: [], action: 'hold' }], 'myhash16chars__');

    const txFn = (prisma.$transaction as jest.Mock).mock.calls[0][0] as (tx: TxClient) => Promise<void>;
    const txClient: TxClient = { $executeRaw: jest.fn().mockResolvedValue(1) };
    await txFn(txClient);

    const callArgs = (txClient.$executeRaw as jest.Mock).mock.calls[0].flat(Infinity);
    expect(callArgs).toContain('myhash16chars__');
  });

  it('outcome_pnl / outcome_equity are NOT passed (remain NULL at capture)', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma);

    await svc.recordSignals('C4', [{ symbol: 'AAPL', skill_vector: [], action: 'buy' }], 'hash');

    const txFn = (prisma.$transaction as jest.Mock).mock.calls[0][0] as (tx: TxClient) => Promise<void>;
    const txClient: TxClient = { $executeRaw: jest.fn().mockResolvedValue(1) };
    await txFn(txClient);

    // Verify that neither a numeric pnl nor equity value is passed — only null
    const callArgs = (txClient.$executeRaw as jest.Mock).mock.calls[0].flat(Infinity);
    // The INSERT should use NULL for outcome columns (not passing numeric values)
    const hasNullForOutcome = callArgs.includes(null);
    expect(hasNullForOutcome).toBe(true);
  });

  it('empty records array → no $transaction call, no throw', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma);

    await expect(svc.recordSignals('C5', [], 'hash')).resolves.toBeUndefined();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('fail-soft: $transaction throws → method returns without throwing', async () => {
    const prisma = makePrisma({ txThrows: true });
    const svc = makeService(prisma);

    await expect(
      svc.recordSignals('C6', [{ symbol: 'AAPL', skill_vector: [], action: 'buy' }], 'hash'),
    ).resolves.toBeUndefined();
  });

  it('fail-soft: warn is logged when $transaction throws', async () => {
    const prisma = makePrisma({ txThrows: true });
    const svc = makeService(prisma);
    const warnSpy = jest.spyOn((svc as unknown as { log: { warn: jest.Mock } }).log, 'warn');

    await svc.recordSignals('C7', [{ symbol: 'AAPL', skill_vector: [], action: 'buy' }], 'hash');

    expect(warnSpy).toHaveBeenCalled();
  });
});

// ── updateOutcomeAggregate ────────────────────────────────────────────────────

describe('MlSignalRecordService.updateOutcomeAggregate', () => {
  it('calls $executeRaw with cycle_id, pnl, equity', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma);

    await svc.updateOutcomeAggregate('C10', 125.5, 10500);

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const callArgs = (prisma.$executeRaw as jest.Mock).mock.calls[0].flat(Infinity);
    expect(callArgs).toContain('C10');
    expect(callArgs).toContain(125.5);
    expect(callArgs).toContain(10500);
  });

  it('non-matching cycle → $executeRaw called (UPDATE is no-op on 0 rows, but call happens)', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma);

    await svc.updateOutcomeAggregate('non-existent-cycle', 0, 0);

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('fail-soft: $executeRaw throws → method returns without throwing', async () => {
    const prisma = makePrisma({ executeRawThrows: true });
    const svc = makeService(prisma);

    await expect(svc.updateOutcomeAggregate('C10', 100, 10000)).resolves.toBeUndefined();
  });

  it('fail-soft: warn is logged when $executeRaw throws', async () => {
    const prisma = makePrisma({ executeRawThrows: true });
    const svc = makeService(prisma);
    const warnSpy = jest.spyOn((svc as unknown as { log: { warn: jest.Mock } }).log, 'warn');

    await svc.updateOutcomeAggregate('C10', 100, 10000);

    expect(warnSpy).toHaveBeenCalled();
  });
});

// ── getTrainingData ───────────────────────────────────────────────────────────

describe('MlSignalRecordService.getTrainingData', () => {
  it('returns only rows where outcome_pnl IS NOT NULL (labeled rows)', async () => {
    const labeledRows = [
      { id: '1', outcome_pnl: 10.5, outcome_equity: 10500 },
      { id: '2', outcome_pnl: -5.0, outcome_equity: 9800 },
    ];
    const prisma = makePrisma({ queryRawResult: labeledRows });
    const svc = makeService(prisma);

    const result = await svc.getTrainingData(10);

    expect(result).toHaveLength(2);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    // Verify the query includes outcome_pnl IS NOT NULL
    const callArgs = (prisma.$queryRaw as jest.Mock).mock.calls[0].flat(Infinity);
    const query = callArgs.join(' ');
    expect(query).toMatch(/outcome_pnl\s+IS\s+NOT\s+NULL/i);
  });

  it('respects the limit parameter', async () => {
    const prisma = makePrisma({ queryRawResult: [] });
    const svc = makeService(prisma);

    await svc.getTrainingData(5);

    const callArgs = (prisma.$queryRaw as jest.Mock).mock.calls[0].flat(Infinity);
    expect(callArgs).toContain(5);
  });

  it('returns [] on error (fail-soft)', async () => {
    const prisma = makePrisma();
    (prisma.$queryRaw as jest.Mock).mockRejectedValue(new Error('DB error'));
    const svc = makeService(prisma);

    const result = await svc.getTrainingData(10);

    expect(result).toEqual([]);
  });
});
