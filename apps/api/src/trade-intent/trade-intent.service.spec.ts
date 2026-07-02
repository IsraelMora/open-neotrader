/**
 * trade-intent.service.spec.ts — TDD RED → GREEN
 *
 * PAPER trade-execution layer with human-in-the-loop (HITL) and autonomous execution.
 * All tests use MOCKED PrismaService + MOCKED ProviderGatewayService + MOCKED KvService — no real DB/network.
 *
 * Real-money execution is intentionally NOT wired. Any mode != "paper" must throw.
 */

import { TradeIntentService } from './trade-intent.service';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal sub-type of PrismaService needed by TradeIntentService. */
type MockPrisma = {
  tradeIntent: {
    create: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
  };
  portfolio: {
    findUnique: jest.Mock;
    upsert: jest.Mock;
  };
  strategy: {
    findUnique: jest.Mock;
    update: jest.Mock;
  };
  realNavSnapshot: {
    findFirst: jest.Mock;
  };
  realPosition: {
    count: jest.Mock;
  };
};

function makePrisma(): MockPrisma {
  return {
    tradeIntent: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    portfolio: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
    strategy: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    realNavSnapshot: {
      findFirst: jest.fn(),
    },
    realPosition: {
      count: jest.fn(),
    },
  };
}

type MockGateway = { getQuote: jest.Mock; placeOrder: jest.Mock; getPortfolio: jest.Mock };

function makeGateway(): MockGateway {
  return { getQuote: jest.fn(), placeOrder: jest.fn(), getPortfolio: jest.fn() };
}

type MockKv = { get: jest.Mock; set: jest.Mock; delete: jest.Mock };

function makeKv(): MockKv {
  return {
    get: jest.fn(),
    set: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  };
}

type MockAudit = { log: jest.Mock };

function makeAudit(): MockAudit {
  return { log: jest.fn().mockResolvedValue(undefined) };
}

type MockRealOrder = { submit: jest.Mock };

type MockReconciliation = { fastPollOrder: jest.Mock };

/** Default fastPollOrder() resolution: resolves immediately (happy path — no rejection to swallow). */
function makeReconciliation(): MockReconciliation {
  return { fastPollOrder: jest.fn().mockResolvedValue(undefined) };
}

/**
 * Default submit() resolution: a "submitted" RealOrder row — the happy path where the
 * broker accepted the order. Individual tests override via `.mockResolvedValueOnce` /
 * `.mockResolvedValue` for submit_failed or a specific real_order id.
 */
function makeRealOrderService(): MockRealOrder {
  return {
    submit: jest.fn().mockResolvedValue({
      id: 'ro_default',
      status: 'submitted',
      client_order_id: 'nt-default',
      broker_order_id: 'broker_default',
      error: null,
    }),
  };
}

function makeService(
  prisma: MockPrisma,
  gateway: MockGateway,
  kv: MockKv,
  realOrderService?: MockRealOrder,
  audit?: MockAudit,
  reconciliation?: MockReconciliation,
): TradeIntentService {
  return new (TradeIntentService as unknown as new (
    db: unknown,
    gw: unknown,
    kv: unknown,
    realOrderService: unknown,
    reconciliation: unknown,
    audit?: unknown,
  ) => TradeIntentService)(
    prisma,
    gateway,
    kv,
    realOrderService ?? makeRealOrderService(),
    reconciliation ?? makeReconciliation(),
    audit,
  );
}

/**
 * Wires a passing walk-forward gate: an applied strategy (KV strategy.applied) whose
 * Strategy row carries a fresh ROBUSTO verdict. Real execution requires this on top of
 * execution.real=true + broker_plugin_id. NOTE: call AFTER any kv.get.mockImplementation
 * so the strategy.applied branch is present — helpers below already include it.
 */
function mockRobustAppliedStrategy(
  prisma: MockPrisma,
  verdict: string | null = 'ROBUSTO',
  checkedAt: Date | null = new Date(),
): void {
  prisma.strategy.findUnique.mockResolvedValue({
    id: 's_live',
    walk_forward_verdict: verdict,
    walk_forward_checked_at: checkedAt,
  });
}

/** Minimal paper portfolio state stored in Portfolio.data (JSON). */
const EMPTY_PORTFOLIO_DATA = JSON.stringify({
  equity: 10_000,
  cash: 10_000,
  positions: [],
});

/** A pending TradeIntent row as returned from Prisma. */
function pendingIntent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ti_001',
    cycle_id: null,
    symbol: 'AAPL',
    action: 'long',
    confidence: 0.8,
    rationale: 'Bullish momentum',
    timeframe: '1d',
    mode: 'paper',
    status: 'pending',
    created_at: new Date(),
    decided_at: null,
    decided_by: null,
    reject_reason: null,
    fill_price: null,
    quantity: null,
    realized_pnl: null,
    result_json: null,
    ...overrides,
  };
}

/**
 * Typed wrapper for `expect.objectContaining` — avoids `@typescript-eslint/no-unsafe-assignment`
 * caused by the `any` return type of `expect.objectContaining` in `@types/jest`.
 */
function oc<T extends object>(obj: T): T {
  return expect.objectContaining(obj) as T;
}

/** Wire gateway.getQuote to return a standard AAPL quote (bid:149/ask:151/last:150). */
function mockAaplQuote(gateway: MockGateway): void {
  gateway.getQuote.mockResolvedValue({
    symbol: 'AAPL',
    bid: 149,
    ask: 151,
    last: 150,
    ts: new Date().toISOString(),
  });
}

/** Wire prisma.portfolio.findUnique to return an empty paper portfolio. */
function mockPaperPortfolio(prisma: MockPrisma): void {
  prisma.portfolio.findUnique.mockResolvedValue({
    name: 'paper',
    data: EMPTY_PORTFOLIO_DATA,
    updatedAt: new Date(),
  });
}

/**
 * Wire prisma.realNavSnapshot/realPosition to a real account state. Defaults mirror the
 * paper defaults ($10k, no drawdown, 0 open positions) so existing real-mode tests that don't
 * care about real-account accounting specifically keep their original qty/gate math. Override
 * individual fields per test to prove real-vs-paper divergence.
 */
function mockRealAccountState(
  prisma: MockPrisma,
  overrides: {
    equity?: number;
    hwm?: number;
    buying_power?: number;
    openPositionsCount?: number;
    ts?: Date;
  } = {},
): void {
  const equity = overrides.equity ?? 10_000;
  prisma.realNavSnapshot.findFirst.mockResolvedValue({
    id: 'nav_1',
    ts: overrides.ts ?? new Date(),
    broker_plugin_id: 'alpaca-provider',
    equity,
    cash: equity,
    buying_power: overrides.buying_power ?? equity,
    positions: '[]',
    total_pnl: 0,
    hwm: overrides.hwm ?? equity,
    source: 'poll',
    meta: null,
  });
  prisma.realPosition.count.mockResolvedValue(overrides.openPositionsCount ?? 0);
}

/** Wire prisma.realNavSnapshot to report NO snapshot yet — a fresh real account that has
 * never been synced. Kernel gates must FAIL CLOSED on this for opening trades. */
function mockNoRealAccountState(prisma: MockPrisma): void {
  prisma.realNavSnapshot.findFirst.mockResolvedValue(null);
  prisma.realPosition.count.mockResolvedValue(0);
}

/**
 * Wire the full common chain for approve / autoProcess happy-path tests:
 * findUnique → portfolio → quote → upsert → update.
 * Returns the mocked "executed" intent so callers can assert on it.
 */
