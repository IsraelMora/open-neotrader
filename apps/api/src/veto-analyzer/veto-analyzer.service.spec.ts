/**
 * veto-analyzer.service.spec.ts — TDD RED → GREEN.
 *
 * VetoAnalyzerService: read-side "veto value analyzer" — fixed-horizon, direction-aware,
 * cost-adjusted counterfactual P&L for veto_decisions, plus net veto value aggregation.
 *
 * Style mirrors ml-signal-record.service.spec.ts: hand-mocked
 * jest.Mocked<Pick<PrismaService, 'vetoDecision'>> + hand-mocked ProviderGatewayService,
 * deterministic bar fixtures, no real network.
 */
import { VetoAnalyzerService, type VetoDecisionRow } from './veto-analyzer.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { ProviderGatewayService, OhlcvBar } from '../providers/provider-gateway.service';

// ── Helpers ───────────────────────────────────────────────────────────────────

function bar(ts: string, close: number): OhlcvBar {
  return { ts, open: close, high: close, low: close, close, volume: 1000 };
}

function makeDecision(overrides: Partial<VetoDecisionRow> = {}): VetoDecisionRow {
  return {
    id: 'd1',
    ts: new Date('2024-01-01T00:00:00.000Z'),
    symbol: 'AAPL',
    verdict: 'blocked',
    proposed_action: 'long',
    proposed_qty: 10,
    approved_qty: null,
    ref_price: 100,
    discipline: 'drawdown-guard',
    cf_pnl: null,
    cf_method: null,
    cf_evaluated_at: null,
    ...overrides,
  };
}

function makePrisma(
  rows: VetoDecisionRow[] = [],
): jest.Mocked<Pick<PrismaService, 'vetoDecision'>> {
  return {
    vetoDecision: {
      findMany: jest.fn().mockResolvedValue(rows),
      update: jest.fn().mockResolvedValue({}),
    },
  } as unknown as jest.Mocked<Pick<PrismaService, 'vetoDecision'>>;
}

function makeGateway(
  bars: OhlcvBar[] | ((symbol: string) => OhlcvBar[]),
): jest.Mocked<Pick<ProviderGatewayService, 'getOhlcv'>> {
  return {
    getOhlcv: jest.fn().mockImplementation((_pluginId: string | null, symbol: string) => {
      const result = typeof bars === 'function' ? bars(symbol) : bars;
      return Promise.resolve(result);
    }),
  };
}

function makeService(
  prisma: ReturnType<typeof makePrisma>,
  gateway: ReturnType<typeof makeGateway>,
): VetoAnalyzerService {
  return new (VetoAnalyzerService as unknown as new (
    db: unknown,
    gateway: unknown,
  ) => VetoAnalyzerService)(prisma, gateway);
}

/** 5 daily bars strictly after the decision ts (2024-01-01), horizonBars=5 default → bar[4] is the mark bar. */
const FIVE_BARS_LOSS: OhlcvBar[] = [
  bar('2024-01-02T00:00:00.000Z', 101),
  bar('2024-01-03T00:00:00.000Z', 102),
  bar('2024-01-04T00:00:00.000Z', 103),
  bar('2024-01-05T00:00:00.000Z', 104),
  bar('2024-01-06T00:00:00.000Z', 90), // mark bar → loss for a long
];

const FIVE_BARS_PROFIT: OhlcvBar[] = [
  bar('2024-01-02T00:00:00.000Z', 101),
  bar('2024-01-03T00:00:00.000Z', 102),
  bar('2024-01-04T00:00:00.000Z', 103),
  bar('2024-01-05T00:00:00.000Z', 104),
  bar('2024-01-06T00:00:00.000Z', 120), // mark bar → profit for a long
];

// costBps default = 10 bps = 0.001 decimal
const COST = 0.001;

// ── backfill: counterfactual computation ───────────────────────────────────────

