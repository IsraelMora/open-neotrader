/**
 * trade-intent.service.spec.ts — TDD RED → GREEN
 *
 * PAPER trade-execution layer with human-in-the-loop (HITL).
 * All tests use MOCKED PrismaService + MOCKED ProviderGatewayService — no real DB/network.
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

function makeService(prisma: MockPrisma, gateway: MockGateway): TradeIntentService {
  return new (TradeIntentService as unknown as new (
    db: unknown,
    gw: unknown,
  ) => TradeIntentService)(prisma, gateway);
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
  let service: TradeIntentService;

  beforeEach(() => {
    prisma = makePrisma();
    gateway = makeGateway();
    service = makeService(prisma, gateway);
  });

  // ── recordIntent ────────────────────────────────────────────────────────────

  describe('recordIntent', () => {
    it('creates a pending TradeIntent with default mode=paper', async () => {
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
});
