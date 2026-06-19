/**
 * PretestService — Unit tests (Strict TDD, PR1: fills + MTM equity)
 *
 * All tests mock ProviderGatewayService so no network is hit.
 * Phase 1 spec: fills use getQuote(null,symbol).last; MTM equity uses real quote per position.
 */
import { PretestService, PretestState, PretestTrade } from './pretest.service';
import type { ProviderGatewayService, Quote } from '../providers/provider-gateway.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { SandboxGateway } from '../sandbox/sandbox.gateway';
import type { PluginsService } from '../plugins/plugins.service';
import type { LlmService } from '../llm/llm.service';
import type { ContextMemoryService } from '../context-memory/context-memory.service';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeQuote(symbol: string, last: number): Quote {
  return { symbol, last, bid: last - 0.01, ask: last + 0.01, ts: new Date().toISOString() };
}

function makeState(overrides: Partial<PretestState> = {}): PretestState {
  return {
    equity: 10_000,
    cash: 10_000,
    positions: [],
    trades: [],
    max_equity: 10_000,
    max_drawdown_pct: 0,
    realized_pnl: 0,
    win_trades: 0,
    loss_trades: 0,
    ...overrides,
  };
}

function makeToolCall(
  symbol: string,
  action: string,
  extraArgs: Record<string, unknown> = {},
): { plugin_id: string; function: string; args: Record<string, unknown> } {
  return { plugin_id: 'some-plugin', function: 'trade', args: { symbol, action, ...extraArgs } };
}

function makeGateway(
  getQuoteImpl: (pluginId: string | null, symbol: string) => Promise<Quote>,
): ProviderGatewayService {
  return { getQuote: jest.fn(getQuoteImpl) } as unknown as ProviderGatewayService;
}

/** Returns a gateway whose getQuote always rejects with the given message. */
function makeRejectingGateway(message: string): ProviderGatewayService {
  return {
    getQuote: jest.fn().mockRejectedValue(new Error(message)),
  } as unknown as ProviderGatewayService;
}

function makeService(gateway: ProviderGatewayService): PretestService {
  const db = {} as unknown as PrismaService;
  const sandbox = {} as unknown as SandboxGateway;
  const plugins = {} as unknown as PluginsService;
  const llm = {} as unknown as LlmService;
  const memory = {} as unknown as ContextMemoryService;
  return new PretestService(db, sandbox, plugins, llm, memory, gateway);
}

// ── Phase 1.1: RED tests — fills use getQuote.last ────────────────────────────

describe('PretestService._simulateFills (Phase 1)', () => {
  describe('1.1.1 — buy fill uses getQuote(null,symbol).last, NOT args.price', () => {
    it('records PretestTrade.price = quote.last regardless of args.price', async () => {
      const QUOTE_LAST = 150;
      const LLM_PRICE = 1; // fabricated by LLM — must be ignored
      const gateway = makeGateway((_pluginId, _symbol) =>
        Promise.resolve(makeQuote('AAPL', QUOTE_LAST)),
      );
      const svc = makeService(gateway);
      const state = makeState();

      const trades = await (
        svc as unknown as {
          _simulateFills: (tc: unknown[], s: PretestState) => Promise<PretestTrade[]>;
        }
      )._simulateFills([makeToolCall('AAPL', 'buy', { price: LLM_PRICE })], state);

      expect(trades).toHaveLength(1);
      expect(trades[0].price).toBe(QUOTE_LAST);
      expect(trades[0].price).not.toBe(LLM_PRICE);
    });
  });

  describe('1.1.2 — sell fill uses getQuote(null,symbol).last', () => {
    it('records sell trade at quote.last', async () => {
      const QUOTE_LAST = 200;
      const gateway = makeGateway((_pluginId, _symbol) =>
        Promise.resolve(makeQuote('TSLA', QUOTE_LAST)),
      );
      const svc = makeService(gateway);
      const state = makeState({
        positions: [{ symbol: 'TSLA', quantity: 5, avg_price: 180 }],
        cash: 5_000,
      });

      const trades = await (
        svc as unknown as {
          _simulateFills: (tc: unknown[], s: PretestState) => Promise<PretestTrade[]>;
        }
      )._simulateFills([makeToolCall('TSLA', 'sell')], state);

      expect(trades).toHaveLength(1);
      expect(trades[0].price).toBe(QUOTE_LAST);
      expect(trades[0].action).toBe('sell');
    });
  });

  describe('1.1.3 — getQuote rejection causes fill skip, no throw', () => {
    it('does not record a trade and does not propagate exception when getQuote rejects', async () => {
      const gateway = makeRejectingGateway('feed down');
      const svc = makeService(gateway);
      const state = makeState();

      const trades = await (
        svc as unknown as {
          _simulateFills: (tc: unknown[], s: PretestState) => Promise<PretestTrade[]>;
        }
      )._simulateFills([makeToolCall('ETH', 'buy')], state);

      expect(trades).toHaveLength(0);
    });
  });
});

// ── Phase 1.1.4-5: RED tests — _updateEquityMetrics uses MTM quotes ───────────