describe('VetoAnalyzerService.backfill — counterfactual computation', () => {
  it('blocked decision + counterfactual LOSS on proposed trade → net_value contribution positive (= -cf_pnl)', async () => {
    const decision = makeDecision({ verdict: 'blocked', ref_price: 100, proposed_qty: 10 });
    const prisma = makePrisma([decision]);
    const gateway = makeGateway(FIVE_BARS_LOSS);
    const svc = makeService(prisma, gateway);

    const summary = await svc.backfill();

    expect(summary.evaluated).toBe(1);
    const gross = (90 - 100) / 100;
    const net = gross - COST;
    const expectedCfPnl = net * 100 * 10;
    expect(expectedCfPnl).toBeLessThan(0); // loss on the proposed trade

    const updateCall = (
      (prisma.vetoDecision.update as jest.Mock).mock.calls[0] as unknown[]
    )[0] as {
      data: { cf_pnl: number; cf_method: string };
    };
    expect(updateCall.data.cf_pnl).toBeCloseTo(expectedCfPnl, 6);
    expect(updateCall.data.cf_method).toBe('fixed_horizon:5:1d:costbps10:v1');

    // Net veto value contribution for a blocked decision = -cf_pnl (positive here, loss avoided).
    const contribution = -updateCall.data.cf_pnl;
    expect(contribution).toBeGreaterThan(0);
  });

  it('blocked decision + counterfactual PROFIT on proposed trade → net_value contribution negative', async () => {
    const decision = makeDecision({ verdict: 'blocked', ref_price: 100, proposed_qty: 10 });
    const prisma = makePrisma([decision]);
    const gateway = makeGateway(FIVE_BARS_PROFIT);
    const svc = makeService(prisma, gateway);

    await svc.backfill();

    const updateCall = (
      (prisma.vetoDecision.update as jest.Mock).mock.calls[0] as unknown[]
    )[0] as {
      data: { cf_pnl: number };
    };
    expect(updateCall.data.cf_pnl).toBeGreaterThan(0); // profit was blocked

    const contribution = -updateCall.data.cf_pnl;
    expect(contribution).toBeLessThan(0); // blocking a winner is negative value
  });

  it('modified decision (approved_qty < proposed_qty) → contributes net_unit_return * ref * (approved - proposed)', async () => {
    const decision = makeDecision({
      verdict: 'modified',
      ref_price: 100,
      proposed_qty: 10,
      approved_qty: 4,
    });
    const prisma = makePrisma([decision]);
    const gateway = makeGateway(FIVE_BARS_PROFIT); // mark = 120
    const svc = makeService(prisma, gateway);

    await svc.backfill();

    const updateCall = (
      (prisma.vetoDecision.update as jest.Mock).mock.calls[0] as unknown[]
    )[0] as {
      data: { cf_pnl: number };
    };
    const gross = (120 - 100) / 100;
    const net = gross - COST;
    const expectedCfPnl = net * 100 * 10; // proposed_qty
    expect(updateCall.data.cf_pnl).toBeCloseTo(expectedCfPnl, 6);

    const expectedContribution = net * 100 * (4 - 10);
    const executedPnl = net * 100 * 4;
    expect(executedPnl - updateCall.data.cf_pnl).toBeCloseTo(expectedContribution, 6);
  });

  it("proposed_action 'exit' → cf_method = unsupported_action, cf_pnl = null, excluded but counted", async () => {
    const decision = makeDecision({ proposed_action: 'exit', verdict: 'blocked' });
    const prisma = makePrisma([decision]);
    const gateway = makeGateway(FIVE_BARS_LOSS);
    const svc = makeService(prisma, gateway);

    const summary = await svc.backfill();

    expect(summary.unsupportedAction).toBe(1);
    expect(summary.evaluated).toBe(0);
    const updateCall = (
      (prisma.vetoDecision.update as jest.Mock).mock.calls[0] as unknown[]
    )[0] as {
      data: { cf_pnl: null; cf_method: string };
    };
    expect(updateCall.data.cf_method).toBe('unsupported_action');
    expect(updateCall.data.cf_pnl).toBeNull();
    // getOhlcv should not even be called for unsupported actions.
    expect(gateway.getOhlcv).not.toHaveBeenCalled();
  });

  it('insufficient bars after ts (fewer than horizonBars) → cf_method = insufficient_data, excluded but counted', async () => {
    const decision = makeDecision();
    const prisma = makePrisma([decision]);
    const gateway = makeGateway(FIVE_BARS_LOSS.slice(0, 3)); // only 3 bars after ts, need 5
    const svc = makeService(prisma, gateway);

    const summary = await svc.backfill();

    expect(summary.insufficientData).toBe(1);
    expect(summary.evaluated).toBe(0);
    const updateCall = (
      (prisma.vetoDecision.update as jest.Mock).mock.calls[0] as unknown[]
    )[0] as {
      data: { cf_pnl: null; cf_method: string };
    };
    expect(updateCall.data.cf_method).toBe('insufficient_data');
    expect(updateCall.data.cf_pnl).toBeNull();
  });

  it('missing ref_price → invalid_ref_price (not insufficient_data — no OHLCV fetch needed)', async () => {
    const decision = makeDecision({ ref_price: null });
    const prisma = makePrisma([decision]);
    const gateway = makeGateway(FIVE_BARS_LOSS);
    const svc = makeService(prisma, gateway);

    const summary = await svc.backfill();

    expect(summary.invalidRefPrice).toBe(1);
    const updateCall = (
      (prisma.vetoDecision.update as jest.Mock).mock.calls[0] as unknown[]
    )[0] as {
      data: { cf_method: string };
    };
    expect(updateCall.data.cf_method).toBe('invalid_ref_price');
    expect(gateway.getOhlcv).not.toHaveBeenCalled();
  });

  it('fail-soft per row: provider throws for one symbol → other rows still evaluated and written', async () => {
    const good = makeDecision({ id: 'good', symbol: 'MSFT' });
    const bad = makeDecision({ id: 'bad', symbol: 'TSLA' });
    const prisma = makePrisma([bad, good]);
    const gateway = makeGateway((symbol: string) => {
      if (symbol === 'TSLA') throw new Error('provider outage');
      return FIVE_BARS_LOSS;
    });
    const svc = makeService(prisma, gateway);

    const summary = await svc.backfill();

    expect(summary.evaluated).toBe(1);
    expect(summary.errors).toBe(1);
    // Only the good row got an update() call.
    const updateCalls = (prisma.vetoDecision.update as jest.Mock).mock.calls as unknown[];
    expect(updateCalls).toHaveLength(1);
    const updateCall = (
      (prisma.vetoDecision.update as jest.Mock).mock.calls[0] as unknown[]
    )[0] as {
      where: { id: string };
    };
    expect(updateCall.where.id).toBe('good');
  });

  it('no unevaluated rows → evaluated 0, no updates', async () => {
    const prisma = makePrisma([]);
    const gateway = makeGateway(FIVE_BARS_LOSS);
    const svc = makeService(prisma, gateway);

    const summary = await svc.backfill();

    expect(summary.evaluated).toBe(0);
    expect(summary.insufficientData).toBe(0);
    expect(summary.unsupportedAction).toBe(0);
    const updateCalls = (prisma.vetoDecision.update as jest.Mock).mock.calls as unknown[];
    expect(updateCalls).toHaveLength(0);
  });

  // ── Fix 1: invalid ref_price must never poison cf_pnl with NaN/Infinity ─────

  it('ref_price = 0 → cf_method = invalid_ref_price, cf_pnl null, never NaN/Infinity, no OHLCV fetch', async () => {
    const decision = makeDecision({ ref_price: 0 });
    const prisma = makePrisma([decision]);
    const gateway = makeGateway(FIVE_BARS_LOSS);
    const svc = makeService(prisma, gateway);

    const summary = await svc.backfill();

    expect(summary.evaluated).toBe(0);
    expect(summary.invalidRefPrice).toBe(1);
    const updateCall = (
      (prisma.vetoDecision.update as jest.Mock).mock.calls[0] as unknown[]
    )[0] as {
      data: { cf_pnl: number | null; cf_method: string };
    };
    expect(updateCall.data.cf_method).toBe('invalid_ref_price');
    expect(updateCall.data.cf_pnl).toBeNull();
    expect(Number.isNaN(updateCall.data.cf_pnl as unknown as number)).toBe(false);
    expect(gateway.getOhlcv).not.toHaveBeenCalled();
  });

  it('ref_price = NaN → cf_method = invalid_ref_price, cf_pnl never NaN', async () => {
    const decision = makeDecision({ ref_price: NaN });
    const prisma = makePrisma([decision]);
    const gateway = makeGateway(FIVE_BARS_LOSS);
    const svc = makeService(prisma, gateway);

    const summary = await svc.backfill();

    expect(summary.invalidRefPrice).toBe(1);
    const updateCall = (
      (prisma.vetoDecision.update as jest.Mock).mock.calls[0] as unknown[]
    )[0] as {
      data: { cf_pnl: number | null; cf_method: string };
    };
    expect(updateCall.data.cf_method).toBe('invalid_ref_price');
    expect(updateCall.data.cf_pnl).toBeNull();
  });

  it('ref_price = -50 (negative) → cf_method = invalid_ref_price', async () => {
    const decision = makeDecision({ ref_price: -50 });
    const prisma = makePrisma([decision]);
    const gateway = makeGateway(FIVE_BARS_LOSS);
    const svc = makeService(prisma, gateway);

    const summary = await svc.backfill();

    expect(summary.invalidRefPrice).toBe(1);
  });

  it('getMetrics never surfaces NaN in net_value even if an invalid_ref_price row exists', async () => {
    const invalidRow = makeDecision({
      id: 'invalid',
      cf_pnl: null,
      cf_method: 'invalid_ref_price',
      cf_evaluated_at: new Date('2024-01-10T00:00:00.000Z'),
    });
    const prisma = makePrisma([invalidRow]);
    const gateway = makeGateway([]);
    const svc = makeService(prisma, gateway);

    const report = await svc.getMetrics();

    expect(Number.isNaN(report.net_value)).toBe(false);
    expect(report.net_value).toBe(0);
    expect(report.evaluated_count).toBe(0);
  });

  // ── Fix 2/3: maturity-aware pending state + dynamic, decision-anchored fetch window ──

  it('decision too recent (horizon bar cannot exist yet) → pending, cf_method stays null, no OHLCV fetch, no update()', async () => {
    // horizonBars=5 on '1d' → matures 5 days after ts. Decision made 1 hour ago is nowhere near mature.
    const recentTs = new Date(Date.now() - 60 * 60 * 1000);
    const decision = makeDecision({ ts: recentTs });
    const prisma = makePrisma([decision]);
    const gateway = makeGateway(FIVE_BARS_LOSS);
    const svc = makeService(prisma, gateway);

    const summary = await svc.backfill();

    expect(summary.pending).toBe(1);
    expect(summary.evaluated).toBe(0);
    expect(summary.insufficientData).toBe(0);
    expect(gateway.getOhlcv).not.toHaveBeenCalled();
    expect((prisma.vetoDecision.update as jest.Mock).mock.calls).toHaveLength(0);
  });

  it('pending decision is re-selected and evaluated once bars exist on a later backfill', async () => {
    // ts far enough in the past that 5 daily bars have had time to print, with bar fixtures
    // anchored relative to "now" (not the fixed 2024 fixture, which would be irrelevant here).
    const oldTs = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const dayMs = 24 * 60 * 60 * 1000;
    const barsAfterOldTs: OhlcvBar[] = [1, 2, 3, 4, 5].map((n) =>
      bar(new Date(oldTs.getTime() + n * dayMs).toISOString(), 100 + n),
    );
    const decision = makeDecision({ ts: oldTs });
    const prisma = makePrisma([decision]);
    const gateway = makeGateway(barsAfterOldTs);
    const svc = makeService(prisma, gateway);

    const summary = await svc.backfill();

    expect(summary.pending).toBe(0);
    expect(summary.evaluated).toBe(1);
    expect(gateway.getOhlcv).toHaveBeenCalled();
  });

  it('mature old decision → getOhlcv is called with a dynamic limit sized to the decision age', async () => {
    // ~100 days old, daily timeframe, horizonBars=5 default.
    const oldTs = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    const decision = makeDecision({ ts: oldTs });
    const prisma = makePrisma([decision]);
    const gateway = makeGateway(FIVE_BARS_LOSS);
    const svc = makeService(prisma, gateway);

    await svc.backfill();

    expect(gateway.getOhlcv).toHaveBeenCalledTimes(1);
    const call = (gateway.getOhlcv as jest.Mock).mock.calls[0] as unknown[];
    const limitArg = call[3] as number;
    // Must be sized to roughly cover 100 days back + horizon + buffer — NOT the old static 500,
    // and NOT the tiny default horizonBars-only window either.
    expect(limitArg).toBeGreaterThanOrEqual(100 + 5);
    expect(limitArg).toBeLessThan(500);
  });

  it('mature decision but beyond the fetch cap depth → terminal insufficient_data (not pending)', async () => {
    // Extremely old decision on daily bars — neededLimit is capped at MAX_FETCH_LIMIT, so a
    // real provider's trailing window can't reach back far enough. Simulated here by a
    // provider response that only has 2 bars after ts (fewer than horizonBars=5) — a stand-in
    // for "the cap-limited fetch never reaches the Nth bar after such an old decision".
    const veryOldTs = new Date(Date.now() - 10_000 * 24 * 60 * 60 * 1000);
    const decision = makeDecision({ ts: veryOldTs });
    const prisma = makePrisma([decision]);
    const shortBars: OhlcvBar[] = [
      bar(new Date(veryOldTs.getTime() + 24 * 60 * 60 * 1000).toISOString(), 101),
      bar(new Date(veryOldTs.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString(), 102),
    ];
    const gateway = makeGateway(shortBars);
    const svc = makeService(prisma, gateway);

    const summary = await svc.backfill();

    expect(summary.insufficientData).toBe(1);
    expect(summary.pending).toBe(0);
    const call = (gateway.getOhlcv as jest.Mock).mock.calls[0] as unknown[];
    const limitArg = call[3] as number;
    expect(limitArg).toBeLessThanOrEqual(1500);
    const updateCall = (
      (prisma.vetoDecision.update as jest.Mock).mock.calls[0] as unknown[]
    )[0] as {
      data: { cf_method: string; cf_pnl: number | null };
    };
    expect(updateCall.data.cf_method).toBe('insufficient_data');
    expect(updateCall.data.cf_pnl).toBeNull();
  });

  it('reprocessInsufficient: false (default) → insufficient_data rows are never re-selected', async () => {
    const prisma = makePrisma([]); // findMany mock controlled by where-arg assertion below
    const gateway = makeGateway(FIVE_BARS_LOSS);
    const svc = makeService(prisma, gateway);

    await svc.backfill();

    const whereArg = (
      (prisma.vetoDecision.findMany as jest.Mock).mock.calls[0] as unknown[]
    )[0] as {
      where: Record<string, unknown>;
    };
    expect(whereArg.where).toEqual({ cf_pnl: null, cf_method: null });
  });

  it('reprocessInsufficient: true → re-selects insufficient_data but not unsupported_action/invalid_ref_price', async () => {
    const prisma = makePrisma([]);
    const gateway = makeGateway(FIVE_BARS_LOSS);
    const svc = makeService(prisma, gateway);

    await svc.backfill({ reprocessInsufficient: true });

    const whereArg = (
      (prisma.vetoDecision.findMany as jest.Mock).mock.calls[0] as unknown[]
    )[0] as {
      where: { OR: Array<Record<string, unknown>> };
    };
    // Must include the normal unevaluated-row selector AND insufficient_data rows...
    const orClauses = whereArg.where.OR;
    expect(orClauses).toContainEqual({ cf_pnl: null, cf_method: null });
    expect(orClauses).toContainEqual({ cf_method: 'insufficient_data' });
    // ...but never unsupported_action or invalid_ref_price (those are legitimately terminal).
    const serialized = JSON.stringify(orClauses);
    expect(serialized).not.toContain('unsupported_action');
    expect(serialized).not.toContain('invalid_ref_price');
  });

  // ── Fix 5: robust timestamp comparison (epoch ms, not lexicographic string compare) ──

  it('mixed-precision intraday timestamps (":00Z" vs ":00.500Z") order correctly by epoch ms', async () => {
    // Lexicographic compare would misorder these because "12:00:00.500Z" < "12:00:01Z" as a
    // STRING only up to a point, but real-world providers mix precision inconsistently —
    // use a case where naive string compare picks the wrong "after" set / wrong Nth bar.
    const decisionTs = new Date('2024-01-01T12:00:00Z');
    const decision = makeDecision({ ts: decisionTs, verdict: 'blocked' });
    const prisma = makePrisma([decision]);
    // Bars with mixed millisecond precision, deliberately given in non-epoch-sorted string order
    // to prove the analyzer sorts/filters by parsed epoch ms, not by string.
    const bars: OhlcvBar[] = [
      bar('2024-01-01T12:00:00.500Z', 101), // epoch: 12:00:00.500 — 1st after decision
      bar('2024-01-01T12:00:01.000Z', 102), // 2nd
      bar('2024-01-01T12:00:02.000Z', 103), // 3rd
      bar('2024-01-01T12:00:03.000Z', 104), // 4th
      bar('2024-01-01T12:00:04.000Z', 90), // 5th → mark bar (loss)
    ];
    const gateway = makeGateway(bars);
    const svc = makeService(prisma, gateway);

    const summary = await svc.backfill();

    expect(summary.evaluated).toBe(1);
    const updateCall = (
      (prisma.vetoDecision.update as jest.Mock).mock.calls[0] as unknown[]
    )[0] as { data: { cf_pnl: number } };
    const gross = (90 - 100) / 100;
    const net = gross - COST;
    const expectedCfPnl = net * 100 * 10;
    expect(updateCall.data.cf_pnl).toBeCloseTo(expectedCfPnl, 6);
  });

  it('unparseable bar timestamp is skipped (never counted as "after" the decision)', async () => {
    const decision = makeDecision({ ts: new Date('2024-01-01T00:00:00.000Z') });
    const prisma = makePrisma([decision]);
    const bars: OhlcvBar[] = [bar('not-a-real-timestamp', 999), ...FIVE_BARS_LOSS];
    const gateway = makeGateway(bars);
    const svc = makeService(prisma, gateway);

    const summary = await svc.backfill();

    // Should still evaluate normally off the 5 valid bars — the garbage bar is ignored, not
    // counted, and does not crash or shift the Nth-bar selection.
    expect(summary.evaluated).toBe(1);
  });
});

// ── getMetrics: net veto value aggregation ──────────────────────────────────────

describe('VetoAnalyzerService.getMetrics', () => {
  function evaluatedBlockedLoss(overrides: Partial<VetoDecisionRow> = {}): VetoDecisionRow {
    // cf_pnl = -101 (loss avoided) → contribution +101
    return makeDecision({
      id: 'blocked-loss',
      verdict: 'blocked',
      discipline: 'drawdown-guard',
      cf_pnl: -101,
      cf_method: 'fixed_horizon:5:1d:costbps10:v1',
      cf_evaluated_at: new Date('2024-01-10T00:00:00.000Z'),
      ...overrides,
    });
  }

  function evaluatedBlockedProfit(overrides: Partial<VetoDecisionRow> = {}): VetoDecisionRow {
    // cf_pnl = +199 (profit forgone) → contribution -199
    return makeDecision({
      id: 'blocked-profit',
      verdict: 'blocked',
      discipline: 'risk-cap',
      cf_pnl: 199,
      cf_method: 'fixed_horizon:5:1d:costbps10:v1',
      cf_evaluated_at: new Date('2024-01-10T00:00:00.000Z'),
      ...overrides,
    });
  }

  function evaluatedApproved(overrides: Partial<VetoDecisionRow> = {}): VetoDecisionRow {
    return makeDecision({
      id: 'approved',
      verdict: 'approved',
      discipline: null,
      cf_pnl: 50,
      cf_method: 'fixed_horizon:5:1d:costbps10:v1',
      cf_evaluated_at: new Date('2024-01-10T00:00:00.000Z'),
      ...overrides,
    });
  }

  function unsupported(overrides: Partial<VetoDecisionRow> = {}): VetoDecisionRow {
    return makeDecision({
      id: 'unsupported',
      verdict: 'blocked',
      proposed_action: 'exit',
      cf_pnl: null,
      cf_method: 'unsupported_action',
      cf_evaluated_at: new Date('2024-01-10T00:00:00.000Z'),
      ...overrides,
    });
  }

  function insufficient(overrides: Partial<VetoDecisionRow> = {}): VetoDecisionRow {
    return makeDecision({
      id: 'insufficient',
      verdict: 'blocked',
      cf_pnl: null,
      cf_method: 'insufficient_data',
      cf_evaluated_at: new Date('2024-01-10T00:00:00.000Z'),
      ...overrides,
    });
  }

  it('aggregates net_value, losses_avoided, profits_forgone, and verdict/eval counts', async () => {
    const rows = [
      evaluatedBlockedLoss(),
      evaluatedBlockedProfit(),
      evaluatedApproved(),
      unsupported(),
      insufficient(),
    ];
    const prisma = makePrisma(rows);
    const gateway = makeGateway([]);
    const svc = makeService(prisma, gateway);

    const report = await svc.getMetrics();

    // net_value = 101 (blocked loss) + (-199) (blocked profit) + 0 (approved) = -98
    expect(report.net_value).toBeCloseTo(-98, 6);
    expect(report.losses_avoided).toBeCloseTo(101, 6);
    expect(report.profits_forgone).toBeCloseTo(-199, 6);
    expect(report.evaluated_count).toBe(3);
    expect(report.unsupported_action_count).toBe(1);
    expect(report.insufficient_data_count).toBe(1);
    expect(report.counts_by_verdict).toEqual({ approved: 1, blocked: 4, modified: 0 });
  });

  it('per-discipline net value breakdown', async () => {
    const rows = [evaluatedBlockedLoss(), evaluatedBlockedProfit(), evaluatedApproved()];
    const prisma = makePrisma(rows);
    const gateway = makeGateway([]);
    const svc = makeService(prisma, gateway);

    const report = await svc.getMetrics();

    expect(report.by_discipline['drawdown-guard']).toBeCloseTo(101, 6);
    expect(report.by_discipline['risk-cap']).toBeCloseTo(-199, 6);
  });

  it('supports an optional { from, to } time window filter forwarded to the query', async () => {
    const prisma = makePrisma([evaluatedBlockedLoss()]);
    const gateway = makeGateway([]);
    const svc = makeService(prisma, gateway);

    const from = new Date('2024-01-01T00:00:00.000Z');
    const to = new Date('2024-01-31T00:00:00.000Z');
    await svc.getMetrics({ from, to });

    const findManyArgs = (
      (prisma.vetoDecision.findMany as jest.Mock).mock.calls[0] as unknown[]
    )[0] as {
      where: { ts?: { gte?: Date; lte?: Date } };
    };
    expect(findManyArgs.where.ts?.gte).toEqual(from);
    expect(findManyArgs.where.ts?.lte).toEqual(to);
  });

  it('modified decision contributes net_unit_return * ref * (approved - proposed) to net_value', async () => {
    // cf_pnl computed at proposed_qty=10 with net_unit_return implied 0.099 → cf_pnl=99
    const modified = makeDecision({
      id: 'modified-1',
      verdict: 'modified',
      ref_price: 100,
      proposed_qty: 10,
      approved_qty: 4,
      discipline: 'position-sizer',
      cf_pnl: 99,
      cf_method: 'fixed_horizon:5:1d:costbps10:v1',
      cf_evaluated_at: new Date('2024-01-10T00:00:00.000Z'),
    });
    const prisma = makePrisma([modified]);
    const gateway = makeGateway([]);
    const svc = makeService(prisma, gateway);

    const report = await svc.getMetrics();

    // net_unit_return = cf_pnl / (proposed_qty * ref_price) = 99 / 1000 = 0.099
    // contribution = net_unit_return * ref_price * (approved - proposed) = 0.099*100*(4-10) = -59.4
    expect(report.net_value).toBeCloseTo(-59.4, 6);
  });

  it('empty result set → all zeroes, no throw', async () => {
    const prisma = makePrisma([]);
    const gateway = makeGateway([]);
    const svc = makeService(prisma, gateway);

    const report = await svc.getMetrics();

    expect(report.net_value).toBe(0);
    expect(report.evaluated_count).toBe(0);
    expect(report.counts_by_verdict).toEqual({ approved: 0, blocked: 0, modified: 0 });
  });
});
