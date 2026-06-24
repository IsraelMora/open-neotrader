/**
 * trade-intent.service.spec.ts — TDD RED → GREEN
 *
 * PAPER trade-execution layer with human-in-the-loop (HITL) and autonomous execution.
 * All tests use MOCKED PrismaService + MOCKED ProviderGatewayService + MOCKED KvService — no real DB/network.
 *
 * Real-money execution is intentionally NOT wired. Any mode != "paper" must throw.
 */

import { TradeIntentService } from './trade-intent.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { ProviderGatewayService } from '../providers/provider-gateway.service';

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
  };
}

type MockGateway = { getQuote: jest.Mock };

function makeGateway(): MockGateway {
  return { getQuote: jest.fn() };
}

type MockKv = { get: jest.Mock };

function makeKv(): MockKv {
  return { get: jest.fn() };
}

function makeService(prisma: MockPrisma, gateway: MockGateway, kv: MockKv): TradeIntentService {
  return new (TradeIntentService as unknown as new (
    db: unknown,
    gw: unknown,
    kv: unknown,
  ) => TradeIntentService)(prisma, gateway, kv);
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

// ── Test suite ────────────────────────────────────────────────────────────────

describe('TradeIntentService', () => {
  let prisma: MockPrisma;
  let gateway: MockGateway;
  let kv: MockKv;
  let service: TradeIntentService;

  beforeEach(() => {
    prisma = makePrisma();
    gateway = makeGateway();
    kv = makeKv();
    // Default: all KV keys return null → autonomous=true by default.
    // Existing recordIntent tests that expect status=pending override this
    // per-test to return 'false' for execution.autonomous.
    kv.get.mockResolvedValue(null);
    service = makeService(prisma, gateway, kv);
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
        expect.objectContaining({
          data: expect.objectContaining({
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
        expect.objectContaining({
          data: expect.objectContaining({ cycle_id: 'cycle_abc', timeframe: '4h' }),
        }),
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

    it('rejects confidence below 0', async () => {
      await expect(
        service.recordIntent({
          symbol: 'AAPL',
          action: 'long',
          confidence: -0.1,
          rationale: 'test',
        }),
      ).rejects.toThrow(/confidence/i);
    });

    it('rejects confidence above 1', async () => {
      await expect(
        service.recordIntent({
          symbol: 'AAPL',
          action: 'long',
          confidence: 1.5,
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
        expect.objectContaining({ orderBy: { created_at: 'desc' } }),
      );
      expect(result).toHaveLength(2);
    });

    it('filters by status when provided', async () => {
      prisma.tradeIntent.findMany.mockResolvedValue([pendingIntent()]);

      await service.list('pending');

      expect(prisma.tradeIntent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: 'pending' } }),
      );
    });
  });

  describe('listPending', () => {
    it('returns only pending intents', async () => {
      const pending = [pendingIntent(), pendingIntent({ id: 'ti_002' })];
      prisma.tradeIntent.findMany.mockResolvedValue(pending);

      const result = await service.listPending();

      expect(prisma.tradeIntent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: 'pending' } }),
      );
      expect(result).toHaveLength(2);
    });
  });

  // ── approve ────────────────────────────────────────────────────────────────

  describe('approve', () => {
    it('throws when mode != "paper" (real-money execution disabled)', async () => {
      const intent = pendingIntent({ mode: 'live' });
      prisma.tradeIntent.findUnique.mockResolvedValue(intent);

      await expect(service.approve('ti_001', 'alice')).rejects.toThrow(
        /real-money execution is disabled/i,
      );
      // Must NOT execute any trade or update status
      expect(prisma.tradeIntent.update).not.toHaveBeenCalled();
    });

    it('throws when intent is not in pending status', async () => {
      const intent = pendingIntent({ status: 'executed' });
      prisma.tradeIntent.findUnique.mockResolvedValue(intent);

      await expect(service.approve('ti_001', 'alice')).rejects.toThrow(/not pending/i);
      expect(prisma.tradeIntent.update).not.toHaveBeenCalled();
    });

    it('executes a paper LONG: fetches quote, opens position, status=executed', async () => {
      const intent = pendingIntent(); // action=long, mode=paper
      prisma.tradeIntent.findUnique.mockResolvedValue(intent);
      prisma.portfolio.findUnique.mockResolvedValue({
        name: 'paper',
        data: EMPTY_PORTFOLIO_DATA,
        updatedAt: new Date(),
      });
      gateway.getQuote.mockResolvedValue({
        symbol: 'AAPL',
        bid: 149,
        ask: 151,
        last: 150,
        ts: new Date().toISOString(),
      });
      prisma.portfolio.upsert.mockResolvedValue({
        name: 'paper',
        data: '{}',
        updatedAt: new Date(),
      });

      const updated = pendingIntent({
        status: 'executed',
        fill_price: 150,
        decided_by: 'alice',
        decided_at: new Date(),
      });
      prisma.tradeIntent.update.mockResolvedValue(updated);

      const result = await service.approve('ti_001', 'alice');

      expect(gateway.getQuote).toHaveBeenCalledWith(null, 'AAPL');
      expect(prisma.tradeIntent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'ti_001' },
          data: expect.objectContaining({
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
      prisma.portfolio.findUnique.mockResolvedValue({
        name: 'paper',
        data: EMPTY_PORTFOLIO_DATA,
        updatedAt: new Date(),
      });
      gateway.getQuote.mockRejectedValue(new Error('Network timeout'));

      const failed = pendingIntent({ status: 'failed', result_json: '{"error":"Network timeout"}' });
      prisma.tradeIntent.update.mockResolvedValue(failed);

      // Must NOT throw
      const result = await service.approve('ti_001', 'alice');

      expect(prisma.tradeIntent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'failed' }),
        }),
      );
      expect(result.status).toBe('failed');
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
      gateway.getQuote.mockResolvedValue({
        symbol: 'AAPL',
        bid: 149,
        ask: 151,
        last: 150,
        ts: new Date().toISOString(),
      });
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
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'executed',
            realized_pnl: 100,
          }),
        }),
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
        expect.objectContaining({
          where: { id: 'ti_001' },
          data: expect.objectContaining({
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
      prisma.portfolio.findUnique.mockResolvedValue({
        name: 'paper',
        data: EMPTY_PORTFOLIO_DATA,
        updatedAt: new Date(),
      });
      gateway.getQuote.mockResolvedValue({ symbol: 'AAPL', bid: 149, ask: 151, last: 150, ts: new Date().toISOString() });
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
        expect.objectContaining({
          data: expect.objectContaining({ decided_by: 'autonomous' }),
        }),
      );
    });

    it('circuit breaker: drawdown >= max_drawdown_halt_pct → auto-rejected', async () => {
      kv.get.mockResolvedValue(null); // autonomous=true, max_drawdown_halt_pct=25 (default)

      const portfolioWithDrawdown = JSON.stringify({
        equity: 7_000,
        cash: 7_000,
        positions: [],
        max_drawdown_pct: 30, // >= 25 → triggers circuit breaker
      });

      prisma.tradeIntent.findUnique.mockResolvedValue(pendingIntent({ action: 'long' }));
      prisma.portfolio.findUnique.mockResolvedValue({
        name: 'paper',
        data: portfolioWithDrawdown,
        updatedAt: new Date(),
      });
      const rejected = pendingIntent({ status: 'rejected', decided_by: 'autonomous', reject_reason: 'circuit breaker: drawdown 30% >= 25%' });
      prisma.tradeIntent.update.mockResolvedValue(rejected);

      await service.autoProcess('ti_001');

      expect(gateway.getQuote).not.toHaveBeenCalled();
      expect(prisma.portfolio.upsert).not.toHaveBeenCalled();
      expect(prisma.tradeIntent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'rejected',
            decided_by: 'autonomous',
            reject_reason: expect.stringMatching(/circuit|drawdown/i),
          }),
        }),
      );
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
      prisma.portfolio.findUnique.mockResolvedValue({ name: 'paper', data: portfolioFull, updatedAt: new Date() });
      const rejected = pendingIntent({ status: 'rejected', decided_by: 'autonomous', reject_reason: 'max open positions reached' });
      prisma.tradeIntent.update.mockResolvedValue(rejected);

      await service.autoProcess('ti_001');

      expect(gateway.getQuote).not.toHaveBeenCalled();
      expect(prisma.tradeIntent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'rejected',
            decided_by: 'autonomous',
            reject_reason: expect.stringMatching(/max open positions|positions/i),
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

      prisma.tradeIntent.findUnique.mockResolvedValue(pendingIntent({ action: 'long', symbol: 'AAPL' }));
      prisma.portfolio.findUnique.mockResolvedValue({
        name: 'paper',
        data: EMPTY_PORTFOLIO_DATA, // equity=10000, cash=10000, positions=[]
        updatedAt: new Date(),
      });
      gateway.getQuote.mockResolvedValue({ symbol: 'AAPL', bid: 99, ask: 101, last: 100, ts: new Date().toISOString() });
      prisma.portfolio.upsert.mockResolvedValue({ name: 'paper', data: '{}' });
      const executedIntent = pendingIntent({ status: 'executed', quantity: 5, decided_by: 'autonomous' });
      prisma.tradeIntent.update.mockResolvedValue(executedIntent);

      await service.autoProcess('ti_001');

      // qty = floor(10000 * 0.05 / 100) = floor(5) = 5
      expect(prisma.tradeIntent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ quantity: 5 }),
        }),
      );
    });

    it('action "exit" auto-approved even at max positions and max drawdown', async () => {
      kv.get.mockResolvedValue(null); // autonomous=true, all defaults

      const positions = Array.from({ length: 10 }, (_, i) => ({
        symbol: i === 0 ? 'AAPL' : `SYM${i}`,
        quantity: 1,
        avg_price: 100,
      }));
      // drawdown=30% (>= 25 halt) AND 10 positions (>= 10 max)
      const portfolioFull = JSON.stringify({ equity: 7_000, cash: 6_000, positions, max_drawdown_pct: 30 });

      prisma.tradeIntent.findUnique.mockResolvedValue(pendingIntent({ action: 'exit', symbol: 'AAPL' }));
      prisma.portfolio.findUnique.mockResolvedValue({ name: 'paper', data: portfolioFull, updatedAt: new Date() });
      gateway.getQuote.mockResolvedValue({ symbol: 'AAPL', last: 110, bid: 109, ask: 111, ts: new Date().toISOString() });
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
      prisma.portfolio.findUnique.mockResolvedValue({
        name: 'paper',
        data: EMPTY_PORTFOLIO_DATA,
        updatedAt: new Date(),
      });
      const executedIntent = pendingIntent({ status: 'executed', quantity: 0, decided_by: 'autonomous' });
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

    it('mode!="paper" in autoProcess → throws', async () => {
      kv.get.mockResolvedValue(null);
      prisma.tradeIntent.findUnique.mockResolvedValue(pendingIntent({ mode: 'live' }));

      await expect(service.autoProcess('ti_001')).rejects.toThrow(/real-money execution is disabled/i);
    });

    it('getQuote failure during autoProcess → status=failed, no throw', async () => {
      kv.get.mockResolvedValue(null); // autonomous=true

      prisma.tradeIntent.findUnique.mockResolvedValue(pendingIntent({ action: 'long' }));
      prisma.portfolio.findUnique.mockResolvedValue({
        name: 'paper',
        data: EMPTY_PORTFOLIO_DATA,
        updatedAt: new Date(),
      });
      gateway.getQuote.mockRejectedValue(new Error('Network timeout'));
      const failedIntent = pendingIntent({ status: 'failed', decided_by: 'autonomous' });
      prisma.tradeIntent.update.mockResolvedValue(failedIntent);

      // Must NOT throw
      const result = await service.autoProcess('ti_001');

      expect(result.status).toBe('failed');
      expect(prisma.tradeIntent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'failed' }),
        }),
      );
      expect(prisma.portfolio.upsert).not.toHaveBeenCalled();
    });
  });
});