function setupApproveScenario(
  prisma: MockPrisma,
  gateway: MockGateway,
  intentOverrides: Record<string, unknown> = {},
  executedOverrides: Record<string, unknown> = {},
) {
  const intent = pendingIntent(intentOverrides);
  prisma.tradeIntent.findUnique.mockResolvedValue(intent);
  mockPaperPortfolio(prisma);
  mockAaplQuote(gateway);
  prisma.portfolio.upsert.mockResolvedValue({ name: 'paper', data: '{}', updatedAt: new Date() });
  const executed = pendingIntent({
    status: 'executed',
    fill_price: 150,
    decided_by: 'alice',
    decided_at: new Date(),
    ...executedOverrides,
  });
  prisma.tradeIntent.update.mockResolvedValue(executed);
  return executed;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('TradeIntentService', () => {
  let prisma: MockPrisma;
  let gateway: MockGateway;
  let kv: MockKv;
  let realOrderService: MockRealOrder;
  let reconciliation: MockReconciliation;
  let service: TradeIntentService;

  beforeEach(() => {
    prisma = makePrisma();
    gateway = makeGateway();
    kv = makeKv();
    realOrderService = makeRealOrderService();
    reconciliation = makeReconciliation();
    // Default: all KV keys return null → autonomous=true by default.
    // Existing recordIntent tests that expect status=pending override this
    // per-test to return 'false' for execution.autonomous.
    kv.get.mockResolvedValue(null);
    service = makeService(prisma, gateway, kv, realOrderService, undefined, reconciliation);
  });

  // ── recordIntent ────────────────────────────────────────────────────────────

  describe('recordIntent', () => {
    it('creates a pending TradeIntent with default mode=paper', async () => {
      // Disable autonomous so the intent stays pending (HITL path)
      kv.get.mockResolvedValue('false');
      const created = pendingIntent();
      prisma.tradeIntent.create.mockResolvedValue(created);

      const result = await service.recordIntent({
        symbol: 'AAPL',
        action: 'long',
        confidence: 0.8,
        rationale: 'Bullish momentum',
      });

      expect(prisma.tradeIntent.create).toHaveBeenCalledWith(
        oc({
          data: oc({
            symbol: 'AAPL',
            action: 'long',
            confidence: 0.8,
            status: 'pending',
            mode: 'paper',
          }),
        }),
      );
      expect(result.status).toBe('pending');
      expect(result.mode).toBe('paper');
    });

    it('accepts optional cycle_id and timeframe', async () => {
      // Disable autonomous so the intent stays pending (HITL path)
      kv.get.mockResolvedValue('false');
      const created = pendingIntent({ cycle_id: 'cycle_abc', timeframe: '4h' });
      prisma.tradeIntent.create.mockResolvedValue(created);

      await service.recordIntent({
        cycle_id: 'cycle_abc',
        symbol: 'TSLA',
        action: 'short',
        confidence: 0.6,
        rationale: 'Bearish breakdown',
        timeframe: '4h',
      });

      expect(prisma.tradeIntent.create).toHaveBeenCalledWith(
        oc({ data: oc({ cycle_id: 'cycle_abc', timeframe: '4h' }) }),
      );
    });

    it('rejects an invalid action', async () => {
      await expect(
        service.recordIntent({
          symbol: 'AAPL',
          action: 'buy', // invalid — must be long|short|exit|hold
          confidence: 0.8,
          rationale: 'test',
        }),
      ).rejects.toThrow(/action/i);

      expect(prisma.tradeIntent.create).not.toHaveBeenCalled();
    });

    it.each([-0.1, 1.5])('rejects confidence %s out of range', async (confidence) => {
      await expect(
        service.recordIntent({
          symbol: 'AAPL',
          action: 'long',
          confidence,
          rationale: 'test',
        }),
      ).rejects.toThrow(/confidence/i);
    });
  });

  // ── list / listPending ──────────────────────────────────────────────────────

  describe('list', () => {
    it('lists all intents when no status filter', async () => {
      const rows = [pendingIntent(), pendingIntent({ id: 'ti_002', status: 'executed' })];
      prisma.tradeIntent.findMany.mockResolvedValue(rows);

      const result = await service.list();

      expect(prisma.tradeIntent.findMany).toHaveBeenCalledWith(
        oc({ orderBy: { created_at: 'desc' } }),
      );
      expect(result).toHaveLength(2);
    });

    it('filters by status when provided', async () => {
      prisma.tradeIntent.findMany.mockResolvedValue([pendingIntent()]);

      await service.list('pending');

      expect(prisma.tradeIntent.findMany).toHaveBeenCalledWith(
        oc({ where: { status: 'pending' } }),
      );
    });
  });

  describe('listPending', () => {
    it('returns only pending intents', async () => {
      const pending = [pendingIntent(), pendingIntent({ id: 'ti_002' })];
      prisma.tradeIntent.findMany.mockResolvedValue(pending);

      const result = await service.listPending();

      expect(prisma.tradeIntent.findMany).toHaveBeenCalledWith(
        oc({ where: { status: 'pending' } }),
      );
      expect(result).toHaveLength(2);
    });
  });

  // ── approve ────────────────────────────────────────────────────────────────

  describe('approve', () => {
    it('default policy (real unset) → paper mode in approve even if intent.mode is "live"', async () => {
      // Effective mode comes from policy, not intent.mode. Default policy → paper.
      kv.get.mockResolvedValue(null);
      setupApproveScenario(prisma, gateway, { mode: 'live', action: 'long' });

      const result = await service.approve('ti_001', 'alice');
      expect(result.status).toBe('executed');
      expect(gateway.placeOrder).not.toHaveBeenCalled();
    });

    it('throws when intent is not in pending status', async () => {
      const intent = pendingIntent({ status: 'executed' });
      prisma.tradeIntent.findUnique.mockResolvedValue(intent);

      await expect(service.approve('ti_001', 'alice')).rejects.toThrow(/not pending/i);
      expect(prisma.tradeIntent.update).not.toHaveBeenCalled();
    });

    it('executes a paper LONG: fetches quote, opens position, status=executed', async () => {
      setupApproveScenario(prisma, gateway); // action=long, mode=paper

      const result = await service.approve('ti_001', 'alice');

      expect(gateway.getQuote).toHaveBeenCalledWith(null, 'AAPL');
      expect(prisma.tradeIntent.update).toHaveBeenCalledWith(
        oc({
          where: { id: 'ti_001' },
          data: oc({
            status: 'executed',
            fill_price: 150,
            decided_by: 'alice',
          }),
        }),
      );
      expect(result.status).toBe('executed');
    });

    it('sets status=failed (no throw) when getQuote fails', async () => {
      const intent = pendingIntent();
      prisma.tradeIntent.findUnique.mockResolvedValue(intent);
      mockPaperPortfolio(prisma);
      gateway.getQuote.mockRejectedValue(new Error('Network timeout'));

      const failed = pendingIntent({
        status: 'failed',
        result_json: '{"error":"Network timeout"}',
      });
      prisma.tradeIntent.update.mockResolvedValue(failed);

      // Must NOT throw
      const result = await service.approve('ti_001', 'alice');

      expect(prisma.tradeIntent.update).toHaveBeenCalledWith(
        oc({ data: oc({ status: 'failed' }) }),
      );
      expect(result.status).toBe('failed');
    });

    it('kernel risk gate applies on approve() too: drawdown halt rejects a human-approved LONG', async () => {
      // hwm=10_000 (persisted on the paper portfolio), current equity=7_000 → drawdown=30% >= 25% halt.
      const intent = pendingIntent({ action: 'long', symbol: 'AAPL' });
      prisma.tradeIntent.findUnique.mockResolvedValue(intent);
      prisma.portfolio.findUnique.mockResolvedValue({
        name: 'paper',
        data: JSON.stringify({ equity: 7_000, cash: 7_000, positions: [], hwm: 10_000 }),
        updatedAt: new Date(),
      });
      const rejected = pendingIntent({
        status: 'rejected',
        decided_by: 'alice',
        reject_reason: 'circuit breaker: drawdown 30% >= 25%',
      });
      prisma.tradeIntent.update.mockResolvedValue(rejected);

      const result = await service.approve('ti_001', 'alice');

      expect(gateway.getQuote).not.toHaveBeenCalled();
      expect(result.status).toBe('rejected');
      expect(prisma.tradeIntent.update).toHaveBeenCalledWith(
        oc({
          data: oc({
            status: 'rejected',
            decided_by: 'alice',
            reject_reason: expect.stringMatching(/circuit|drawdown/i) as string,
          }),
        }),
      );
    });

    it('kernel risk gate applies on approve() too: max_open_positions rejects a human-approved LONG', async () => {
      const positions = Array.from({ length: 10 }, (_, i) => ({
        symbol: `SYM${i}`,
        quantity: 1,
        avg_price: 100,
      }));
      const intent = pendingIntent({ action: 'long', symbol: 'AAPL' });
      prisma.tradeIntent.findUnique.mockResolvedValue(intent);
      prisma.portfolio.findUnique.mockResolvedValue({
        name: 'paper',
        data: JSON.stringify({ equity: 10_000, cash: 5_000, positions }),
        updatedAt: new Date(),
      });
      const rejected = pendingIntent({ status: 'rejected', decided_by: 'alice' });
      prisma.tradeIntent.update.mockResolvedValue(rejected);

      const result = await service.approve('ti_001', 'alice');

      expect(gateway.getQuote).not.toHaveBeenCalled();
      expect(result.status).toBe('rejected');
    });

    it('kernel risk gate on approve() never blocks "exit", even during an active halt', async () => {
      // hwm=10_000, equity=7_000 → 30% dd
      const portfolioWithPosition = JSON.stringify({
        equity: 7_000,
        cash: 6_000,
        positions: [{ symbol: 'AAPL', quantity: 10, avg_price: 140 }],
        hwm: 10_000,
      });
      const intent = pendingIntent({ action: 'exit', symbol: 'AAPL' });
      prisma.tradeIntent.findUnique.mockResolvedValue(intent);
      prisma.portfolio.findUnique.mockResolvedValue({
        name: 'paper',
        data: portfolioWithPosition,
        updatedAt: new Date(),
      });
      mockAaplQuote(gateway);
      prisma.portfolio.upsert.mockResolvedValue({
        name: 'paper',
        data: '{}',
        updatedAt: new Date(),
      });
      const executed = pendingIntent({ status: 'executed', decided_by: 'alice' });
      prisma.tradeIntent.update.mockResolvedValue(executed);

      const result = await service.approve('ti_001', 'alice');

      expect(result.status).toBe('executed');
      expect(gateway.getQuote).toHaveBeenCalled();
    });

    it('hard position-size ceiling clamps a paper approve() LONG below the hardcoded SIZING_PCT', async () => {
      // equity=10_000, price=100. Hardcoded SIZING_PCT=0.05 → intended qty=floor(10000*0.05/100)=5.
      // Tightened max_position_pct=0.02 → ceiling maxQty=floor(10000*0.02/100)=2.
      // The clamp must reduce the executed qty to 2, below what the hardcoded 5% would give.
      kv.get.mockImplementation((key: string) => {
        if (key === 'execution.max_position_pct') return Promise.resolve('0.02');
        return Promise.resolve(null);
      });
      prisma.tradeIntent.findUnique.mockResolvedValue(
        pendingIntent({ action: 'long', symbol: 'AAPL' }),
      );
      mockPaperPortfolio(prisma); // equity=10_000, cash=10_000, positions=[]
      gateway.getQuote.mockResolvedValue({
        symbol: 'AAPL',
        bid: 99,
        ask: 101,
        last: 100,
        ts: new Date().toISOString(),
      });
      prisma.portfolio.upsert.mockResolvedValue({
        name: 'paper',
        data: '{}',
        updatedAt: new Date(),
      });
      const executed = pendingIntent({ status: 'executed', quantity: 2, decided_by: 'alice' });
      prisma.tradeIntent.update.mockResolvedValue(executed);

      const result = await service.approve('ti_001', 'alice');

      expect(result.quantity).toBe(2);
      expect(prisma.tradeIntent.update).toHaveBeenCalledWith(oc({ data: oc({ quantity: 2 }) }));
    });

    it('hard position-size ceiling clamps a real-mode approve() LONG below the hardcoded SIZING_PCT', async () => {
      kv.get.mockImplementation((key: string) => {
        if (key === 'execution.real') return Promise.resolve('true');
        if (key === 'execution.broker_plugin_id') return Promise.resolve('alpaca-provider');
        if (key === 'execution.max_order_notional') return Promise.resolve('100000'); // generous, isolate size clamp
        if (key === 'execution.max_position_pct') return Promise.resolve('0.02');
        if (key === 'strategy.applied') return Promise.resolve('s_live');
        return Promise.resolve(null);
      });
      mockRobustAppliedStrategy(prisma); // walk-forward gate passes
      mockRealAccountState(prisma); // real buying_power=10_000 — sizing/gate must read THIS, not paper
      prisma.tradeIntent.findUnique.mockResolvedValue(
        pendingIntent({ action: 'long', symbol: 'AAPL' }),
      );
      mockPaperPortfolio(prisma); // equity=10_000
      mockAaplQuote(gateway); // price=150 → intended qty=floor(10000*0.05/150)=3; ceiling=floor(10000*0.02/150)=1
      realOrderService.submit.mockResolvedValue({
        id: 'ro_789',
        status: 'submitted',
        client_order_id: 'nt-ti_001-clamp',
        broker_order_id: 'order_789',
        error: null,
      });
      const pending = pendingIntent({
        status: 'real_pending',
        fill_price: null,
        quantity: null,
        decided_by: 'alice',
      });
      prisma.tradeIntent.update.mockResolvedValue(pending);

      const result = await service.approve('ti_001', 'alice');

      expect(result.status).toBe('real_pending');
      expect(realOrderService.submit).toHaveBeenCalledWith(oc({ requestedQty: 1 }));
      expect(gateway.placeOrder).not.toHaveBeenCalled();
    });

    it('computes realized_pnl on EXIT after a previous position exists', async () => {
      // Simulate a portfolio that already holds 10 AAPL at avg 140
      const portfolioWithPosition = JSON.stringify({
        equity: 11_400,
        cash: 10_000,
        positions: [{ symbol: 'AAPL', quantity: 10, avg_price: 140 }],
      });

      const intent = pendingIntent({ action: 'exit', symbol: 'AAPL' });
      prisma.tradeIntent.findUnique.mockResolvedValue(intent);
      prisma.portfolio.findUnique.mockResolvedValue({
        name: 'paper',
        data: portfolioWithPosition,
        updatedAt: new Date(),
      });
      mockAaplQuote(gateway);
      prisma.portfolio.upsert.mockResolvedValue({
        name: 'paper',
        data: '{}',
        updatedAt: new Date(),
      });

      // realized_pnl = (150 - 140) * 10 = 100
      const updated = pendingIntent({
        status: 'executed',
        fill_price: 150,
        quantity: 10,
        realized_pnl: 100,
        decided_by: 'alice',
        decided_at: new Date(),
      });
      prisma.tradeIntent.update.mockResolvedValue(updated);

      const result = await service.approve('ti_001', 'alice');

      expect(prisma.tradeIntent.update).toHaveBeenCalledWith(
        oc({ data: oc({ status: 'executed', realized_pnl: 100 }) }),
      );
      expect(result.realized_pnl).toBe(100);
    });
  });

  // ── reject ─────────────────────────────────────────────────────────────────

  describe('reject', () => {
    it('sets status=rejected with reason and decided_by', async () => {
      const intent = pendingIntent();
      prisma.tradeIntent.findUnique.mockResolvedValue(intent);

      const rejected = pendingIntent({
        status: 'rejected',
        decided_by: 'alice',
        reject_reason: 'Too risky',
        decided_at: new Date(),
      });
      prisma.tradeIntent.update.mockResolvedValue(rejected);

      const result = await service.reject('ti_001', 'alice', 'Too risky');

      expect(prisma.tradeIntent.update).toHaveBeenCalledWith(
        oc({
          where: { id: 'ti_001' },
          data: oc({
            status: 'rejected',
            decided_by: 'alice',
            reject_reason: 'Too risky',
          }),
        }),
      );
      expect(result.status).toBe('rejected');
      expect(result.reject_reason).toBe('Too risky');
    });

    it('throws when intent is not pending', async () => {
      const intent = pendingIntent({ status: 'rejected' });
      prisma.tradeIntent.findUnique.mockResolvedValue(intent);

      await expect(service.reject('ti_001', 'alice', 'duplicate')).rejects.toThrow(/not pending/i);
      expect(prisma.tradeIntent.update).not.toHaveBeenCalled();
    });
  });

  // ── autoProcess ────────────────────────────────────────────────────────────

  describe('autoProcess', () => {
    it('autonomous=true (default): recordIntent auto-executes', async () => {
      // kv.get returns null for all keys → autonomous=true (default)
      kv.get.mockResolvedValue(null);

      const created = pendingIntent();
      prisma.tradeIntent.create.mockResolvedValue(created);
      // autoProcess calls findUnique after create
      prisma.tradeIntent.findUnique.mockResolvedValue(pendingIntent());
      mockPaperPortfolio(prisma);
      mockAaplQuote(gateway);
      prisma.portfolio.upsert.mockResolvedValue({ name: 'paper', data: '{}' });
      const executedIntent = pendingIntent({ status: 'executed', decided_by: 'autonomous' });
      prisma.tradeIntent.update.mockResolvedValue(executedIntent);

      const result = await service.recordIntent({
        symbol: 'AAPL',
        action: 'long',
        confidence: 0.8,
        rationale: 'Bullish momentum',
      });

      expect(result.status).toBe('executed');
      expect(prisma.tradeIntent.update).toHaveBeenCalledWith(
        oc({ data: oc({ decided_by: 'autonomous' }) }),
      );
    });

    it('circuit breaker: real HWM drawdown >= max_drawdown_halt_pct → auto-rejected (reads persisted hwm, not the dead field)', async () => {
      kv.get.mockResolvedValue(null); // autonomous=true, max_drawdown_halt_pct=25 (default)

      // hwm=10_000 persisted on the paper portfolio; current equity=7_000 → drawdown=30% >= 25% halt.
      // The dead `max_drawdown_pct` field is intentionally OMITTED from the portfolio JSON —
      // if the gate still read that dead field, drawdown would default to 0 and this would
      // NOT reject, proving the gate now consults the real hwm instead.
      const portfolioAtDrawdown = JSON.stringify({
        equity: 7_000,
        cash: 7_000,
        positions: [],
        hwm: 10_000,
      });

      prisma.tradeIntent.findUnique.mockResolvedValue(pendingIntent({ action: 'long' }));
      prisma.portfolio.findUnique.mockResolvedValue({
        name: 'paper',
        data: portfolioAtDrawdown,
        updatedAt: new Date(),
      });
      const rejected = pendingIntent({
        status: 'rejected',
        decided_by: 'autonomous',
        reject_reason: 'circuit breaker: drawdown 30% >= 25%',
      });
      prisma.tradeIntent.update.mockResolvedValue(rejected);

      await service.autoProcess('ti_001');

      expect(gateway.getQuote).not.toHaveBeenCalled();
      expect(prisma.portfolio.upsert).not.toHaveBeenCalled();
      expect(prisma.tradeIntent.update).toHaveBeenCalledWith(
        oc({
          data: oc({
            status: 'rejected',
            decided_by: 'autonomous',
            reject_reason: expect.stringMatching(/circuit|drawdown/i) as string,
          }),
        }),
      );
    });

    it('below threshold: HWM drawdown 10% < 25% halt → entry allowed', async () => {
      kv.get.mockResolvedValue(null); // autonomous=true, max_drawdown_halt_pct=25 (default)

      // hwm=10_000, current equity=9_000 → drawdown=10% < 25% → allowed.
      const portfolioAt10PctDd = JSON.stringify({
        equity: 9_000,
        cash: 9_000,
        positions: [],
        hwm: 10_000,
      });

      prisma.tradeIntent.findUnique.mockResolvedValue(pendingIntent({ action: 'long' }));
      prisma.portfolio.findUnique.mockResolvedValue({
        name: 'paper',
        data: portfolioAt10PctDd,
        updatedAt: new Date(),
      });
      mockAaplQuote(gateway);
      prisma.portfolio.upsert.mockResolvedValue({
        name: 'paper',
        data: '{}',
        updatedAt: new Date(),
      });
      const executed = pendingIntent({ status: 'executed', decided_by: 'autonomous' });
      prisma.tradeIntent.update.mockResolvedValue(executed);

      const result = await service.autoProcess('ti_001');

      expect(result.status).toBe('executed');
      expect(gateway.getQuote).toHaveBeenCalled();
    });

    it('fresh portfolio with no persisted hwm → treated as hwm=equity → drawdown=0, no false halt', async () => {
      kv.get.mockResolvedValue(null); // autonomous=true, max_drawdown_halt_pct=25 (default)

      // EMPTY_PORTFOLIO_DATA has no `hwm` field — the very first trade on a fresh install.
      mockPaperPortfolio(prisma); // equity=10_000, cash=10_000, positions=[]

      prisma.tradeIntent.findUnique.mockResolvedValue(pendingIntent({ action: 'long' }));
      mockAaplQuote(gateway);
      prisma.portfolio.upsert.mockResolvedValue({
        name: 'paper',
        data: '{}',
        updatedAt: new Date(),
      });
      const executed = pendingIntent({ status: 'executed', decided_by: 'autonomous' });
      prisma.tradeIntent.update.mockResolvedValue(executed);

      const result = await service.autoProcess('ti_001');

      expect(result.status).toBe('executed');
    });

    it('end-to-end: real paper losses drop equity past the drawdown halt on the NEXT entry, but exit still executes', async () => {
      // Deterministic thresholds: max_position_pct=0.5 (large clip) + max_drawdown_halt_pct=20 (low bar)
      // so a single realistic price-crash exit is enough to trip the halt. No mocked drawdown/hwm —
      // this drives REAL paper executions through autoProcess and lets equity/hwm evolve for real.
      kv.get.mockImplementation((key: string) => {
        if (key === 'execution.max_position_pct') return Promise.resolve('0.5');
        if (key === 'execution.max_drawdown_halt_pct') return Promise.resolve('20');
        return Promise.resolve(null);
      });

      let portfolioData = EMPTY_PORTFOLIO_DATA; // equity=10_000, cash=10_000, positions=[]
      prisma.portfolio.findUnique.mockImplementation(() =>
        Promise.resolve({ name: 'paper', data: portfolioData, updatedAt: new Date() }),
      );
      prisma.portfolio.upsert.mockImplementation((args: { update: { data: string } }) => {
        portfolioData = args.update.data;
        return Promise.resolve({ name: 'paper', data: portfolioData, updatedAt: new Date() });
      });
      prisma.tradeIntent.update.mockImplementation(
        (args: { where: { id: string }; data: Record<string, unknown> }) =>
          Promise.resolve(
            pendingIntent({ id: args.where.id, status: 'executed', ...args.data }),
          ) as unknown,
      );

      // 1) Real paper entry: buy 50 AAPL @ 100. qty=floor(10_000*0.5/100)=50. cash=5_000,
      //    equity=5_000+50*100=10_000 (unchanged — no gain/loss on entry itself).
      prisma.tradeIntent.findUnique.mockResolvedValueOnce(
        pendingIntent({ id: 'ti_open', action: 'long', symbol: 'AAPL' }),
      );
      gateway.getQuote.mockResolvedValueOnce({
        symbol: 'AAPL',
        bid: 99,
        ask: 101,
        last: 100,
        ts: new Date().toISOString(),
      });
      const opened = await service.autoProcess('ti_open');
      expect(opened.status).toBe('executed');
      expect((JSON.parse(portfolioData) as { equity: number }).equity).toBe(10_000);

      // 2) Price crashes to 10 and we exit the whole position — realized loss drags equity to
      //    5_500, a 45% drawdown from the recorded hwm (10_000) — well past the 20% halt.
      prisma.tradeIntent.findUnique.mockResolvedValueOnce(
        pendingIntent({ id: 'ti_exit', action: 'exit', symbol: 'AAPL' }),
      );
      gateway.getQuote.mockResolvedValueOnce({
        symbol: 'AAPL',
        bid: 9,
        ask: 11,
        last: 10,
        ts: new Date().toISOString(),
      });
      const exited = await service.autoProcess('ti_exit');
      expect(exited.status).toBe('executed');
      const afterCrash = JSON.parse(portfolioData) as { equity: number; hwm?: number };
      expect(afterCrash.equity).toBe(5_500);
      expect(afterCrash.hwm).toBe(10_000);

      // 3) NEXT long entry must now be halted — real drawdown from real trading, not a mock.
      prisma.tradeIntent.findUnique.mockResolvedValueOnce(
        pendingIntent({ id: 'ti_blocked', action: 'long', symbol: 'MSFT' }),
      );
      const blocked = await service.autoProcess('ti_blocked');
      expect(blocked.status).toBe('rejected');
      expect(blocked.reject_reason as string).toMatch(/circuit|drawdown/i);

      // 4) But an exit in the same halted state still executes normally.
      prisma.tradeIntent.findUnique.mockResolvedValueOnce(
        pendingIntent({ id: 'ti_exit2', action: 'exit', symbol: 'MSFT' }),
      );
      gateway.getQuote.mockResolvedValueOnce({
        symbol: 'MSFT',
        bid: 199,
        ask: 201,
        last: 200,
        ts: new Date().toISOString(),
      });
      const stillExits = await service.autoProcess('ti_exit2');
      expect(stillExits.status).toBe('executed');
    });

    it('hwm rises with new equity highs — no false halt when a new all-time-high is reached', async () => {
      kv.get.mockResolvedValue(null); // defaults: max_position_pct=0.1, max_drawdown_halt_pct=25

      let portfolioData = EMPTY_PORTFOLIO_DATA; // equity=10_000, cash=10_000, positions=[]
      prisma.portfolio.findUnique.mockImplementation(() =>
        Promise.resolve({ name: 'paper', data: portfolioData, updatedAt: new Date() }),
      );
      prisma.portfolio.upsert.mockImplementation((args: { update: { data: string } }) => {
        portfolioData = args.update.data;
        return Promise.resolve({ name: 'paper', data: portfolioData, updatedAt: new Date() });
      });
      prisma.tradeIntent.update.mockImplementation(
        (args: { where: { id: string }; data: Record<string, unknown> }) =>
          Promise.resolve(
            pendingIntent({ id: args.where.id, status: 'executed', ...args.data }),
          ) as unknown,
      );

      // Open: buy 10 AAPL @ 100.
      prisma.tradeIntent.findUnique.mockResolvedValueOnce(
        pendingIntent({ id: 'ti_open', action: 'long', symbol: 'AAPL' }),
      );
      gateway.getQuote.mockResolvedValueOnce({
        symbol: 'AAPL',
        bid: 99,
        ask: 101,
        last: 100,
        ts: new Date().toISOString(),
      });
      await service.autoProcess('ti_open');

      // Exit at a profit: sell @ 150 → equity rises to 10_500, a NEW all-time high.
      prisma.tradeIntent.findUnique.mockResolvedValueOnce(
        pendingIntent({ id: 'ti_exit', action: 'exit', symbol: 'AAPL' }),
      );
      gateway.getQuote.mockResolvedValueOnce({
        symbol: 'AAPL',
        bid: 149,
        ask: 151,
        last: 150,
        ts: new Date().toISOString(),
      });
      await service.autoProcess('ti_exit');
      const afterProfit = JSON.parse(portfolioData) as { equity: number; hwm?: number };
      expect(afterProfit.equity).toBe(10_500);
      expect(afterProfit.hwm).toBe(10_500);

      // Next entry: current equity == hwm → drawdown 0 → must be allowed, not halted.
      prisma.tradeIntent.findUnique.mockResolvedValueOnce(
        pendingIntent({ id: 'ti_next', action: 'long', symbol: 'MSFT' }),
      );
      gateway.getQuote.mockResolvedValueOnce({
        symbol: 'MSFT',
        bid: 199,
        ask: 201,
        last: 200,
        ts: new Date().toISOString(),
      });
      const next = await service.autoProcess('ti_next');
      expect(next.status).toBe('executed');
    });

    it('max_open_positions reached → opening trade auto-rejected', async () => {
      kv.get.mockResolvedValue(null); // autonomous=true, max_open_positions=10 (default)

      const positions = Array.from({ length: 10 }, (_, i) => ({
        symbol: `SYM${i}`,
        quantity: 1,
        avg_price: 100,
      }));
      const portfolioFull = JSON.stringify({ equity: 10_000, cash: 5_000, positions });

      prisma.tradeIntent.findUnique.mockResolvedValue(pendingIntent({ action: 'long' }));
      prisma.portfolio.findUnique.mockResolvedValue({
        name: 'paper',
        data: portfolioFull,
        updatedAt: new Date(),
      });
      const rejected = pendingIntent({
        status: 'rejected',
        decided_by: 'autonomous',
        reject_reason: 'max open positions reached',
      });
      prisma.tradeIntent.update.mockResolvedValue(rejected);

      await service.autoProcess('ti_001');

      expect(gateway.getQuote).not.toHaveBeenCalled();
      expect(prisma.tradeIntent.update).toHaveBeenCalledWith(
        oc({
          data: oc({
            status: 'rejected',
            decided_by: 'autonomous',
            reject_reason: expect.stringMatching(/max open positions|positions/i) as string,
          }),
        }),
      );
    });

    it('position size capped at max_position_pct', async () => {
      // max_position_pct=0.05 → 5% of 10000 cash = 500, at price 100 → qty=5
      kv.get.mockImplementation((key: string) => {
        if (key === 'execution.max_position_pct') return Promise.resolve('0.05');
        return Promise.resolve(null); // autonomous=true for others
      });

      prisma.tradeIntent.findUnique.mockResolvedValue(
        pendingIntent({ action: 'long', symbol: 'AAPL' }),
      );
      mockPaperPortfolio(prisma); // equity=10000, cash=10000, positions=[]
      gateway.getQuote.mockResolvedValue({
        symbol: 'AAPL',
        bid: 99,
        ask: 101,
        last: 100,
        ts: new Date().toISOString(),
      });
      prisma.portfolio.upsert.mockResolvedValue({ name: 'paper', data: '{}' });
      const executedIntent = pendingIntent({
        status: 'executed',
        quantity: 5,
        decided_by: 'autonomous',
      });
      prisma.tradeIntent.update.mockResolvedValue(executedIntent);

      await service.autoProcess('ti_001');

      // qty = floor(10000 * 0.05 / 100) = floor(5) = 5
      expect(prisma.tradeIntent.update).toHaveBeenCalledWith(oc({ data: oc({ quantity: 5 }) }));
    });

    it('action "exit" auto-approved even at max positions and max drawdown', async () => {
      kv.get.mockResolvedValue(null); // autonomous=true, all defaults

      const positions = Array.from({ length: 10 }, (_, i) => ({
        symbol: i === 0 ? 'AAPL' : `SYM${i}`,
        quantity: 1,
        avg_price: 100,
      }));
      // drawdown=30% (>= 25 halt, hwm=10_000) AND 10 positions (>= 10 max)
      const portfolioFull = JSON.stringify({
        equity: 7_000,
        cash: 6_000,
        positions,
        hwm: 10_000,
      });

      prisma.tradeIntent.findUnique.mockResolvedValue(
        pendingIntent({ action: 'exit', symbol: 'AAPL' }),
      );
      prisma.portfolio.findUnique.mockResolvedValue({
        name: 'paper',
        data: portfolioFull,
        updatedAt: new Date(),
      });
      gateway.getQuote.mockResolvedValue({
        symbol: 'AAPL',
        last: 110,
        bid: 109,
        ask: 111,
        ts: new Date().toISOString(),
      });
      prisma.portfolio.upsert.mockResolvedValue({ name: 'paper', data: '{}' });
      const executedIntent = pendingIntent({ status: 'executed', decided_by: 'autonomous' });
      prisma.tradeIntent.update.mockResolvedValue(executedIntent);

      const result = await service.autoProcess('ti_001');

      expect(result.status).toBe('executed');
      expect(gateway.getQuote).toHaveBeenCalled();
    });

    it('action "hold" → executed as no-op (quantity 0, no portfolio change)', async () => {
      kv.get.mockResolvedValue(null); // autonomous=true

      prisma.tradeIntent.findUnique.mockResolvedValue(pendingIntent({ action: 'hold' }));
      mockPaperPortfolio(prisma);
      const executedIntent = pendingIntent({
        status: 'executed',
        quantity: 0,
        decided_by: 'autonomous',
      });
      prisma.tradeIntent.update.mockResolvedValue(executedIntent);

      const result = await service.autoProcess('ti_001');

      expect(result.status).toBe('executed');
      expect(result.quantity).toBe(0);
      expect(gateway.getQuote).not.toHaveBeenCalled();
      expect(prisma.portfolio.upsert).not.toHaveBeenCalled();
    });

    it('autonomous=false → recordIntent leaves intent pending', async () => {
      kv.get.mockResolvedValue('false'); // autonomous=false

      const created = pendingIntent();
      prisma.tradeIntent.create.mockResolvedValue(created);

      const result = await service.recordIntent({
        symbol: 'AAPL',
        action: 'long',
        confidence: 0.8,
        rationale: 'Bullish momentum',
      });

      expect(result.status).toBe('pending');
      // autoProcess should NOT be called → findUnique not called
      expect(prisma.tradeIntent.findUnique).not.toHaveBeenCalled();
    });

    it('default policy (real unset) → paper mode even if intent.mode is "live"', async () => {
      // real execution is disabled by default; effective mode is always paper
      kv.get.mockResolvedValue(null); // all keys null → real=false, broker_plugin_id=''
      prisma.tradeIntent.findUnique.mockResolvedValue(
        pendingIntent({ mode: 'live', action: 'hold' }),
      );

      const executed = pendingIntent({ status: 'executed', quantity: 0, decided_by: 'autonomous' });
      prisma.tradeIntent.update.mockResolvedValue(executed);

      // Must NOT throw. Routes to paper (hold → no-op).
      const result = await service.autoProcess('ti_001');
      expect(result.status).toBe('executed');
      expect(gateway.placeOrder).not.toHaveBeenCalled();
    });

    it('getQuote failure during autoProcess → status=failed, no throw', async () => {
      kv.get.mockResolvedValue(null); // autonomous=true

      prisma.tradeIntent.findUnique.mockResolvedValue(pendingIntent({ action: 'long' }));
      mockPaperPortfolio(prisma);
      gateway.getQuote.mockRejectedValue(new Error('Network timeout'));
      const failedIntent = pendingIntent({ status: 'failed', decided_by: 'autonomous' });
      prisma.tradeIntent.update.mockResolvedValue(failedIntent);

      // Must NOT throw
      const result = await service.autoProcess('ti_001');

      expect(result.status).toBe('failed');
      expect(prisma.tradeIntent.update).toHaveBeenCalledWith(
        oc({ data: oc({ status: 'failed' }) }),
      );
      expect(prisma.portfolio.upsert).not.toHaveBeenCalled();
    });
  });

  // ── real execution ──────────────────────────────────────────────────────────

  describe('real execution', () => {
    // Helper: configure KV for real execution with a broker AND a passing walk-forward
    // gate (an applied strategy with a fresh ROBUSTO verdict). Both are now required for
    // real execution — real=true + broker alone is no longer sufficient.
    function enableReal(
      kvMock: MockKv,
      prismaMock: MockPrisma,
      brokerPluginId = 'alpaca-provider',
      maxOrderNotional = 1000,
    ) {
      kvMock.get.mockImplementation((key: string) => {
        if (key === 'execution.real') return Promise.resolve('true');
        if (key === 'execution.broker_plugin_id') return Promise.resolve(brokerPluginId);
        if (key === 'execution.max_order_notional')
          return Promise.resolve(String(maxOrderNotional));
        if (key === 'strategy.applied') return Promise.resolve('s_live');
        return Promise.resolve(null); // all other keys → defaults (autonomous=true, etc.)
      });
      mockRobustAppliedStrategy(prismaMock); // fresh ROBUSTO verdict → gate passes
      // Default real account state — $10k, no drawdown, 0 open positions (mirrors the paper
      // defaults so pre-existing qty math in tests that don't care about real accounting stays
      // unchanged). Individual tests override via mockRealAccountState/mockNoRealAccountState.
      mockRealAccountState(prismaMock);
    }

    it.each([
      [
        'default policy (real unset) → effective mode=paper, placeOrder NEVER called',
        () => kv.get.mockResolvedValue(null),
      ],
      [
        'real=true but broker_plugin_id empty → effective mode=paper, placeOrder NOT called',
        () =>
          kv.get.mockImplementation((key: string) => {
            if (key === 'execution.real') return Promise.resolve('true');
            if (key === 'execution.broker_plugin_id') return Promise.resolve(''); // empty!
            return Promise.resolve(null);
          }),
      ],
    ])('%s', async (_label, setupKv) => {
      setupKv();

      prisma.tradeIntent.findUnique.mockResolvedValue(pendingIntent({ action: 'long' }));
      mockPaperPortfolio(prisma);
      mockAaplQuote(gateway);
      prisma.portfolio.upsert.mockResolvedValue({
        name: 'paper',
        data: '{}',
        updatedAt: new Date(),
      });
      const executed = pendingIntent({
        status: 'executed',
        fill_price: 150,
        decided_by: 'autonomous',
      });
      prisma.tradeIntent.update.mockResolvedValue(executed);

      await service.autoProcess('ti_001');

      expect(gateway.placeOrder).not.toHaveBeenCalled();
      expect(prisma.portfolio.upsert).toHaveBeenCalled(); // paper portfolio updated
    });

    it('real=true + broker set → autoProcess long submits via RealOrderService with side=buy, qty>0, status=real_pending, NO fabricated fill', async () => {
      enableReal(kv, prisma); // real=true, broker='alpaca-provider', max_order_notional=1000
      // qty = floor(10000 * 0.1 / 150) = floor(6.66) = 6; notional = 6*150 = 900 <= 1000 ✓
      prisma.tradeIntent.findUnique.mockResolvedValue(
        pendingIntent({ action: 'long', symbol: 'AAPL' }),
      );
      mockAaplQuote(gateway);
      realOrderService.submit.mockResolvedValue({
        id: 'ro_123',
        status: 'submitted',
        client_order_id: 'nt-ti_001-abc',
        broker_order_id: 'order_123',
        error: null,
      });
      const pending = pendingIntent({
        status: 'real_pending',
        fill_price: null,
        quantity: null,
        decided_by: 'autonomous',
      });
      prisma.tradeIntent.update.mockResolvedValue(pending);

      const result = await service.autoProcess('ti_001');

      // The order MUST go through RealOrderService — never a direct gateway.placeOrder call.
      expect(realOrderService.submit).toHaveBeenCalledTimes(1);
      expect(realOrderService.submit).toHaveBeenCalledWith(
        oc({
          tradeIntentId: 'ti_001',
          brokerPluginId: 'alpaca-provider',
          symbol: 'AAPL',
          side: 'buy',
          requestedQty: expect.any(Number) as number,
        }),
      );
      const [[submitArg]] = realOrderService.submit.mock.calls as [[{ requestedQty: number }]];
      expect(submitArg.requestedQty).toBeGreaterThan(0);
      expect(gateway.placeOrder).not.toHaveBeenCalled();
      expect(result.status).toBe('real_pending');
      // No fabricated fill: fill_price/quantity are set later by reconciliation, not here.
      expect(prisma.tradeIntent.update).toHaveBeenCalledWith(
        oc({
          data: oc({
            status: 'real_pending',
          }),
        }),
      );
      const [[updateArgs]] = prisma.tradeIntent.update.mock.calls as [
        [{ data: Record<string, unknown> }],
      ];
      expect(updateArgs.data).not.toHaveProperty('fill_price');
      expect(updateArgs.data).not.toHaveProperty('quantity');
      // Paper portfolio must NOT be upserted in real mode
      expect(prisma.portfolio.upsert).not.toHaveBeenCalled();
    });

    it('RealOrderService.submit returns submit_failed → TradeIntent status=failed with reason, no false real_pending', async () => {
      enableReal(kv, prisma);
      prisma.tradeIntent.findUnique.mockResolvedValue(
        pendingIntent({ action: 'long', symbol: 'AAPL' }),
      );
      mockAaplQuote(gateway);
      realOrderService.submit.mockResolvedValue({
        id: 'ro_failed',
        status: 'submit_failed',
        client_order_id: 'nt-ti_001-xyz',
        broker_order_id: null,
        error: 'Broker connection refused',
      });
      const failed = pendingIntent({
        status: 'failed',
        decided_by: 'autonomous',
        result_json: JSON.stringify({ error: 'Broker connection refused' }),
      });
      prisma.tradeIntent.update.mockResolvedValue(failed);

      const result = await service.autoProcess('ti_001');

      expect(realOrderService.submit).toHaveBeenCalledTimes(1);
      expect(gateway.placeOrder).not.toHaveBeenCalled();
      expect(result.status).toBe('failed');
      expect(prisma.tradeIntent.update).toHaveBeenCalledWith(
        oc({
          data: oc({
            status: 'failed',
            result_json: expect.stringContaining('Broker connection refused') as string,
          }),
        }),
      );
    });

    it('real order notional exceeds max_order_notional → status=failed, placeOrder NOT called', async () => {
      // max_order_notional=100; qty=floor(10000*0.1/150)=6; notional=6*150=900 > 100 → fail
      kv.get.mockImplementation((key: string) => {
        if (key === 'execution.real') return Promise.resolve('true');
        if (key === 'execution.broker_plugin_id') return Promise.resolve('alpaca-provider');
        if (key === 'execution.max_order_notional') return Promise.resolve('100'); // tiny ceiling
        if (key === 'strategy.applied') return Promise.resolve('s_live');
        return Promise.resolve(null);
      });
      mockRobustAppliedStrategy(prisma); // gate passes → reach the notional check
      mockRealAccountState(prisma); // real buying_power=10_000 — same math as the paper default

      prisma.tradeIntent.findUnique.mockResolvedValue(
        pendingIntent({ action: 'long', symbol: 'AAPL' }),
      );
      mockAaplQuote(gateway);
      const failed = pendingIntent({ status: 'failed', decided_by: 'autonomous' });
      prisma.tradeIntent.update.mockResolvedValue(failed);

      const result = await service.autoProcess('ti_001');

      expect(gateway.placeOrder).not.toHaveBeenCalled();
      expect(result.status).toBe('failed');
      expect(prisma.tradeIntent.update).toHaveBeenCalledWith(
        oc({
          data: oc({
            status: 'failed',
            result_json: expect.stringContaining('max_order_notional') as string,
          }),
        }),
      );
    });

    it('real exit above max_order_notional STILL executes (exits must never be trapped by the ceiling)', async () => {
      // Ceiling is tiny (100) but the held position's exit notional (10 * 150 = 1500) exceeds
      // it. Exits must be exempt from the notional ceiling — same reasoning as the qty-clamp
      // and the paper path — otherwise a real position could become impossible to close.
      kv.get.mockImplementation((key: string) => {
        if (key === 'execution.real') return Promise.resolve('true');
        if (key === 'execution.broker_plugin_id') return Promise.resolve('alpaca-provider');
        if (key === 'execution.max_order_notional') return Promise.resolve('100'); // tiny ceiling
        if (key === 'strategy.applied') return Promise.resolve('s_live');
        return Promise.resolve(null);
      });
      mockRobustAppliedStrategy(prisma);

      prisma.tradeIntent.findUnique.mockResolvedValue(
        pendingIntent({ action: 'exit', symbol: 'AAPL' }),
      );
      // Paper portfolio is unrelated for a real exit — it holds a DIFFERENT qty than the
      // broker to prove the sell quantity is sourced from the broker, not the paper state.
      mockPaperPortfolio(prisma);
      gateway.getPortfolio.mockResolvedValue({
        provider_id: 'alpaca-provider',
        equity: 11_400,
        cash: 10_000,
        buying_power: 10_000,
        positions: [
          {
            symbol: 'AAPL',
            qty: 10,
            avg_entry: 140,
            market_value: 1500,
            unrealized_pnl: 100,
            side: 'long',
          },
        ],
        total_market_value: 1500,
        total_pnl: 100,
        ts: new Date().toISOString(),
      });
      mockAaplQuote(gateway); // last=150 → notional = 10 * 150 = 1500 > 100
      realOrderService.submit.mockResolvedValue({
        id: 'ro_exit',
        status: 'submitted',
        client_order_id: 'nt-ti_001-exit',
        broker_order_id: 'order_exit',
        error: null,
      });
      const pending = pendingIntent({
        status: 'real_pending',
        fill_price: null,
        quantity: null,
        decided_by: 'autonomous',
      });
      prisma.tradeIntent.update.mockResolvedValue(pending);

      const result = await service.autoProcess('ti_001');

      expect(realOrderService.submit).toHaveBeenCalledWith(
        oc({ symbol: 'AAPL', requestedQty: 10, side: 'sell' }),
      );
      expect(gateway.placeOrder).not.toHaveBeenCalled();
      expect(result.status).toBe('real_pending');
    });

    it('real long above max_order_notional is still rejected (ceiling stays enforced for entries)', async () => {
      kv.get.mockImplementation((key: string) => {
        if (key === 'execution.real') return Promise.resolve('true');
        if (key === 'execution.broker_plugin_id') return Promise.resolve('alpaca-provider');
        if (key === 'execution.max_order_notional') return Promise.resolve('100'); // tiny ceiling
        if (key === 'strategy.applied') return Promise.resolve('s_live');
        return Promise.resolve(null);
      });
      mockRobustAppliedStrategy(prisma);
      mockRealAccountState(prisma); // real buying_power=10_000 — same math as the paper default

      prisma.tradeIntent.findUnique.mockResolvedValue(
        pendingIntent({ action: 'long', symbol: 'AAPL' }),
      );
      mockPaperPortfolio(prisma);
      mockAaplQuote(gateway);
      const failed = pendingIntent({ status: 'failed', decided_by: 'autonomous' });
      prisma.tradeIntent.update.mockResolvedValue(failed);

      const result = await service.autoProcess('ti_001');

      expect(gateway.placeOrder).not.toHaveBeenCalled();
      expect(result.status).toBe('failed');
    });

    it('RealOrderService.submit throws (e.g. non-idempotency DB failure) → status=failed, no throw to caller', async () => {
      enableReal(kv, prisma);
      prisma.tradeIntent.findUnique.mockResolvedValue(
        pendingIntent({ action: 'long', symbol: 'AAPL' }),
      );
      mockAaplQuote(gateway);
      realOrderService.submit.mockRejectedValue(new Error('Broker connection refused'));
      const failed = pendingIntent({ status: 'failed', decided_by: 'autonomous' });
      prisma.tradeIntent.update.mockResolvedValue(failed);

      // Must NOT throw
      const result = await service.autoProcess('ti_001');

      expect(gateway.placeOrder).not.toHaveBeenCalled();
      expect(result.status).toBe('failed');
      expect(prisma.tradeIntent.update).toHaveBeenCalledWith(
        oc({
          data: oc({
            status: 'failed',
            result_json: expect.stringContaining('Broker connection refused') as string,
          }),
        }),
      );
    });

    it('real exit → side=sell with the held position qty sourced from the BROKER (not the paper portfolio)', async () => {
      // Broker reports 10 AAPL held at the broker; the paper portfolio holds a DIFFERENT
      // quantity (3) for the same symbol, to prove the sell qty comes from getPortfolio and
      // is never derived from paper state for real exits.
      enableReal(kv, prisma, 'alpaca-provider', 5000); // ceiling high enough
      prisma.tradeIntent.findUnique.mockResolvedValue(
        pendingIntent({ action: 'exit', symbol: 'AAPL' }),
      );
      mockAaplQuote(gateway);
      prisma.portfolio.findUnique.mockResolvedValue({
        name: 'paper',
        data: JSON.stringify({
          equity: 11_400,
          cash: 10_000,
          positions: [{ symbol: 'AAPL', quantity: 3, avg_price: 140 }], // stale/irrelevant paper qty
        }),
        updatedAt: new Date(),
      });
      gateway.getPortfolio.mockResolvedValue({
        provider_id: 'alpaca-provider',
        equity: 11_400,
        cash: 10_000,
        buying_power: 10_000,
        positions: [
          {
            symbol: 'AAPL',
            qty: 10,
            avg_entry: 140,
            market_value: 1500,
            unrealized_pnl: 100,
            side: 'long',
          },
        ],
        total_market_value: 1500,
        total_pnl: 100,
        ts: new Date().toISOString(),
      });
      realOrderService.submit.mockResolvedValue({
        id: 'ro_456',
        status: 'submitted',
        client_order_id: 'nt-ti_001-456',
        broker_order_id: 'order_456',
        error: null,
      });
      const pending = pendingIntent({
        status: 'real_pending',
        fill_price: null,
        quantity: null,
        decided_by: 'autonomous',
      });
      prisma.tradeIntent.update.mockResolvedValue(pending);

      await service.autoProcess('ti_001');

      expect(gateway.getPortfolio).toHaveBeenCalledWith('alpaca-provider');
      expect(realOrderService.submit).toHaveBeenCalledWith(
        oc({ symbol: 'AAPL', side: 'sell', requestedQty: 10 }),
      );
      expect(gateway.placeOrder).not.toHaveBeenCalled();
    });

    it('real exit with a SHORT held position → sells Math.abs(qty) (negative broker qty)', async () => {
      // A short position is reported by the broker as a negative qty. Closing (buying back)
      // a short is still routed through the 'exit' action in this codebase's simplified
      // side-mapping (side='sell' is fixed for exit at the trade-intent layer) — the point
      // under test here is that Math.abs() is applied to the broker qty, not the sign.
      enableReal(kv, prisma, 'alpaca-provider', 5000);
      prisma.tradeIntent.findUnique.mockResolvedValue(
        pendingIntent({ action: 'exit', symbol: 'AAPL' }),
      );
      mockAaplQuote(gateway);
      mockPaperPortfolio(prisma);
      gateway.getPortfolio.mockResolvedValue({
        provider_id: 'alpaca-provider',
        equity: 11_400,
        cash: 10_000,
        buying_power: 10_000,
        positions: [
          {
            symbol: 'AAPL',
            qty: -7,
            avg_entry: 140,
            market_value: 1050,
            unrealized_pnl: 0,
            side: 'short',
          },
        ],
        total_market_value: 1050,
        total_pnl: 0,
        ts: new Date().toISOString(),
      });
      realOrderService.submit.mockResolvedValue({
        id: 'ro_short_exit',
        status: 'submitted',
        client_order_id: 'nt-ti_001-short',
        broker_order_id: 'order_short_exit',
        error: null,
      });
      prisma.tradeIntent.update.mockResolvedValue(
        pendingIntent({
          status: 'real_pending',
          fill_price: null,
          quantity: null,
          decided_by: 'autonomous',
        }),
      );

      await service.autoProcess('ti_001');

      expect(realOrderService.submit).toHaveBeenCalledWith(
        oc({ symbol: 'AAPL', side: 'sell', requestedQty: 7 }),
      );
      expect(gateway.placeOrder).not.toHaveBeenCalled();
    });

    it('real exit when getPortfolio throws → status=failed, placeOrder NEVER called (fail-safe, no wrong-qty sell)', async () => {
      enableReal(kv, prisma, 'alpaca-provider', 5000);
      prisma.tradeIntent.findUnique.mockResolvedValue(
        pendingIntent({ action: 'exit', symbol: 'AAPL' }),
      );
      mockAaplQuote(gateway);
      // Paper portfolio has a matching position — must NOT be used as a fallback.
      prisma.portfolio.findUnique.mockResolvedValue({
        name: 'paper',
        data: JSON.stringify({
          equity: 11_400,
          cash: 10_000,
          positions: [{ symbol: 'AAPL', quantity: 10, avg_price: 140 }],
        }),
        updatedAt: new Date(),
      });
      gateway.getPortfolio.mockRejectedValue(new Error('Broker unreachable'));
      const failed = pendingIntent({
        status: 'failed',
        decided_by: 'autonomous',
        result_json: JSON.stringify({
          error: 'broker position unavailable — refusing to guess exit qty',
        }),
      });
      prisma.tradeIntent.update.mockResolvedValue(failed);

      const result = await service.autoProcess('ti_001');

      expect(gateway.placeOrder).not.toHaveBeenCalled();
      expect(result.status).toBe('failed');
      expect(prisma.tradeIntent.update).toHaveBeenCalledWith(
        oc({ data: oc({ status: 'failed' }) }),
      );
    });

    it('real exit when broker reports no matching position → status=failed, placeOrder NEVER called', async () => {
      enableReal(kv, prisma, 'alpaca-provider', 5000);
      prisma.tradeIntent.findUnique.mockResolvedValue(
        pendingIntent({ action: 'exit', symbol: 'AAPL' }),
      );
      mockAaplQuote(gateway);
      mockPaperPortfolio(prisma);
      gateway.getPortfolio.mockResolvedValue({
        provider_id: 'alpaca-provider',
        equity: 10_000,
        cash: 10_000,
        buying_power: 10_000,
        positions: [], // no open position for AAPL
        total_market_value: 0,
        total_pnl: 0,
        ts: new Date().toISOString(),
      });
      const failed = pendingIntent({ status: 'failed', decided_by: 'autonomous' });
      prisma.tradeIntent.update.mockResolvedValue(failed);

      const result = await service.autoProcess('ti_001');

      expect(gateway.placeOrder).not.toHaveBeenCalled();
      expect(result.status).toBe('failed');
    });

    it('end-to-end: real long opens a position via broker, then real exit closes it using the broker-reported qty', async () => {
      enableReal(kv, prisma, 'alpaca-provider', 5000);

      // Step 1: open a real long. qty = floor(10000 * 0.1 / 150) = 6.
      prisma.tradeIntent.findUnique.mockResolvedValueOnce(
        pendingIntent({ id: 'ti_open', action: 'long', symbol: 'AAPL' }),
      );
      mockAaplQuote(gateway);
      realOrderService.submit.mockResolvedValueOnce({
        id: 'ro_open',
        status: 'submitted',
        client_order_id: 'nt-ti_open',
        broker_order_id: 'order_open',
        error: null,
      });
      prisma.tradeIntent.update.mockResolvedValueOnce(
        pendingIntent({
          id: 'ti_open',
          status: 'real_pending',
          fill_price: null,
          quantity: null,
          decided_by: 'autonomous',
        }),
      );

      const opened = await service.autoProcess('ti_open');
      expect(opened.status).toBe('real_pending');
      expect(realOrderService.submit).toHaveBeenNthCalledWith(
        1,
        oc({ symbol: 'AAPL', side: 'buy', requestedQty: 6 }),
      );

      // Step 2: broker now reports the 6-share position opened above; issue a real exit.
      prisma.tradeIntent.findUnique.mockResolvedValueOnce(
        pendingIntent({ id: 'ti_close', action: 'exit', symbol: 'AAPL' }),
      );
      gateway.getPortfolio.mockResolvedValue({
        provider_id: 'alpaca-provider',
        equity: 10_900,
        cash: 10_000,
        buying_power: 10_000,
        positions: [
          {
            symbol: 'AAPL',
            qty: 6,
            avg_entry: 150,
            market_value: 900,
            unrealized_pnl: 0,
            side: 'long',
          },
        ],
        total_market_value: 900,
        total_pnl: 0,
        ts: new Date().toISOString(),
      });
      realOrderService.submit.mockResolvedValueOnce({
        id: 'ro_close',
        status: 'submitted',
        client_order_id: 'nt-ti_close',
        broker_order_id: 'order_close',
        error: null,
      });
      prisma.tradeIntent.update.mockResolvedValueOnce(
        pendingIntent({
          id: 'ti_close',
          status: 'real_pending',
          fill_price: null,
          quantity: null,
          decided_by: 'autonomous',
        }),
      );

      const closed = await service.autoProcess('ti_close');
      expect(closed.status).toBe('real_pending');
      expect(realOrderService.submit).toHaveBeenNthCalledWith(
        2,
        oc({ symbol: 'AAPL', side: 'sell', requestedQty: 6 }),
      );
      expect(gateway.placeOrder).not.toHaveBeenCalled();
    });

    it('risk gate in real mode reads the REAL account, NOT the paper portfolio — drawdown halt fires on real drawdown even when paper shows none', async () => {
      // THE HEADLINE BUG FIX: the paper portfolio is perfectly healthy (no drawdown at all —
      // equity == hwm), but the REAL account (RealNavSnapshot) is drawn down 30%, past the
      // 25% halt. If the kernel were still reading paperState (the bug), this order would
      // execute. It must be rejected — driven by REAL equity/hwm, not paper.
      enableReal(kv, prisma);
      mockRealAccountState(prisma, { equity: 7_000, hwm: 10_000 }); // real: 30% dd
      prisma.tradeIntent.findUnique.mockResolvedValue(pendingIntent({ action: 'long' }));
      prisma.portfolio.findUnique.mockResolvedValue({
        name: 'paper',
        data: JSON.stringify({ equity: 10_000, cash: 10_000, positions: [], hwm: 10_000 }), // paper: 0% dd
        updatedAt: new Date(),
      });
      const rejected = pendingIntent({
        status: 'rejected',
        decided_by: 'autonomous',
        reject_reason: 'circuit breaker: drawdown 30% >= 25%',
      });
      prisma.tradeIntent.update.mockResolvedValue(rejected);

      const result = await service.autoProcess('ti_001');

      // Real mode: risk gate fires BEFORE any quote fetch or order
      expect(gateway.getQuote).not.toHaveBeenCalled();
      expect(gateway.placeOrder).not.toHaveBeenCalled();
      expect(realOrderService.submit).not.toHaveBeenCalled();
      expect(result.status).toBe('rejected');
      expect(prisma.tradeIntent.update).toHaveBeenCalledWith(
        oc({
          data: oc({
            status: 'rejected',
            reject_reason: expect.stringContaining('drawdown 30%') as string,
          }),
        }),
      );
    });

    it('real long with NO RealNavSnapshot yet (fresh, never-synced real account) FAILS CLOSED — status=failed, never falls back to paper', async () => {
      enableReal(kv, prisma);
      mockNoRealAccountState(prisma); // overrides enableReal's default — simulates a fresh real account
      prisma.tradeIntent.findUnique.mockResolvedValue(pendingIntent({ action: 'long' }));
      mockPaperPortfolio(prisma); // paper shows a perfectly healthy account — must NOT be used
      const failed = pendingIntent({ status: 'failed', decided_by: 'autonomous' });
      prisma.tradeIntent.update.mockResolvedValue(failed);

      const result = await service.autoProcess('ti_001');

      expect(gateway.getQuote).not.toHaveBeenCalled();
      expect(gateway.placeOrder).not.toHaveBeenCalled();
      expect(realOrderService.submit).not.toHaveBeenCalled();
      expect(result.status).toBe('failed');
      expect(prisma.tradeIntent.update).toHaveBeenCalledWith(
        oc({
          data: oc({
            status: 'failed',
            result_json: expect.stringContaining('real account state unavailable') as string,
          }),
        }),
      );
    });

    it('real short with NO RealNavSnapshot yet FAILS CLOSED — status=failed', async () => {
      enableReal(kv, prisma);
      mockNoRealAccountState(prisma);
      prisma.tradeIntent.findUnique.mockResolvedValue(pendingIntent({ action: 'short' }));
      mockPaperPortfolio(prisma);
      const failed = pendingIntent({ status: 'failed', decided_by: 'autonomous' });
      prisma.tradeIntent.update.mockResolvedValue(failed);

      const result = await service.autoProcess('ti_001');

      expect(realOrderService.submit).not.toHaveBeenCalled();
      expect(result.status).toBe('failed');
      expect(prisma.tradeIntent.update).toHaveBeenCalledWith(
        oc({
          data: oc({
            status: 'failed',
            result_json: expect.stringContaining('real account state unavailable') as string,
          }),
        }),
      );
    });

    it('real exit with NO RealNavSnapshot yet still executes — closing is always safe, qty is sourced from the broker', async () => {
      enableReal(kv, prisma, 'alpaca-provider', 5000);
      mockNoRealAccountState(prisma); // fail-closed only applies to opening trades
      prisma.tradeIntent.findUnique.mockResolvedValue(
        pendingIntent({ action: 'exit', symbol: 'AAPL' }),
      );
      mockAaplQuote(gateway);
      gateway.getPortfolio.mockResolvedValue({
        provider_id: 'alpaca-provider',
        equity: 10_900,
        cash: 10_000,
        buying_power: 10_000,
        positions: [
          {
            symbol: 'AAPL',
            qty: 6,
            avg_entry: 150,
            market_value: 900,
            unrealized_pnl: 0,
            side: 'long',
          },
        ],
        total_market_value: 900,
        total_pnl: 0,
        ts: new Date().toISOString(),
      });
      realOrderService.submit.mockResolvedValue({
        id: 'ro_exit_nostate',
        status: 'submitted',
        client_order_id: 'nt-ti_001-exit',
        broker_order_id: 'order_exit',
        error: null,
      });
      prisma.tradeIntent.update.mockResolvedValue(
        pendingIntent({
          status: 'real_pending',
          fill_price: null,
          quantity: null,
          decided_by: 'autonomous',
        }),
      );

      const result = await service.autoProcess('ti_001');

      expect(result.status).toBe('real_pending');
      expect(realOrderService.submit).toHaveBeenCalledWith(
        oc({ symbol: 'AAPL', side: 'sell', requestedQty: 6 }),
      );
    });

    it('real long sizing uses real buying_power, independent of paperState.equity', async () => {
      enableReal(kv, prisma);
      // Real buying power ($3k) much smaller than the paper equity ($10k, mocked below) — if
      // sizing were wrongly derived from paper, qty would be floor(10000*0.1/150)=6 instead.
      mockRealAccountState(prisma, { equity: 3_000, hwm: 3_000, buying_power: 3_000 });
      mockPaperPortfolio(prisma); // paper equity=10_000 — must NOT be used for real sizing
      prisma.tradeIntent.findUnique.mockResolvedValue(
        pendingIntent({ action: 'long', symbol: 'AAPL' }),
      );
      mockAaplQuote(gateway); // price=150 → expected qty = floor(3000 * 0.1 / 150) = 2
      realOrderService.submit.mockResolvedValue({
        id: 'ro_sizing',
        status: 'submitted',
        client_order_id: 'nt-ti_001-sizing',
        broker_order_id: 'order_sizing',
        error: null,
      });
      prisma.tradeIntent.update.mockResolvedValue(
        pendingIntent({
          status: 'real_pending',
          fill_price: null,
          quantity: null,
          decided_by: 'autonomous',
        }),
      );

      await service.autoProcess('ti_001');

      expect(realOrderService.submit).toHaveBeenCalledWith(
        oc({ symbol: 'AAPL', side: 'buy', requestedQty: 2 }),
      );
    });

    it('real max-open-positions gate uses the RealPosition count, independent of paperState.positions', async () => {
      enableReal(kv, prisma);
      // Paper has 0 open positions (would pass if wrongly gated on paper) but the real
      // account already has 10 open RealPosition rows — at the default max_open_positions=10.
      mockRealAccountState(prisma, { openPositionsCount: 10 });
      mockPaperPortfolio(prisma);
      prisma.tradeIntent.findUnique.mockResolvedValue(pendingIntent({ action: 'long' }));
      const rejected = pendingIntent({ status: 'rejected', decided_by: 'autonomous' });
      prisma.tradeIntent.update.mockResolvedValue(rejected);

      const result = await service.autoProcess('ti_001');

      expect(gateway.getQuote).not.toHaveBeenCalled();
      expect(realOrderService.submit).not.toHaveBeenCalled();
      expect(result.status).toBe('rejected');
      expect(prisma.tradeIntent.update).toHaveBeenCalledWith(
        oc({
          data: oc({
            status: 'rejected',
            reject_reason: expect.stringContaining('max open positions reached (10/10)') as string,
          }),
        }),
      );
    });

    it('hold in real mode → no order placed, status=executed, quantity=0', async () => {
      enableReal(kv, prisma);
      prisma.tradeIntent.findUnique.mockResolvedValue(pendingIntent({ action: 'hold' }));
      const executed = pendingIntent({ status: 'executed', quantity: 0, decided_by: 'autonomous' });
      prisma.tradeIntent.update.mockResolvedValue(executed);

      const result = await service.autoProcess('ti_001');

      expect(gateway.getQuote).not.toHaveBeenCalled();
      expect(gateway.placeOrder).not.toHaveBeenCalled();
      expect(result.status).toBe('executed');
      expect(result.quantity).toBe(0);
    });

    // ── fast-poll wiring after a successful real submit ────────────────────────

    describe('fast-poll wiring after a successful real submit', () => {
      it('a successful real submit triggers fastPollOrder fire-and-forget, without blocking the cycle', async () => {
        enableReal(kv, prisma);
        prisma.tradeIntent.findUnique.mockResolvedValue(
          pendingIntent({ action: 'long', symbol: 'AAPL' }),
        );
        mockAaplQuote(gateway);
        realOrderService.submit.mockResolvedValue({
          id: 'ro_fastpoll',
          status: 'submitted',
          client_order_id: 'nt-ti_001-abc',
          broker_order_id: 'order_abc',
          error: null,
        });
        const pending = pendingIntent({
          status: 'real_pending',
          fill_price: null,
          quantity: null,
          decided_by: 'autonomous',
        });
        prisma.tradeIntent.update.mockResolvedValue(pending);
        // fastPollOrder() never resolves within this test — proves autoProcess does NOT
        // await it (otherwise this test would hang / time out).
        reconciliation.fastPollOrder.mockReturnValue(new Promise<void>(() => undefined));

        const result = await service.autoProcess('ti_001');

        expect(result.status).toBe('real_pending');
        expect(reconciliation.fastPollOrder).toHaveBeenCalledTimes(1);
        expect(reconciliation.fastPollOrder).toHaveBeenCalledWith('ro_fastpoll');
      });

      it('fastPollOrder rejecting does NOT propagate into autoProcess and does NOT fail the trade intent', async () => {
        enableReal(kv, prisma);
        prisma.tradeIntent.findUnique.mockResolvedValue(
          pendingIntent({ action: 'long', symbol: 'AAPL' }),
        );
        mockAaplQuote(gateway);
        realOrderService.submit.mockResolvedValue({
          id: 'ro_fastpoll_reject',
          status: 'submitted',
          client_order_id: 'nt-ti_001-abc',
          broker_order_id: 'order_abc',
          error: null,
        });
        const pending = pendingIntent({
          status: 'real_pending',
          fill_price: null,
          quantity: null,
          decided_by: 'autonomous',
        });
        prisma.tradeIntent.update.mockResolvedValue(pending);
        reconciliation.fastPollOrder.mockRejectedValue(new Error('fastPollOrder blew up'));

        await expect(service.autoProcess('ti_001')).resolves.toBeDefined();
        // Give the fire-and-forget microtask a tick to settle its .catch() handler.
        await new Promise((resolve) => setImmediate(resolve));

        expect(reconciliation.fastPollOrder).toHaveBeenCalledTimes(1);
      });

      it('submit_failed outcome does NOT trigger fastPollOrder at all', async () => {
        enableReal(kv, prisma);
        prisma.tradeIntent.findUnique.mockResolvedValue(
          pendingIntent({ action: 'long', symbol: 'AAPL' }),
        );
        mockAaplQuote(gateway);
        realOrderService.submit.mockResolvedValue({
          id: 'ro_failed_nopoll',
          status: 'submit_failed',
          client_order_id: 'nt-ti_001-xyz',
          broker_order_id: null,
          error: 'Broker connection refused',
        });
        const failed = pendingIntent({ status: 'failed', decided_by: 'autonomous' });
        prisma.tradeIntent.update.mockResolvedValue(failed);

        const result = await service.autoProcess('ti_001');

        expect(result.status).toBe('failed');
        expect(reconciliation.fastPollOrder).not.toHaveBeenCalled();
      });

      it('RealOrderService.submit throwing does NOT trigger fastPollOrder at all', async () => {
        enableReal(kv, prisma);
        prisma.tradeIntent.findUnique.mockResolvedValue(
          pendingIntent({ action: 'long', symbol: 'AAPL' }),
        );
        mockAaplQuote(gateway);
        realOrderService.submit.mockRejectedValue(new Error('Broker connection refused'));
        const failed = pendingIntent({ status: 'failed', decided_by: 'autonomous' });
        prisma.tradeIntent.update.mockResolvedValue(failed);

        const result = await service.autoProcess('ti_001');

        expect(result.status).toBe('failed');
        expect(reconciliation.fastPollOrder).not.toHaveBeenCalled();
      });
    });

    // ── Fix 1: stale RealNavSnapshot must fail closed exactly like a missing one ──
    describe('real account state freshness (stale RealNavSnapshot fails closed)', () => {
      it('real long with a RealNavSnapshot older than the default window (300_000ms) FAILS CLOSED', async () => {
        enableReal(kv, prisma);
        mockRealAccountState(prisma, { ts: new Date(Date.now() - 400_000) }); // 400s old > 300s default
        prisma.tradeIntent.findUnique.mockResolvedValue(pendingIntent({ action: 'long' }));
        mockPaperPortfolio(prisma); // paper is healthy — must NOT be used
        const failed = pendingIntent({ status: 'failed', decided_by: 'autonomous' });
        prisma.tradeIntent.update.mockResolvedValue(failed);

        const result = await service.autoProcess('ti_001');

        expect(gateway.getQuote).not.toHaveBeenCalled();
        expect(realOrderService.submit).not.toHaveBeenCalled();
        expect(result.status).toBe('failed');
        expect(prisma.tradeIntent.update).toHaveBeenCalledWith(
          oc({
            data: oc({
              status: 'failed',
              result_json: expect.stringContaining('real account state unavailable') as string,
            }),
          }),
        );
      });

      it('real short with a stale RealNavSnapshot FAILS CLOSED', async () => {
        enableReal(kv, prisma);
        mockRealAccountState(prisma, { ts: new Date(Date.now() - 400_000) });
        prisma.tradeIntent.findUnique.mockResolvedValue(pendingIntent({ action: 'short' }));
        mockPaperPortfolio(prisma);
        mockAaplQuote(gateway);
        const failed = pendingIntent({ status: 'failed', decided_by: 'autonomous' });
        prisma.tradeIntent.update.mockResolvedValue(failed);

        const result = await service.autoProcess('ti_001');

        expect(gateway.getQuote).not.toHaveBeenCalled();
        expect(realOrderService.submit).not.toHaveBeenCalled();
        expect(result.status).toBe('failed');
      });

      it('real long with a RealNavSnapshot WITHIN the default window proceeds normally (not rejected for staleness)', async () => {
        enableReal(kv, prisma);
        mockRealAccountState(prisma, { ts: new Date(Date.now() - 100_000) }); // 100s old < 300s default
        prisma.tradeIntent.findUnique.mockResolvedValue(
          pendingIntent({ action: 'long', symbol: 'AAPL' }),
        );
        mockPaperPortfolio(prisma);
        mockAaplQuote(gateway);
        realOrderService.submit.mockResolvedValue({
          id: 'ro_fresh',
          status: 'submitted',
          client_order_id: 'nt-ti_001-fresh',
          broker_order_id: 'order_fresh',
          error: null,
        });
        prisma.tradeIntent.update.mockResolvedValue(
          pendingIntent({
            status: 'real_pending',
            fill_price: null,
            quantity: null,
            decided_by: 'autonomous',
          }),
        );

        const result = await service.autoProcess('ti_001');

        expect(result.status).toBe('real_pending');
        expect(realOrderService.submit).toHaveBeenCalledTimes(1);
      });

      it('real exit with a STALE RealNavSnapshot still executes — exit is exempt, qty sourced from the broker', async () => {
        enableReal(kv, prisma, 'alpaca-provider', 5000);
        mockRealAccountState(prisma, { ts: new Date(Date.now() - 400_000) }); // stale
        prisma.tradeIntent.findUnique.mockResolvedValue(
          pendingIntent({ action: 'exit', symbol: 'AAPL' }),
        );
        mockAaplQuote(gateway);
        mockPaperPortfolio(prisma);
        gateway.getPortfolio.mockResolvedValue({
          provider_id: 'alpaca-provider',
          equity: 10_900,
          cash: 10_000,
          buying_power: 10_000,
          positions: [
            {
              symbol: 'AAPL',
              qty: 6,
              avg_entry: 150,
              market_value: 900,
              unrealized_pnl: 0,
              side: 'long',
            },
          ],
          total_market_value: 900,
          total_pnl: 0,
          ts: new Date().toISOString(),
        });
        realOrderService.submit.mockResolvedValue({
          id: 'ro_stale_exit',
          status: 'submitted',
          client_order_id: 'nt-ti_001-stale-exit',
          broker_order_id: 'order_stale_exit',
          error: null,
        });
        prisma.tradeIntent.update.mockResolvedValue(
          pendingIntent({
            status: 'real_pending',
            fill_price: null,
            quantity: null,
            decided_by: 'autonomous',
          }),
        );

        const result = await service.autoProcess('ti_001');

        expect(result.status).toBe('real_pending');
        expect(realOrderService.submit).toHaveBeenCalledWith(
          oc({ symbol: 'AAPL', side: 'sell', requestedQty: 6 }),
        );
      });

      it('missing snapshot (no row at all) still fails closed as before (existing coverage re-confirmed)', async () => {
        enableReal(kv, prisma);
        mockNoRealAccountState(prisma);
        prisma.tradeIntent.findUnique.mockResolvedValue(pendingIntent({ action: 'long' }));
        mockPaperPortfolio(prisma);
        const failed = pendingIntent({ status: 'failed', decided_by: 'autonomous' });
        prisma.tradeIntent.update.mockResolvedValue(failed);

        const result = await service.autoProcess('ti_001');

        expect(realOrderService.submit).not.toHaveBeenCalled();
        expect(result.status).toBe('failed');
      });

      it('window is KV-configurable: execution.real_state_max_age_ms=900000 lets a 400s-old snapshot pass (past the 300s default, within the 900s custom window)', async () => {
        kv.get.mockImplementation((key: string) => {
          if (key === 'execution.real') return Promise.resolve('true');
          if (key === 'execution.broker_plugin_id') return Promise.resolve('alpaca-provider');
          if (key === 'execution.max_order_notional') return Promise.resolve('1000');
          if (key === 'strategy.applied') return Promise.resolve('s_live');
          if (key === 'execution.real_state_max_age_ms') return Promise.resolve('900000'); // 15min
          return Promise.resolve(null);
        });
        mockRobustAppliedStrategy(prisma);
        mockRealAccountState(prisma, { ts: new Date(Date.now() - 400_000) }); // 400s old
        prisma.tradeIntent.findUnique.mockResolvedValue(
          pendingIntent({ action: 'long', symbol: 'AAPL' }),
        );
        mockPaperPortfolio(prisma);
        mockAaplQuote(gateway);
        realOrderService.submit.mockResolvedValue({
          id: 'ro_custom_window',
          status: 'submitted',
          client_order_id: 'nt-ti_001-custom',
          broker_order_id: 'order_custom',
          error: null,
        });
        prisma.tradeIntent.update.mockResolvedValue(
          pendingIntent({
            status: 'real_pending',
            fill_price: null,
            quantity: null,
            decided_by: 'autonomous',
          }),
        );

        const result = await service.autoProcess('ti_001');

        expect(result.status).toBe('real_pending');
      });

      it('window is clamped to a 30_000ms floor: a raw config of 1000ms still treats a 20_000ms-old snapshot as fresh', async () => {
        kv.get.mockImplementation((key: string) => {
          if (key === 'execution.real') return Promise.resolve('true');
          if (key === 'execution.broker_plugin_id') return Promise.resolve('alpaca-provider');
          if (key === 'execution.max_order_notional') return Promise.resolve('1000');
          if (key === 'strategy.applied') return Promise.resolve('s_live');
          if (key === 'execution.real_state_max_age_ms') return Promise.resolve('1000'); // below floor
          return Promise.resolve(null);
        });
        mockRobustAppliedStrategy(prisma);
        mockRealAccountState(prisma, { ts: new Date(Date.now() - 20_000) }); // 20s old
        prisma.tradeIntent.findUnique.mockResolvedValue(
          pendingIntent({ action: 'long', symbol: 'AAPL' }),
        );
        mockPaperPortfolio(prisma);
        mockAaplQuote(gateway);
        realOrderService.submit.mockResolvedValue({
          id: 'ro_clamp_floor',
          status: 'submitted',
          client_order_id: 'nt-ti_001-clampfloor',
          broker_order_id: 'order_clampfloor',
          error: null,
        });
        prisma.tradeIntent.update.mockResolvedValue(
          pendingIntent({
            status: 'real_pending',
            fill_price: null,
            quantity: null,
            decided_by: 'autonomous',
          }),
        );

        const result = await service.autoProcess('ti_001');

        // If the raw 1000ms had been used unclamped, a 20s-old snapshot would be stale and
        // this order would be rejected. Clamping to the 30_000ms floor keeps it fresh.
        expect(result.status).toBe('real_pending');
      });

      it('window is clamped to a 3_600_000ms ceiling: a raw config far above it still rejects a snapshot older than 1h', async () => {
        kv.get.mockImplementation((key: string) => {
          if (key === 'execution.real') return Promise.resolve('true');
          if (key === 'execution.broker_plugin_id') return Promise.resolve('alpaca-provider');
          if (key === 'execution.max_order_notional') return Promise.resolve('1000');
          if (key === 'strategy.applied') return Promise.resolve('s_live');
          if (key === 'execution.real_state_max_age_ms') return Promise.resolve('99999999'); // above ceiling
          return Promise.resolve(null);
        });
        mockRobustAppliedStrategy(prisma);
        mockRealAccountState(prisma, { ts: new Date(Date.now() - 4_000_000) }); // ~66.6 min old
        prisma.tradeIntent.findUnique.mockResolvedValue(pendingIntent({ action: 'long' }));
        mockPaperPortfolio(prisma);
        mockAaplQuote(gateway);
        const failed = pendingIntent({ status: 'failed', decided_by: 'autonomous' });
        prisma.tradeIntent.update.mockResolvedValue(failed);

        const result = await service.autoProcess('ti_001');

        // Without the 3_600_000ms ceiling clamp, the raw 99_999_999ms config would treat this
        // snapshot as fresh. Clamping to the ceiling correctly rejects it as stale.
        expect(gateway.getQuote).not.toHaveBeenCalled();
        expect(realOrderService.submit).not.toHaveBeenCalled();
        expect(result.status).toBe('failed');
      });

      it('non-finite/garbage config falls back to the 300_000ms default window', async () => {
        kv.get.mockImplementation((key: string) => {
          if (key === 'execution.real') return Promise.resolve('true');
          if (key === 'execution.broker_plugin_id') return Promise.resolve('alpaca-provider');
          if (key === 'execution.max_order_notional') return Promise.resolve('1000');
          if (key === 'strategy.applied') return Promise.resolve('s_live');
          if (key === 'execution.real_state_max_age_ms') return Promise.resolve('not-a-number');
          return Promise.resolve(null);
        });
        mockRobustAppliedStrategy(prisma);
        mockRealAccountState(prisma, { ts: new Date(Date.now() - 400_000) }); // 400s old > 300s default
        prisma.tradeIntent.findUnique.mockResolvedValue(pendingIntent({ action: 'long' }));
        mockPaperPortfolio(prisma);
        mockAaplQuote(gateway);
        const failed = pendingIntent({ status: 'failed', decided_by: 'autonomous' });
        prisma.tradeIntent.update.mockResolvedValue(failed);

        const result = await service.autoProcess('ti_001');

        expect(gateway.getQuote).not.toHaveBeenCalled();
        expect(realOrderService.submit).not.toHaveBeenCalled();
        expect(result.status).toBe('failed');
      });
    });

    // ── Fix 2: real sizing must be equity-based, capped by buying power, finite-guarded ──
    describe('equity-based real sizing capped by buying power (Fix 2)', () => {
      it('real long sizes to floor(equity * max_position_pct / price), NOT buying_power, even when buying_power is much larger', async () => {
        enableReal(kv, prisma);
        // equity=3_000, buying_power=30_000 (10x). If sized off buying_power, qty would be
        // floor(30000*0.1/150)=20. Equity-based: floor(3000*0.1/150)=2.
        mockRealAccountState(prisma, { equity: 3_000, hwm: 3_000, buying_power: 30_000 });
        prisma.tradeIntent.findUnique.mockResolvedValue(
          pendingIntent({ action: 'long', symbol: 'AAPL' }),
        );
        mockAaplQuote(gateway); // price=150
        realOrderService.submit.mockResolvedValue({
          id: 'ro_equity_sizing',
          status: 'submitted',
          client_order_id: 'nt-ti_001-equity',
          broker_order_id: 'order_equity',
          error: null,
        });
        prisma.tradeIntent.update.mockResolvedValue(
          pendingIntent({
            status: 'real_pending',
            fill_price: null,
            quantity: null,
            decided_by: 'autonomous',
          }),
        );

        await service.autoProcess('ti_001');

        expect(realOrderService.submit).toHaveBeenCalledWith(
          oc({ symbol: 'AAPL', side: 'buy', requestedQty: 2 }),
        );
      });

      it('real short sizes to floor(equity * max_position_pct / price), NOT buying_power', async () => {
        enableReal(kv, prisma);
        mockRealAccountState(prisma, { equity: 3_000, hwm: 3_000, buying_power: 30_000 });
        prisma.tradeIntent.findUnique.mockResolvedValue(
          pendingIntent({ action: 'short', symbol: 'AAPL' }),
        );
        mockAaplQuote(gateway); // price=150
        realOrderService.submit.mockResolvedValue({
          id: 'ro_equity_sizing_short',
          status: 'submitted',
          client_order_id: 'nt-ti_001-equity-short',
          broker_order_id: 'order_equity_short',
          error: null,
        });
        prisma.tradeIntent.update.mockResolvedValue(
          pendingIntent({
            status: 'real_pending',
            fill_price: null,
            quantity: null,
            decided_by: 'autonomous',
          }),
        );

        await service.autoProcess('ti_001');

        expect(realOrderService.submit).toHaveBeenCalledWith(
          oc({ symbol: 'AAPL', side: 'sell', requestedQty: 2 }),
        );
      });

      it('qty is capped down to floor(buying_power / price) when the equity-based qty would exceed buying_power (never increased above the equity ceiling)', async () => {
        enableReal(kv, prisma);
        // equity=100_000 (huge), buying_power=200 (tiny). Equity-based qty = floor(100000*0.1/150)=66,
        // but buying_power only allows floor(200/150)=1. Must be capped down to 1.
        mockRealAccountState(prisma, { equity: 100_000, hwm: 100_000, buying_power: 200 });
        prisma.tradeIntent.findUnique.mockResolvedValue(
          pendingIntent({ action: 'long', symbol: 'AAPL' }),
        );
        mockAaplQuote(gateway); // price=150
        realOrderService.submit.mockResolvedValue({
          id: 'ro_bp_cap',
          status: 'submitted',
          client_order_id: 'nt-ti_001-bpcap',
          broker_order_id: 'order_bpcap',
          error: null,
        });
        prisma.tradeIntent.update.mockResolvedValue(
          pendingIntent({
            status: 'real_pending',
            fill_price: null,
            quantity: null,
            decided_by: 'autonomous',
          }),
        );

        await service.autoProcess('ti_001');

        expect(realOrderService.submit).toHaveBeenCalledWith(
          oc({ symbol: 'AAPL', side: 'buy', requestedQty: 1 }),
        );
      });

      it('non-finite equity (NaN) FAILS CLOSED before any arithmetic — no order placed', async () => {
        enableReal(kv, prisma);
        mockRealAccountState(prisma, { equity: Number.NaN, hwm: 10_000, buying_power: 10_000 });
        prisma.tradeIntent.findUnique.mockResolvedValue(
          pendingIntent({ action: 'long', symbol: 'AAPL' }),
        );
        mockAaplQuote(gateway);
        const failed = pendingIntent({ status: 'failed', decided_by: 'autonomous' });
        prisma.tradeIntent.update.mockResolvedValue(failed);

        const result = await service.autoProcess('ti_001');

        expect(realOrderService.submit).not.toHaveBeenCalled();
        expect(result.status).toBe('failed');
        expect(prisma.tradeIntent.update).toHaveBeenCalledWith(
          oc({
            data: oc({
              status: 'failed',
              result_json: expect.stringContaining('non-finite') as string,
            }),
          }),
        );
      });

      it('non-finite buyingPower (Infinity) FAILS CLOSED — no order placed', async () => {
        enableReal(kv, prisma);
        mockRealAccountState(prisma, {
          equity: 10_000,
          hwm: 10_000,
          buying_power: Number.POSITIVE_INFINITY,
        });
        prisma.tradeIntent.findUnique.mockResolvedValue(
          pendingIntent({ action: 'long', symbol: 'AAPL' }),
        );
        mockAaplQuote(gateway);
        const failed = pendingIntent({ status: 'failed', decided_by: 'autonomous' });
        prisma.tradeIntent.update.mockResolvedValue(failed);

        const result = await service.autoProcess('ti_001');

        expect(realOrderService.submit).not.toHaveBeenCalled();
        expect(result.status).toBe('failed');
        expect(prisma.tradeIntent.update).toHaveBeenCalledWith(
          oc({
            data: oc({
              status: 'failed',
              result_json: expect.stringContaining('non-finite') as string,
            }),
          }),
        );
      });
    });
  });

  // ── real-money kill-switch (real_execution.halted) ────────────────────────────
  //
  // A global halt that blocks NEW real long/short entries while exit/hold and the
  // entire paper path remain completely unaffected — see real-execution-halt.util.ts.
  describe('real execution kill-switch (real_execution.halted)', () => {
    function enableRealHalted(reason = 'reconciliation circuit breaker open') {
      kv.get.mockImplementation((key: string) => {
        if (key === 'execution.real') return Promise.resolve('true');
        if (key === 'execution.broker_plugin_id') return Promise.resolve('alpaca-provider');
        if (key === 'execution.max_order_notional') return Promise.resolve('1000');
        if (key === 'strategy.applied') return Promise.resolve('s_live');
        if (key === 'real_execution.halted') return Promise.resolve('true');
        if (key === 'real_execution.halt_reason') return Promise.resolve(reason);
        return Promise.resolve(null);
      });
      mockRobustAppliedStrategy(prisma);
      mockRealAccountState(prisma);
    }

    it.each(['long', 'short'] as const)(
      'real %s is rejected with status=failed and the kill-switch reason when halted',
      async (action) => {
        enableRealHalted();
        prisma.tradeIntent.findUnique.mockResolvedValue(pendingIntent({ action, symbol: 'AAPL' }));
        mockAaplQuote(gateway);
        const failed = pendingIntent({ status: 'failed', decided_by: 'autonomous' });
        prisma.tradeIntent.update.mockResolvedValue(failed);

        const result = await service.autoProcess('ti_001');

        expect(realOrderService.submit).not.toHaveBeenCalled();
        expect(gateway.placeOrder).not.toHaveBeenCalled();
        expect(result.status).toBe('failed');
        expect(prisma.tradeIntent.update).toHaveBeenCalledWith(
          oc({
            data: oc({
              status: 'failed',
              result_json: expect.stringContaining('kill-switch') as string,
            }),
          }),
        );
      },
    );

    it('real exit still executes normally when halted (closing a position must never be blocked)', async () => {
      enableRealHalted();
      prisma.tradeIntent.findUnique.mockResolvedValue(
        pendingIntent({ action: 'exit', symbol: 'AAPL' }),
      );
      mockPaperPortfolio(prisma);
      gateway.getPortfolio.mockResolvedValue({
        provider_id: 'alpaca-provider',
        equity: 11_400,
        cash: 10_000,
        buying_power: 10_000,
        positions: [
          {
            symbol: 'AAPL',
            qty: 10,
            avg_entry: 140,
            market_value: 1500,
            unrealized_pnl: 100,
            side: 'long',
          },
        ],
        total_market_value: 1500,
        total_pnl: 100,
        ts: new Date().toISOString(),
      });
      mockAaplQuote(gateway);
      realOrderService.submit.mockResolvedValue({
        id: 'ro_halt_exit',
        status: 'submitted',
        client_order_id: 'nt-ti_001-exit',
        broker_order_id: 'order_exit',
        error: null,
      });
      const pending = pendingIntent({
        status: 'real_pending',
        fill_price: null,
        quantity: null,
        decided_by: 'autonomous',
      });
      prisma.tradeIntent.update.mockResolvedValue(pending);

      const result = await service.autoProcess('ti_001');

      expect(realOrderService.submit).toHaveBeenCalledWith(
        oc({ symbol: 'AAPL', requestedQty: 10, side: 'sell' }),
      );
      expect(result.status).toBe('real_pending');
    });

    it('hold intents are unaffected by the halt flag', async () => {
      enableRealHalted();
      prisma.tradeIntent.findUnique.mockResolvedValue(pendingIntent({ action: 'hold' }));
      const executed = pendingIntent({ status: 'executed', quantity: 0, decided_by: 'autonomous' });
      prisma.tradeIntent.update.mockResolvedValue(executed);

      const result = await service.autoProcess('ti_001');

      expect(gateway.placeOrder).not.toHaveBeenCalled();
      expect(result.status).toBe('executed');
      expect(result.quantity).toBe(0);
    });

    it.each(['long', 'short', 'exit', 'hold'] as const)(
      'PAPER mode %s intents are completely unaffected by the halt flag',
      async (action) => {
        kv.get.mockImplementation((key: string) => {
          if (key === 'real_execution.halted') return Promise.resolve('true');
          return Promise.resolve(null); // execution.real stays unset → paper mode
        });
        prisma.tradeIntent.findUnique.mockResolvedValue(pendingIntent({ action, symbol: 'AAPL' }));
        mockPaperPortfolio(prisma);
        mockAaplQuote(gateway);
        prisma.portfolio.upsert.mockResolvedValue({
          name: 'paper',
          data: '{}',
          updatedAt: new Date(),
        });
        const executed = pendingIntent({
          status: 'executed',
          fill_price: action === 'hold' ? null : 150,
          quantity: action === 'hold' ? 0 : undefined,
          decided_by: 'autonomous',
        });
        prisma.tradeIntent.update.mockResolvedValue(executed);

        const result = await service.autoProcess('ti_001');

        expect(realOrderService.submit).not.toHaveBeenCalled();
        expect(gateway.placeOrder).not.toHaveBeenCalled();
        expect(result.status).toBe('executed');
      },
    );
  });

  // ── exit routing must follow WHERE the position actually lives, not the CURRENT
  // policy (stranded real-position bug) ─────────────────────────────────────────
  //
  // A real position can be opened while execution.real=true + broker_plugin_id set.
  // If the operator later flips execution.real=false (or clears broker_plugin_id)
  // while that real position is STILL OPEN at the broker, _effectiveMode alone would
  // route the next exit to paper — _executePaper finds no matching paper position
  // (it was never paper) and reports a FALSE "closed" (quantity:0, status:'executed')
  // while the real broker position remains open. This is a money-critical stranding
  // bug: exits must always check where the position actually lives.
  describe('exit routing follows the actual broker position, not just policy.real', () => {
    it('(a) real position open at broker + policy.real later flipped to false → exit STILL closes for REAL via broker, not a false paper close', async () => {
      // policy.real=false (flipped after the real entry), but broker_plugin_id is still
      // configured and the broker reports an open position for the symbol.
      kv.get.mockImplementation((key: string) => {
        if (key === 'execution.real') return Promise.resolve('false');
        if (key === 'execution.broker_plugin_id') return Promise.resolve('alpaca-provider');
        return Promise.resolve(null);
      });
      prisma.tradeIntent.findUnique.mockResolvedValue(
        pendingIntent({ action: 'exit', symbol: 'AAPL' }),
      );
      mockAaplQuote(gateway);
      // Paper portfolio has NO matching position — proves the paper path would have
      // falsely reported a qty=0 "close" if it were used.
      mockPaperPortfolio(prisma);
      gateway.getPortfolio.mockResolvedValue({
        provider_id: 'alpaca-provider',
        equity: 10_900,
        cash: 10_000,
        buying_power: 10_000,
        positions: [
          {
            symbol: 'AAPL',
            qty: 6,
            avg_entry: 150,
            market_value: 900,
            unrealized_pnl: 0,
            side: 'long',
          },
        ],
        total_market_value: 900,
        total_pnl: 0,
        ts: new Date().toISOString(),
      });
      realOrderService.submit.mockResolvedValue({
        id: 'ro_close_routing',
        status: 'submitted',
        client_order_id: 'nt-ti_001-routing',
        broker_order_id: 'order_close',
        error: null,
      });
      const pending = pendingIntent({
        status: 'real_pending',
        fill_price: null,
        quantity: null,
        decided_by: 'autonomous',
      });
      prisma.tradeIntent.update.mockResolvedValue(pending);

      const result = await service.autoProcess('ti_001');

      expect(gateway.getPortfolio).toHaveBeenCalledWith('alpaca-provider');
      expect(realOrderService.submit).toHaveBeenCalledWith(
        oc({ symbol: 'AAPL', side: 'sell', requestedQty: 6 }),
      );
      expect(gateway.placeOrder).not.toHaveBeenCalled();
      expect(result.status).toBe('real_pending');
      // Paper portfolio must NOT be mutated — this was a real close.
      expect(prisma.portfolio.upsert).not.toHaveBeenCalled();
    });

    it('(b) broker_plugin_id configured but broker reports NO position for the symbol → legitimate paper exit executes', async () => {
      kv.get.mockImplementation((key: string) => {
        if (key === 'execution.real') return Promise.resolve('false');
        if (key === 'execution.broker_plugin_id') return Promise.resolve('alpaca-provider');
        return Promise.resolve(null);
      });
      prisma.tradeIntent.findUnique.mockResolvedValue(
        pendingIntent({ action: 'exit', symbol: 'AAPL' }),
      );
      mockAaplQuote(gateway);
      // Paper portfolio DOES have a matching position — this is a legitimate paper-only exit.
      prisma.portfolio.findUnique.mockResolvedValue({
        name: 'paper',
        data: JSON.stringify({
          equity: 11_500,
          cash: 10_000,
          positions: [{ symbol: 'AAPL', quantity: 10, avg_price: 140 }],
        }),
        updatedAt: new Date(),
      });
      gateway.getPortfolio.mockResolvedValue({
        provider_id: 'alpaca-provider',
        equity: 10_000,
        cash: 10_000,
        buying_power: 10_000,
        positions: [], // broker holds nothing for this symbol
        total_market_value: 0,
        total_pnl: 0,
        ts: new Date().toISOString(),
      });
      prisma.portfolio.upsert.mockResolvedValue({
        name: 'paper',
        data: '{}',
        updatedAt: new Date(),
      });
      const executed = pendingIntent({
        status: 'executed',
        fill_price: 150,
        quantity: 10,
        realized_pnl: 100,
        decided_by: 'autonomous',
      });
      prisma.tradeIntent.update.mockResolvedValue(executed);

      const result = await service.autoProcess('ti_001');

      expect(gateway.getPortfolio).toHaveBeenCalledWith('alpaca-provider');
      expect(gateway.placeOrder).not.toHaveBeenCalled();
      expect(result.status).toBe('executed');
      expect(prisma.portfolio.upsert).toHaveBeenCalled(); // paper portfolio WAS mutated
    });

    it('(c) broker position query throws → status=failed, no sell order placed, no false paper "executed"', async () => {
      kv.get.mockImplementation((key: string) => {
        if (key === 'execution.real') return Promise.resolve('false');
        if (key === 'execution.broker_plugin_id') return Promise.resolve('alpaca-provider');
        return Promise.resolve(null);
      });
      prisma.tradeIntent.findUnique.mockResolvedValue(
        pendingIntent({ action: 'exit', symbol: 'AAPL' }),
      );
      mockAaplQuote(gateway);
      // Paper portfolio has a matching position — must NOT be used as a fallback when
      // the broker query is unreliable; existence cannot be determined → fail safe.
      prisma.portfolio.findUnique.mockResolvedValue({
        name: 'paper',
        data: JSON.stringify({
          equity: 11_400,
          cash: 10_000,
          positions: [{ symbol: 'AAPL', quantity: 10, avg_price: 140 }],
        }),
        updatedAt: new Date(),
      });
      gateway.getPortfolio.mockRejectedValue(new Error('Broker unreachable'));
      const failed = pendingIntent({
        status: 'failed',
        decided_by: 'autonomous',
        result_json: JSON.stringify({
          error: 'broker position unavailable — refusing to guess exit routing',
        }),
      });
      prisma.tradeIntent.update.mockResolvedValue(failed);

      const result = await service.autoProcess('ti_001');

      expect(gateway.placeOrder).not.toHaveBeenCalled();
      expect(prisma.portfolio.upsert).not.toHaveBeenCalled();
      expect(result.status).toBe('failed');
      expect(prisma.tradeIntent.update).toHaveBeenCalledWith(
        oc({ data: oc({ status: 'failed' }) }),
      );
    });

    it('(d) pure paper account (no broker_plugin_id ever) → exit behaves exactly as before, unchanged', async () => {
      kv.get.mockResolvedValue(null); // execution.real, broker_plugin_id all unset/default
      prisma.tradeIntent.findUnique.mockResolvedValue(
        pendingIntent({ action: 'exit', symbol: 'AAPL' }),
      );
      mockAaplQuote(gateway);
      prisma.portfolio.findUnique.mockResolvedValue({
        name: 'paper',
        data: JSON.stringify({
          equity: 11_400,
          cash: 10_000,
          positions: [{ symbol: 'AAPL', quantity: 10, avg_price: 140 }],
        }),
        updatedAt: new Date(),
      });
      prisma.portfolio.upsert.mockResolvedValue({
        name: 'paper',
        data: '{}',
        updatedAt: new Date(),
      });
      const executed = pendingIntent({
        status: 'executed',
        fill_price: 150,
        quantity: 10,
        realized_pnl: 100,
        decided_by: 'autonomous',
      });
      prisma.tradeIntent.update.mockResolvedValue(executed);

      const result = await service.autoProcess('ti_001');

      // No broker configured at all → no broker lookup attempted, paper path unchanged.
      expect(gateway.getPortfolio).not.toHaveBeenCalled();
      expect(gateway.placeOrder).not.toHaveBeenCalled();
      expect(result.status).toBe('executed');
      expect(result.realized_pnl).toBe(100);
      expect(prisma.portfolio.upsert).toHaveBeenCalled();
    });
  });

  // ── walk-forward gate before live trading (measurable-veto-shield) ───────────
  //
  // Real execution now requires, ON TOP of execution.real=true + broker_plugin_id, that
  // the CURRENTLY-APPLIED strategy (KV strategy.applied) carry a recent ROBUSTO
  // walk-forward verdict. Any failure DEMOTES real→paper — it never blocks the intent and
  // never touches the paper path.
  describe('walk-forward gate before live trading', () => {
    /** real=true + broker set, but the applied-strategy gate is configurable per test. */
    function enableRealNoGate(kvMock: MockKv, extra: Record<string, string> = {}) {
      kvMock.get.mockImplementation((key: string) => {
        if (key === 'execution.real') return Promise.resolve('true');
        if (key === 'execution.broker_plugin_id') return Promise.resolve('alpaca-provider');
        if (key === 'execution.max_order_notional') return Promise.resolve('100000');
        if (key in extra) return Promise.resolve(extra[key]);
        return Promise.resolve(null);
      });
    }

    it('applied strategy ROBUSTO + fresh timestamp → effective mode real, real order placed', async () => {
      enableRealNoGate(kv, { 'strategy.applied': 's_live' });
      mockRobustAppliedStrategy(prisma, 'ROBUSTO', new Date());
      mockRealAccountState(prisma);
      prisma.tradeIntent.findUnique.mockResolvedValue(
        pendingIntent({ action: 'long', symbol: 'AAPL' }),
      );
      mockPaperPortfolio(prisma);
      mockAaplQuote(gateway);
      realOrderService.submit.mockResolvedValue({
        id: 'ro1',
        status: 'submitted',
        client_order_id: 'nt-ti_001-o1',
        broker_order_id: 'o1',
        error: null,
      });
      prisma.tradeIntent.update.mockResolvedValue(
        pendingIntent({
          status: 'real_pending',
          fill_price: null,
          quantity: null,
          decided_by: 'autonomous',
        }),
      );

      const result = await service.autoProcess('ti_001');

      expect(realOrderService.submit).toHaveBeenCalledWith(oc({ side: 'buy' }));
      expect(gateway.placeOrder).not.toHaveBeenCalled();
      expect(result.status).toBe('real_pending');
      expect(prisma.portfolio.upsert).not.toHaveBeenCalled(); // real path, not paper
    });

    it.each([
      ['SOBREAJUSTADO', 'SOBREAJUSTADO'],
      ['INSUFICIENTE_DATOS', 'INSUFICIENTE_DATOS'],
      ['null verdict', null],
    ])(
      'verdict %s → demoted to paper, NO real order, demotion audited',
      async (_label, verdict) => {
        const audit = makeAudit();
        service = makeService(prisma, gateway, kv, realOrderService, audit);
        enableRealNoGate(kv, { 'strategy.applied': 's_live' });
        mockRobustAppliedStrategy(prisma, verdict, new Date());
        prisma.tradeIntent.findUnique.mockResolvedValue(
          pendingIntent({ action: 'long', symbol: 'AAPL' }),
        );
        mockPaperPortfolio(prisma);
        mockAaplQuote(gateway);
        prisma.portfolio.upsert.mockResolvedValue({
          name: 'paper',
          data: '{}',
          updatedAt: new Date(),
        });
        prisma.tradeIntent.update.mockResolvedValue(
          pendingIntent({ status: 'executed', decided_by: 'autonomous' }),
        );

        await service.autoProcess('ti_001');

        expect(gateway.placeOrder).not.toHaveBeenCalled(); // demoted → no real order
        expect(prisma.portfolio.upsert).toHaveBeenCalled(); // paper path ran
        expect(audit.log).toHaveBeenCalledWith(oc({ event_type: 'walk_forward_gate_demotion' }));
      },
    );

    it('ROBUSTO but walk_forward_checked_at older than max_age_days → demoted to paper', async () => {
      // default max age = 30 days; make it 40 days old.
      const stale = new Date(Date.now() - 40 * 86_400_000);
      enableRealNoGate(kv, { 'strategy.applied': 's_live' });
      mockRobustAppliedStrategy(prisma, 'ROBUSTO', stale);
      prisma.tradeIntent.findUnique.mockResolvedValue(
        pendingIntent({ action: 'long', symbol: 'AAPL' }),
      );
      mockPaperPortfolio(prisma);
      mockAaplQuote(gateway);
      prisma.portfolio.upsert.mockResolvedValue({
        name: 'paper',
        data: '{}',
        updatedAt: new Date(),
      });
      prisma.tradeIntent.update.mockResolvedValue(
        pendingIntent({ status: 'executed', decided_by: 'autonomous' }),
      );

      await service.autoProcess('ti_001');

      expect(gateway.placeOrder).not.toHaveBeenCalled();
      expect(prisma.portfolio.upsert).toHaveBeenCalled();
    });

    it('configurable max_age_days: a 40-day-old ROBUSTO verdict passes when window is 60 days', async () => {
      const aged = new Date(Date.now() - 40 * 86_400_000);
      enableRealNoGate(kv, {
        'strategy.applied': 's_live',
        'execution.walk_forward_max_age_days': '60',
      });
      mockRobustAppliedStrategy(prisma, 'ROBUSTO', aged);
      mockRealAccountState(prisma);
      prisma.tradeIntent.findUnique.mockResolvedValue(
        pendingIntent({ action: 'long', symbol: 'AAPL' }),
      );
      mockPaperPortfolio(prisma);
      mockAaplQuote(gateway);
      realOrderService.submit.mockResolvedValue({
        id: 'ro2',
        status: 'submitted',
        client_order_id: 'nt-ti_001-o2',
        broker_order_id: 'o2',
        error: null,
      });
      prisma.tradeIntent.update.mockResolvedValue(
        pendingIntent({
          status: 'real_pending',
          fill_price: null,
          quantity: null,
          decided_by: 'autonomous',
        }),
      );

      await service.autoProcess('ti_001');

      expect(realOrderService.submit).toHaveBeenCalled();
      expect(gateway.placeOrder).not.toHaveBeenCalled();
    });

    it('no strategy.applied in KV → demoted to paper (never real)', async () => {
      enableRealNoGate(kv); // strategy.applied unset
      prisma.tradeIntent.findUnique.mockResolvedValue(
        pendingIntent({ action: 'long', symbol: 'AAPL' }),
      );
      mockPaperPortfolio(prisma);
      mockAaplQuote(gateway);
      prisma.portfolio.upsert.mockResolvedValue({
        name: 'paper',
        data: '{}',
        updatedAt: new Date(),
      });
      prisma.tradeIntent.update.mockResolvedValue(
        pendingIntent({ status: 'executed', decided_by: 'autonomous' }),
      );

      await service.autoProcess('ti_001');

      expect(gateway.placeOrder).not.toHaveBeenCalled();
      expect(prisma.portfolio.upsert).toHaveBeenCalled();
    });

    it('strategy.applied set but no matching Strategy row → demoted to paper', async () => {
      enableRealNoGate(kv, { 'strategy.applied': 'ghost' });
      prisma.strategy.findUnique.mockResolvedValue(null); // row missing
      prisma.tradeIntent.findUnique.mockResolvedValue(
        pendingIntent({ action: 'long', symbol: 'AAPL' }),
      );
      mockPaperPortfolio(prisma);
      mockAaplQuote(gateway);
      prisma.portfolio.upsert.mockResolvedValue({
        name: 'paper',
        data: '{}',
        updatedAt: new Date(),
      });
      prisma.tradeIntent.update.mockResolvedValue(
        pendingIntent({ status: 'executed', decided_by: 'autonomous' }),
      );

      await service.autoProcess('ti_001');

      expect(gateway.placeOrder).not.toHaveBeenCalled();
      expect(prisma.portfolio.upsert).toHaveBeenCalled();
    });

    it('gate never throws even if the Strategy lookup rejects → demoted to paper', async () => {
      enableRealNoGate(kv, { 'strategy.applied': 's_live' });
      prisma.strategy.findUnique.mockRejectedValue(new Error('db down'));
      prisma.tradeIntent.findUnique.mockResolvedValue(
        pendingIntent({ action: 'long', symbol: 'AAPL' }),
      );
      mockPaperPortfolio(prisma);
      mockAaplQuote(gateway);
      prisma.portfolio.upsert.mockResolvedValue({
        name: 'paper',
        data: '{}',
        updatedAt: new Date(),
      });
      prisma.tradeIntent.update.mockResolvedValue(
        pendingIntent({ status: 'executed', decided_by: 'autonomous' }),
      );

      const result = await service.autoProcess('ti_001'); // must not throw

      expect(result.status).toBe('executed');
      expect(gateway.placeOrder).not.toHaveBeenCalled();
      expect(prisma.portfolio.upsert).toHaveBeenCalled();
    });

    it('approve() path is gated too: verdict SOBREAJUSTADO demotes a human-approved real order to paper', async () => {
      enableRealNoGate(kv, { 'strategy.applied': 's_live' });
      mockRobustAppliedStrategy(prisma, 'SOBREAJUSTADO', new Date());
      prisma.tradeIntent.findUnique.mockResolvedValue(
        pendingIntent({ action: 'long', symbol: 'AAPL' }),
      );
      mockPaperPortfolio(prisma);
      mockAaplQuote(gateway);
      prisma.portfolio.upsert.mockResolvedValue({
        name: 'paper',
        data: '{}',
        updatedAt: new Date(),
      });
      prisma.tradeIntent.update.mockResolvedValue(
        pendingIntent({ status: 'executed', decided_by: 'alice' }),
      );

      await service.approve('ti_001', 'alice');

      expect(gateway.placeOrder).not.toHaveBeenCalled();
      expect(prisma.portfolio.upsert).toHaveBeenCalled();
    });

    it('paper path is untouched by the gate: policy.real=false never reads the applied strategy', async () => {
      kv.get.mockResolvedValue(null); // real=false → paper
      prisma.tradeIntent.findUnique.mockResolvedValue(
        pendingIntent({ action: 'long', symbol: 'AAPL' }),
      );
      mockPaperPortfolio(prisma);
      mockAaplQuote(gateway);
      prisma.portfolio.upsert.mockResolvedValue({
        name: 'paper',
        data: '{}',
        updatedAt: new Date(),
      });
      prisma.tradeIntent.update.mockResolvedValue(
        pendingIntent({ status: 'executed', decided_by: 'autonomous' }),
      );

      await service.autoProcess('ti_001');

      // Gate short-circuits: real=false means the applied-strategy row is never queried.
      expect(prisma.strategy.findUnique).not.toHaveBeenCalled();
      expect(gateway.placeOrder).not.toHaveBeenCalled();
      expect(prisma.portfolio.upsert).toHaveBeenCalled();
    });

    // ── exit/hold must NEVER be gated by walk-forward (closing reduces risk) ──────

    it('real exit with MISSING walk-forward verdict (no strategy.applied) still executes as real — never demoted, never falsely marked executed via the paper zero-qty path', async () => {
      const audit = makeAudit();
      service = makeService(prisma, gateway, kv, realOrderService, audit);
      enableRealNoGate(kv); // strategy.applied unset → gate would fail if it were checked
      prisma.tradeIntent.findUnique.mockResolvedValue(
        pendingIntent({ action: 'exit', symbol: 'AAPL' }),
      );
      // Paper portfolio is unrelated for a real exit — deliberately holds NO position for
      // AAPL, so if the bug were present (demoted to paper) this would resolve qty=0 and
      // be falsely marked executed instead of reaching the broker.
      mockPaperPortfolio(prisma);
      gateway.getPortfolio.mockResolvedValue({
        provider_id: 'alpaca-provider',
        equity: 11_400,
        cash: 10_000,
        buying_power: 10_000,
        positions: [
          {
            symbol: 'AAPL',
            qty: 10,
            avg_entry: 140,
            market_value: 1500,
            unrealized_pnl: 100,
            side: 'long',
          },
        ],
        total_market_value: 1500,
        total_pnl: 100,
        ts: new Date().toISOString(),
      });
      mockAaplQuote(gateway);
      realOrderService.submit.mockResolvedValue({
        id: 'ro_missing_gate',
        status: 'submitted',
        client_order_id: 'nt-ti_001-missing-gate',
        broker_order_id: 'order_exit_missing_gate',
        error: null,
      });
      const pending = pendingIntent({
        status: 'real_pending',
        fill_price: null,
        quantity: null,
        decided_by: 'autonomous',
      });
      prisma.tradeIntent.update.mockResolvedValue(pending);

      const result = await service.autoProcess('ti_001');

      expect(realOrderService.submit).toHaveBeenCalledWith(
        oc({ symbol: 'AAPL', requestedQty: 10, side: 'sell' }),
      );
      expect(gateway.placeOrder).not.toHaveBeenCalled();
      expect(result.status).toBe('real_pending');
      expect(prisma.portfolio.upsert).not.toHaveBeenCalled(); // never routed to paper
      expect(audit.log).not.toHaveBeenCalledWith(oc({ event_type: 'walk_forward_gate_demotion' }));
    });

    it('real exit with STALE walk-forward verdict still executes as real — the defensive re-check in _executeReal must not block it either', async () => {
      const audit = makeAudit();
      service = makeService(prisma, gateway, kv, realOrderService, audit);
      const stale = new Date(Date.now() - 40 * 86_400_000); // default window is 30 days
      enableRealNoGate(kv, { 'strategy.applied': 's_live' });
      mockRobustAppliedStrategy(prisma, 'ROBUSTO', stale);
      prisma.tradeIntent.findUnique.mockResolvedValue(
        pendingIntent({ action: 'exit', symbol: 'AAPL' }),
      );
      mockPaperPortfolio(prisma);
      gateway.getPortfolio.mockResolvedValue({
        provider_id: 'alpaca-provider',
        equity: 11_400,
        cash: 10_000,
        buying_power: 10_000,
        positions: [
          {
            symbol: 'AAPL',
            qty: 10,
            avg_entry: 140,
            market_value: 1500,
            unrealized_pnl: 100,
            side: 'long',
          },
        ],
        total_market_value: 1500,
        total_pnl: 100,
        ts: new Date().toISOString(),
      });
      mockAaplQuote(gateway);
      realOrderService.submit.mockResolvedValue({
        id: 'ro_stale_gate',
        status: 'submitted',
        client_order_id: 'nt-ti_001-stale-gate',
        broker_order_id: 'order_exit_stale_gate',
        error: null,
      });
      const pending = pendingIntent({
        status: 'real_pending',
        fill_price: null,
        quantity: null,
        decided_by: 'autonomous',
      });
      prisma.tradeIntent.update.mockResolvedValue(pending);

      const result = await service.autoProcess('ti_001');

      expect(realOrderService.submit).toHaveBeenCalledWith(
        oc({ symbol: 'AAPL', requestedQty: 10, side: 'sell' }),
      );
      expect(gateway.placeOrder).not.toHaveBeenCalled();
      expect(result.status).toBe('real_pending');
      expect(prisma.portfolio.upsert).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalledWith(oc({ event_type: 'walk_forward_gate_demotion' }));
    });

    it('policy.real=false + exit on an existing paper position → paper path unchanged, no walk-forward machinery touched', async () => {
      kv.get.mockResolvedValue(null); // real=false → paper, always
      prisma.tradeIntent.findUnique.mockResolvedValue(
        pendingIntent({ action: 'exit', symbol: 'AAPL' }),
      );
      prisma.portfolio.findUnique.mockResolvedValue({
        name: 'paper',
        data: JSON.stringify({
          equity: 11_500,
          cash: 10_000,
          positions: [{ symbol: 'AAPL', quantity: 10, avg_price: 140 }],
        }),
        updatedAt: new Date(),
      });
      mockAaplQuote(gateway);
      prisma.portfolio.upsert.mockResolvedValue({
        name: 'paper',
        data: '{}',
        updatedAt: new Date(),
      });
      prisma.tradeIntent.update.mockResolvedValue(
        pendingIntent({ status: 'executed', quantity: 10, decided_by: 'autonomous' }),
      );

      const result = await service.autoProcess('ti_001');

      expect(prisma.strategy.findUnique).not.toHaveBeenCalled();
      expect(gateway.placeOrder).not.toHaveBeenCalled();
      expect(gateway.getPortfolio).not.toHaveBeenCalled();
      expect(prisma.portfolio.upsert).toHaveBeenCalled();
      expect(result.status).toBe('executed');
    });

    it('real hold with a stale/missing walk-forward gate never triggers a demotion audit (hold never touches broker/paper state, so it must not depend on gate freshness)', async () => {
      const audit = makeAudit();
      service = makeService(prisma, gateway, kv, realOrderService, audit);
      enableRealNoGate(kv); // strategy.applied unset → gate would fail if checked
      prisma.tradeIntent.findUnique.mockResolvedValue(
        pendingIntent({ action: 'hold', symbol: 'AAPL' }),
      );
      const executed = pendingIntent({ status: 'executed', quantity: 0, decided_by: 'autonomous' });
      prisma.tradeIntent.update.mockResolvedValue(executed);

      const result = await service.autoProcess('ti_001');

      expect(result.status).toBe('executed');
      expect(gateway.placeOrder).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalledWith(oc({ event_type: 'walk_forward_gate_demotion' }));
    });
  });

  // ── fresh-install safety (zero KV rows, zero plugins) ───────────────────────

  describe('fresh-install safety (DEFAULT_EXECUTION_POLICY only, no KV rows)', () => {
    it('drawdown halt is active on autoProcess AND approve() using literal defaults alone', async () => {
      kv.get.mockResolvedValue(null); // every KV key null → DEFAULT_EXECUTION_POLICY literals in effect
      // hwm=10_000, current equity=7_000 → drawdown=30% >= default max_drawdown_halt_pct=25%.
      const portfolioAtDrawdown = JSON.stringify({
        equity: 7_000,
        cash: 7_000,
        positions: [],
        hwm: 10_000,
      });

      // autoProcess path
      prisma.tradeIntent.findUnique.mockResolvedValue(pendingIntent({ action: 'long' }));
      prisma.portfolio.findUnique.mockResolvedValue({
        name: 'paper',
        data: portfolioAtDrawdown,
        updatedAt: new Date(),
      });
      prisma.tradeIntent.update.mockResolvedValue(
        pendingIntent({ status: 'rejected', decided_by: 'autonomous' }),
      );
      const autoResult = await service.autoProcess('ti_001');
      expect(autoResult.status).toBe('rejected');
      expect(gateway.getQuote).not.toHaveBeenCalled();

      // approve() path (human) — same defaults, same halt
      prisma.tradeIntent.update.mockResolvedValue(
        pendingIntent({ status: 'rejected', decided_by: 'alice' }),
      );
      const approveResult = await service.approve('ti_001', 'alice');
      expect(approveResult.status).toBe('rejected');
      expect(gateway.getQuote).not.toHaveBeenCalled();
    });

    it('default max_position_pct=0.1 ceiling structurally bounds executed qty on both paths', async () => {
      kv.get.mockResolvedValue(null); // every KV key null → DEFAULT_EXECUTION_POLICY literals in effect

      // autoProcess: sizingPct == policy.max_position_pct == 0.1 → qty is exactly at the ceiling.
      prisma.tradeIntent.findUnique.mockResolvedValue(
        pendingIntent({ action: 'long', symbol: 'AAPL' }),
      );
      mockPaperPortfolio(prisma); // equity=10_000, cash=10_000
      mockAaplQuote(gateway); // price=150
      prisma.portfolio.upsert.mockResolvedValue({
        name: 'paper',
        data: '{}',
        updatedAt: new Date(),
      });
      prisma.tradeIntent.update.mockImplementation(
        (args: { data: { quantity?: number } }) =>
          Promise.resolve(pendingIntent({ status: 'executed', ...args.data })) as unknown,
      );

      const autoResult = (await service.autoProcess('ti_001')) as { quantity: number };
      const ceilingQty = Math.floor((10_000 * 0.1) / 150);
      expect(autoResult.quantity).toBeLessThanOrEqual(ceilingQty);

      // approve(): human path with a fresh pending intent — hardcoded SIZING_PCT=0.05 stays
      // under the default 0.1 ceiling by construction; qty must still respect the ceiling.
      prisma.tradeIntent.findUnique.mockResolvedValue(
        pendingIntent({ action: 'long', symbol: 'AAPL' }),
      );
      const approveResult = (await service.approve('ti_001', 'alice')) as { quantity: number };
      expect(approveResult.quantity).toBeLessThanOrEqual(ceilingQty);
    });
  });
});

// ── Execution policy (operator config) ─────────────────────────────────────────
describe('TradeIntentService policy config', () => {
  it('setPolicy writes only the provided KV keys and returns the resulting policy', async () => {
    const prisma = makePrisma();
    const gateway = makeGateway();
    const kv = makeKv();
    // After writes, getPolicy re-reads: make get return the "new" values.
    kv.get.mockImplementation((k: string) =>
      Promise.resolve(
        {
          'execution.real': 'true',
          'execution.broker_plugin_id': 'alpaca-provider',
          'execution.max_order_notional': '500',
        }[k] ?? null,
      ),
    );
    const service = makeService(prisma, gateway, kv);

    const policy = await service.setPolicy({
      real: true,
      broker_plugin_id: 'alpaca-provider',
      max_order_notional: 500,
    });

    expect(kv.set).toHaveBeenCalledWith('execution.real', 'true');
    expect(kv.set).toHaveBeenCalledWith('execution.broker_plugin_id', 'alpaca-provider');
    expect(kv.set).toHaveBeenCalledWith('execution.max_order_notional', '500');
    // untouched key not written
    expect(kv.set).not.toHaveBeenCalledWith('execution.autonomous', expect.anything());
    expect(policy.real).toBe(true);
    expect(policy.broker_plugin_id).toBe('alpaca-provider');
    expect(policy.max_order_notional).toBe(500);
  });

  it('getPolicy returns defaults when no KV keys are set (autonomous paper)', async () => {
    const prisma = makePrisma();
    const gateway = makeGateway();
    const kv = makeKv();
    kv.get.mockResolvedValue(null);
    const service = makeService(prisma, gateway, kv);

    const policy = await service.getPolicy();
    expect(policy.autonomous).toBe(true);
    expect(policy.real).toBe(false);
    expect(policy.broker_plugin_id).toBe('');
  });
});

describe('TradeIntentService real-execution kill-switch operator methods', () => {
  it('getRealExecutionHaltStatus reflects the persisted KV state', async () => {
    const prisma = makePrisma();
    const gateway = makeGateway();
    const kv = makeKv();
    kv.get.mockImplementation((k: string) =>
      Promise.resolve(
        {
          'real_execution.halted': 'true',
          'real_execution.halt_reason': 'broker position drift detected',
        }[k] ?? null,
      ),
    );
    const service = makeService(prisma, gateway, kv);

    const status = await service.getRealExecutionHaltStatus();

    expect(status).toEqual({ halted: true, reason: 'broker position drift detected' });
  });

  it('clearRealExecutionHalt writes halted=false and deletes the reason key, then returns the cleared status', async () => {
    const prisma = makePrisma();
    const gateway = makeGateway();
    const kv = makeKv();
    kv.get.mockResolvedValue(null); // after clearing, both keys read back as unset
    const service = makeService(prisma, gateway, kv);

    const status = await service.clearRealExecutionHalt();

    expect(kv.set).toHaveBeenCalledWith('real_execution.halted', 'false');
    expect(kv.delete).toHaveBeenCalledWith('real_execution.halt_reason');
    expect(status).toEqual({ halted: false, reason: null });
  });
});
