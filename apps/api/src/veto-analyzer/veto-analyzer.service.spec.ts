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
import type { KvService } from '../common/kv.service';

// ── Helpers ───────────────────────────────────────────────────────────────────

function bar(ts: string, close: number): OhlcvBar {
  return { ts, open: close, high: close, low: close, close, volume: 1000 };
}

function makeDecision(overrides: Partial<VetoDecisionRow> = {}): VetoDecisionRow {
  return {
    id: 'd1',
    ts: new Date('2024-01-01T00:00:00.000Z'),
    symbol: 'AAPL',
    source_plugin: 'momentum',
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

// ── getPluginValue: per-plugin raw signal value attribution ────────────────────

describe('VetoAnalyzerService.getPluginValue', () => {
  function pluginRow(overrides: Partial<VetoDecisionRow> = {}): VetoDecisionRow {
    return makeDecision({
      cf_pnl: 10,
      cf_method: 'fixed_horizon:5:1d:costbps10:v1',
      cf_evaluated_at: new Date('2024-01-10T00:00:00.000Z'),
      ...overrides,
    });
  }

  it('groups by source_plugin, computing net_value/wins/win_rate/avg_cf_pnl, sorted best net_value first', async () => {
    const rows = [
      pluginRow({ id: 'a1', source_plugin: 'momentum', verdict: 'approved', cf_pnl: 100 }),
      pluginRow({ id: 'a2', source_plugin: 'momentum', verdict: 'blocked', cf_pnl: -40 }),
      pluginRow({ id: 'b1', source_plugin: 'mean-revert', verdict: 'modified', cf_pnl: -10 }),
      pluginRow({ id: 'b2', source_plugin: 'mean-revert', verdict: 'approved', cf_pnl: -5 }),
    ];
    const prisma = makePrisma(rows);
    const gateway = makeGateway([]);
    const svc = makeService(prisma, gateway);

    const report = await svc.getPluginValue();

    expect(report.plugins).toHaveLength(2);
    // momentum: net_value = 100 - 40 = 60, wins = 1, evaluated_count = 2, win_rate = 0.5
    const momentum = report.plugins.find((p) => p.source_plugin === 'momentum');
    expect(momentum).toBeDefined();
    expect(momentum?.net_value).toBeCloseTo(60, 6);
    expect(momentum?.wins).toBe(1);
    expect(momentum?.evaluated_count).toBe(2);
    expect(momentum?.win_rate).toBeCloseTo(0.5, 6);
    expect(momentum?.avg_cf_pnl).toBeCloseTo(30, 6);

    // mean-revert: net_value = -10 + -5 = -15, wins = 0
    const meanRevert = report.plugins.find((p) => p.source_plugin === 'mean-revert');
    expect(meanRevert?.net_value).toBeCloseTo(-15, 6);
    expect(meanRevert?.wins).toBe(0);

    // Sorted best net_value first: momentum (60) before mean-revert (-15).
    expect(report.plugins[0].source_plugin).toBe('momentum');
    expect(report.plugins[1].source_plugin).toBe('mean-revert');

    expect(report.totals.evaluated_count).toBe(4);
    expect(report.totals.net_value).toBeCloseTo(45, 6);
  });

  it('rows with terminal non-evaluated cf_method (unsupported_action/insufficient_data/invalid_ref_price) are excluded', async () => {
    const rows = [
      pluginRow({ id: 'a1', source_plugin: 'momentum', cf_pnl: 50 }),
      pluginRow({
        id: 'u1',
        source_plugin: 'momentum',
        cf_pnl: null,
        cf_method: 'unsupported_action',
      }),
      pluginRow({
        id: 'u2',
        source_plugin: 'momentum',
        cf_pnl: null,
        cf_method: 'insufficient_data',
      }),
      pluginRow({
        id: 'u3',
        source_plugin: 'momentum',
        cf_pnl: null,
        cf_method: 'invalid_ref_price',
      }),
    ];
    const prisma = makePrisma(rows);
    const gateway = makeGateway([]);
    const svc = makeService(prisma, gateway);

    const report = await svc.getPluginValue();

    expect(report.plugins).toHaveLength(1);
    expect(report.plugins[0].evaluated_count).toBe(1);
    expect(report.plugins[0].net_value).toBeCloseTo(50, 6);
    expect(report.totals.evaluated_count).toBe(1);
  });

  it('supports an optional { from, to } time window filter forwarded to the query', async () => {
    const prisma = makePrisma([pluginRow({ source_plugin: 'momentum' })]);
    const gateway = makeGateway([]);
    const svc = makeService(prisma, gateway);

    const from = new Date('2024-01-01T00:00:00.000Z');
    const to = new Date('2024-01-31T00:00:00.000Z');
    await svc.getPluginValue({ from, to });

    const findManyArgs = (
      (prisma.vetoDecision.findMany as jest.Mock).mock.calls[0] as unknown[]
    )[0] as {
      where: { ts?: { gte?: Date; lte?: Date } };
    };
    expect(findManyArgs.where.ts?.gte).toEqual(from);
    expect(findManyArgs.where.ts?.lte).toEqual(to);
  });

  it('no evaluated rows at all → empty plugins array, zeroed totals, no NaN', async () => {
    const prisma = makePrisma([]);
    const gateway = makeGateway([]);
    const svc = makeService(prisma, gateway);

    const report = await svc.getPluginValue();

    expect(report.plugins).toEqual([]);
    expect(report.totals.evaluated_count).toBe(0);
    expect(report.totals.net_value).toBe(0);
    expect(report.totals.wins).toBe(0);
    expect(report.totals.win_rate).toBe(0);
    expect(report.totals.avg_cf_pnl).toBe(0);
    expect(Number.isNaN(report.totals.win_rate)).toBe(false);
    expect(Number.isNaN(report.totals.avg_cf_pnl)).toBe(false);
  });

  it('null/blank source_plugin rows are bucketed under "unknown", not dropped', async () => {
    const rows = [
      pluginRow({ id: 'n1', source_plugin: '', cf_pnl: 20 }),
      pluginRow({ id: 'n2', source_plugin: 'momentum', cf_pnl: 5 }),
    ];
    const prisma = makePrisma(rows);
    const gateway = makeGateway([]);
    const svc = makeService(prisma, gateway);

    const report = await svc.getPluginValue();

    const unknown = report.plugins.find((p) => p.source_plugin === 'unknown');
    expect(unknown).toBeDefined();
    expect(unknown?.net_value).toBeCloseTo(20, 6);
    expect(report.totals.evaluated_count).toBe(2);
  });
});

// ── backfill scheduler: onModuleInit / onModuleDestroy / KV interval / fail-soft / overlap ──

function makeKv(
  kvData: Record<string, string | null> = {},
): jest.Mocked<Pick<KvService, 'get' | 'set'>> {
  const store: Record<string, string | null> = { ...kvData };
  return {
    get: jest.fn().mockImplementation((key: string) => Promise.resolve(store[key] ?? null)),
    set: jest.fn().mockImplementation((key: string, value: string) => {
      store[key] = value;
      return Promise.resolve();
    }),
  };
}

function makeServiceWithKv(
  prisma: ReturnType<typeof makePrisma>,
  gateway: ReturnType<typeof makeGateway>,
  kv: ReturnType<typeof makeKv>,
): VetoAnalyzerService {
  return new (VetoAnalyzerService as unknown as new (
    db: unknown,
    gateway: unknown,
    kv: unknown,
  ) => VetoAnalyzerService)(prisma, gateway, kv);
}

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

describe('VetoAnalyzerService — backfill scheduler', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('onModuleInit schedules a KV-configured interval that calls backfill() on each tick', async () => {
    const svc = makeServiceWithKv(
      makePrisma([]),
      makeGateway([]),
      makeKv({ 'veto.backfill_interval_ms': '10000' }),
    );
    const backfillSpy = jest.spyOn(svc, 'backfill').mockResolvedValue({
      evaluated: 0,
      insufficientData: 0,
      unsupportedAction: 0,
      invalidRefPrice: 0,
      pending: 0,
      errors: 0,
    });

    await svc.onModuleInit();
    // Deliberately does NOT run at startup — only on the interval.
    expect(backfillSpy).toHaveBeenCalledTimes(0);

    await jest.advanceTimersByTimeAsync(10_000);
    expect(backfillSpy).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(10_000);
    expect(backfillSpy).toHaveBeenCalledTimes(2);

    svc.onModuleDestroy();
  });

  it('uses the default interval (6h) when the KV key is absent', async () => {
    const svc = makeServiceWithKv(makePrisma([]), makeGateway([]), makeKv({}));
    const backfillSpy = jest.spyOn(svc, 'backfill').mockResolvedValue({
      evaluated: 0,
      insufficientData: 0,
      unsupportedAction: 0,
      invalidRefPrice: 0,
      pending: 0,
      errors: 0,
    });

    await svc.onModuleInit();

    // Just before 6h → no tick yet.
    await jest.advanceTimersByTimeAsync(SIX_HOURS_MS - 1000);
    expect(backfillSpy).toHaveBeenCalledTimes(0);

    // At 6h → exactly one tick.
    await jest.advanceTimersByTimeAsync(1000);
    expect(backfillSpy).toHaveBeenCalledTimes(1);

    svc.onModuleDestroy();
  });

  it('a KV interval of 0 disables the scheduler (no timer, backfill never ticks)', async () => {
    const svc = makeServiceWithKv(
      makePrisma([]),
      makeGateway([]),
      makeKv({ 'veto.backfill_interval_ms': '0' }),
    );
    const backfillSpy = jest.spyOn(svc, 'backfill').mockResolvedValue({
      evaluated: 0,
      insufficientData: 0,
      unsupportedAction: 0,
      invalidRefPrice: 0,
      pending: 0,
      errors: 0,
    });

    await svc.onModuleInit();
    await jest.advanceTimersByTimeAsync(SIX_HOURS_MS * 2);
    expect(backfillSpy).toHaveBeenCalledTimes(0);

    // onModuleDestroy must be safe even when no timer was ever started.
    expect(() => svc.onModuleDestroy()).not.toThrow();
  });

  it('fail-soft: a throwing backfill() never escapes the tick and the loop keeps ticking', async () => {
    const svc = makeServiceWithKv(
      makePrisma([]),
      makeGateway([]),
      makeKv({ 'veto.backfill_interval_ms': '5000' }),
    );
    const backfillSpy = jest.spyOn(svc, 'backfill').mockRejectedValue(new Error('db down'));

    await svc.onModuleInit();

    // First tick throws internally but must not reject out of the timer callback.
    await jest.advanceTimersByTimeAsync(5_000);
    expect(backfillSpy).toHaveBeenCalledTimes(1);

    // Loop survives the failure and keeps ticking.
    await jest.advanceTimersByTimeAsync(5_000);
    expect(backfillSpy).toHaveBeenCalledTimes(2);

    svc.onModuleDestroy();
  });

  it('overlap guard: a still-running backfill is not started again on the next tick', async () => {
    const svc = makeServiceWithKv(
      makePrisma([]),
      makeGateway([]),
      makeKv({ 'veto.backfill_interval_ms': '5000' }),
    );

    let resolveSlow: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => {
      resolveSlow = resolve;
    });
    const emptySummary = {
      evaluated: 0,
      insufficientData: 0,
      unsupportedAction: 0,
      invalidRefPrice: 0,
      pending: 0,
      errors: 0,
    };
    const backfillSpy = jest
      .spyOn(svc, 'backfill')
      .mockImplementationOnce(() => slow.then(() => emptySummary))
      .mockResolvedValue(emptySummary);

    await svc.onModuleInit();

    // First interval fire starts the slow backfill.
    await jest.advanceTimersByTimeAsync(5_000);
    expect(backfillSpy).toHaveBeenCalledTimes(1);

    // Timer fires again while the first tick is still in flight — overlap guard skips it.
    await jest.advanceTimersByTimeAsync(5_000);
    expect(backfillSpy).toHaveBeenCalledTimes(1);

    // Let the slow tick finish, then the next timer fire runs a fresh backfill.
    resolveSlow();
    await Promise.resolve();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(backfillSpy).toHaveBeenCalledTimes(2);

    svc.onModuleDestroy();
  });
});