describe('PretestService._updateEquityMetrics (Phase 1)', () => {
  describe('1.1.4 — MTM equity = cash + sum(current_price * qty), not cost basis', () => {
    it('sets current_price, unrealized_pnl, and state.equity from market quote', async () => {
      const MARKET_PRICE = 80; // below avg_price — unrealized loss
      const AVG_PRICE = 100;
      const QTY = 10;

      const gateway = makeGateway((_pluginId, _symbol) =>
        Promise.resolve(makeQuote('AAPL', MARKET_PRICE)),
      );
      const svc = makeService(gateway);
      const state = makeState({
        cash: 5_000,
        positions: [{ symbol: 'AAPL', quantity: QTY, avg_price: AVG_PRICE }],
      });

      await (
        svc as unknown as { _updateEquityMetrics: (s: PretestState) => Promise<void> }
      )._updateEquityMetrics(state);

      // current_price updated to market value
      expect(state.positions[0].current_price).toBe(MARKET_PRICE);
      // unrealized_pnl = (market - avg) * qty = (80-100)*10 = -200
      expect(state.positions[0].unrealized_pnl).toBeCloseTo(-200);
      // equity = cash + market_value = 5000 + 80*10 = 5800 (NOT 5000 + 100*10 = 6000)
      expect(state.equity).toBeCloseTo(5_800);
    });

    it('sets positive unrealized_pnl when market is above avg_price', async () => {
      const gateway = makeGateway((_pluginId, _symbol) => Promise.resolve(makeQuote('MSFT', 140)));
      const svc = makeService(gateway);
      const state = makeState({
        cash: 3_000,
        positions: [{ symbol: 'MSFT', quantity: 5, avg_price: 100 }],
      });

      await (
        svc as unknown as { _updateEquityMetrics: (s: PretestState) => Promise<void> }
      )._updateEquityMetrics(state);

      expect(state.positions[0].current_price).toBe(140);
      expect(state.positions[0].unrealized_pnl).toBeCloseTo(200); // (140-100)*5
      expect(state.equity).toBeCloseTo(3_700); // 3000 + 140*5
    });

    it('recomputes max_drawdown_pct when MTM equity drops below max_equity', async () => {
      const gateway = makeGateway((_pluginId, _symbol) => Promise.resolve(makeQuote('SPY', 80)));
      const svc = makeService(gateway);
      const state = makeState({
        cash: 0,
        positions: [{ symbol: 'SPY', quantity: 10, avg_price: 100 }],
        max_equity: 1_000, // peak was 1000
      });

      await (
        svc as unknown as { _updateEquityMetrics: (s: PretestState) => Promise<void> }
      )._updateEquityMetrics(state);

      // equity = 0 + 80*10 = 800; dd = (1000-800)/1000*100 = 20%
      expect(state.max_drawdown_pct).toBeCloseTo(20);
    });
  });

  describe('1.1.5 — MTM getQuote rejection falls back without throwing', () => {
    it('falls back to last known current_price when getQuote rejects mid-MTM', async () => {
      const gateway = makeRejectingGateway('feed error');
      const svc = makeService(gateway);
      const state = makeState({
        cash: 4_000,
        positions: [{ symbol: 'AAPL', quantity: 10, avg_price: 100, current_price: 95 }],
      });

      await expect(
        (
          svc as unknown as { _updateEquityMetrics: (s: PretestState) => Promise<void> }
        )._updateEquityMetrics(state),
      ).resolves.not.toThrow();

      // Fallback to last-known current_price = 95
      expect(state.positions[0].current_price).toBe(95);
      expect(state.equity).toBeCloseTo(4_000 + 95 * 10); // 4950
    });

    it('falls back to avg_price when no current_price is set and getQuote rejects', async () => {
      const gateway = makeRejectingGateway('feed error');
      const svc = makeService(gateway);
      const state = makeState({
        cash: 2_000,
        positions: [{ symbol: 'BTC', quantity: 1, avg_price: 30_000 }],
        // no current_price set
      });

      await expect(
        (
          svc as unknown as { _updateEquityMetrics: (s: PretestState) => Promise<void> }
        )._updateEquityMetrics(state),
      ).resolves.not.toThrow();

      // Fallback to avg_price = 30000
      expect(state.positions[0].current_price).toBe(30_000);
      expect(state.equity).toBeCloseTo(2_000 + 30_000 * 1); // 32000
    });
  });
});

// ── Phase 1.1.6: Updated existing tests that previously asserted cost-basis equity ──

/**
 * These tests replace any old cost-basis assertions.
 * MTM semantics: equity = cash + Σ(current_price * qty) from getQuote,
 * not Σ(avg_price * qty).
 */
describe('PretestService — cost-basis tests updated for MTM (spec backward-compat)', () => {
  it('equity after buy reflects MTM value at market price, not purchase price', async () => {
    const MARKET_PRICE = 110; // quote.last after buying at 100
    const gateway = makeGateway(() => Promise.resolve(makeQuote('AAPL', MARKET_PRICE)));
    const svc = makeService(gateway);

    const initialState = makeState({ cash: 10_000 });
    const buyTrade: PretestTrade = {
      ts: new Date().toISOString(),
      symbol: 'AAPL',
      action: 'buy',
      price: 100, // fill price (from getQuote at fill time = 100 in this scenario)
      quantity: 10, // 10_000 * 0.05 / 100 = 5? Let's use explicit trade here
    };

    // Apply trade sync, then update MTM async
    const stateAfterTrade = (
      svc as unknown as {
        _applyTrades: (s: PretestState, trades: PretestTrade[]) => PretestState;
      }
    )._applyTrades(initialState, [buyTrade]);

    // At this point _applyTrades calls _updateEquityMetrics synchronously in old code,
    // but after refactor it must be awaited. In the new async model we call it separately:
    await (
      svc as unknown as { _updateEquityMetrics: (s: PretestState) => Promise<void> }
    )._updateEquityMetrics(stateAfterTrade);

    // After buy: cash = 10000 - 100*10 = 9000; MTM equity = 9000 + 110*10 = 10100
    // NOT cost-basis equity = 9000 + 100*10 = 10000
    expect(stateAfterTrade.positions[0].current_price).toBe(MARKET_PRICE);
    expect(stateAfterTrade.equity).toBeCloseTo(9_000 + MARKET_PRICE * 10);
  });
});
