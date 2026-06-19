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
import type { AgentsService } from '../agents/agents.service';

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
): jest.Mocked<Pick<ProviderGatewayService, 'getQuote'>> & ProviderGatewayService {
  return { getQuote: jest.fn(getQuoteImpl) } as unknown as jest.Mocked<
    Pick<ProviderGatewayService, 'getQuote'>
  > &
    ProviderGatewayService;
}

/** Returns a gateway whose getQuote always rejects with the given message. */
function makeRejectingGateway(
  message: string,
): jest.Mocked<Pick<ProviderGatewayService, 'getQuote'>> & ProviderGatewayService {
  return {
    getQuote: jest.fn().mockRejectedValue(new Error(message)),
  } as unknown as jest.Mocked<Pick<ProviderGatewayService, 'getQuote'>> & ProviderGatewayService;
}

function makeService(gateway: ProviderGatewayService, agents?: AgentsService): PretestService {
  const db = {} as unknown as PrismaService;
  const sandbox = {} as unknown as SandboxGateway;
  const plugins = {} as unknown as PluginsService;
  const llm = {} as unknown as LlmService;
  const memory = {} as unknown as ContextMemoryService;
  return new PretestService(db, sandbox, plugins, llm, memory, gateway, agents);
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

// ── Fix 1: Zero-quote guard in _updateEquityMetrics ──────────────────────────
//
// When getQuote RESOLVES (not rejects) with last === 0, the try/catch does NOT
// fire, so marketPrice would be 0, collapsing equity. The fix must treat
// quote.last <= 0 the same as a rejection: route into the existing fallback
// (current_price ?? avg_price) with a warning.

describe('PretestService._updateEquityMetrics — zero-quote guard (fix 1)', () => {
  describe('fix1.1 — getQuote resolves with last=0: fallback to current_price', () => {
    it('uses last-known current_price when quote.last is 0, equity does not collapse', async () => {
      const gateway = makeGateway((_pluginId, _symbol) => Promise.resolve(makeQuote('AAPL', 0)));
      const svc = makeService(gateway);
      const LAST_KNOWN = 95;
      const AVG = 100;
      const QTY = 10;
      const CASH = 5_000;
      const state = makeState({
        cash: CASH,
        positions: [{ symbol: 'AAPL', quantity: QTY, avg_price: AVG, current_price: LAST_KNOWN }],
      });

      await (
        svc as unknown as { _updateEquityMetrics: (s: PretestState) => Promise<void> }
      )._updateEquityMetrics(state);

      // Must NOT use 0 as price — must fall back to current_price = 95
      expect(state.positions[0].current_price).toBe(LAST_KNOWN);
      // equity = 5000 + 95*10 = 5950 (not 5000 + 0*10 = 5000)
      expect(state.equity).toBeCloseTo(CASH + LAST_KNOWN * QTY);
    });
  });

  describe('fix1.2 — getQuote resolves with last=0: fallback to avg_price when no current_price', () => {
    it('uses avg_price when quote.last is 0 and no current_price is set', async () => {
      const gateway = makeGateway((_pluginId, _symbol) => Promise.resolve(makeQuote('TSLA', 0)));
      const svc = makeService(gateway);
      const AVG = 200;
      const QTY = 5;
      const CASH = 2_000;
      const state = makeState({
        cash: CASH,
        positions: [{ symbol: 'TSLA', quantity: QTY, avg_price: AVG }],
      });

      await (
        svc as unknown as { _updateEquityMetrics: (s: PretestState) => Promise<void> }
      )._updateEquityMetrics(state);

      // Must fall back to avg_price = 200
      expect(state.positions[0].current_price).toBe(AVG);
      // equity = 2000 + 200*5 = 3000 (not 2000)
      expect(state.equity).toBeCloseTo(CASH + AVG * QTY);
    });
  });

  describe('fix1.3 — getQuote called with (null, symbol) signature', () => {
    it('calls getQuote with null as first arg and symbol as second', async () => {
      const SYMBOL = 'NVDA';
      const gateway = makeGateway((_pluginId, _symbol) => Promise.resolve(makeQuote(SYMBOL, 120)));
      const svc = makeService(gateway);
      const state = makeState({
        cash: 1_000,
        positions: [{ symbol: SYMBOL, quantity: 1, avg_price: 100 }],
      });

      await (
        svc as unknown as { _updateEquityMetrics: (s: PretestState) => Promise<void> }
      )._updateEquityMetrics(state);

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(gateway.getQuote).toHaveBeenCalledWith(null, SYMBOL);
    });
  });
});

// ── Phase 2.1: RED tests — Policy Config Extraction ──────────────────────────
//
// These tests define the behavior of _readPolicy, and verify that _calcQuantity,
// _simulateFills (_applyBuy/_applySell) integrate the policy for sizing,
// slippage, and commission. All will fail until Phase 2.2 is implemented.

import { PretestPolicy } from './pretest.service';

describe('PretestService._readPolicy (Phase 2)', () => {
  describe('2.1.1 — no __pretest_policy__ key returns defaults', () => {
    it('returns { sizing_pct:0.05, slippage_pct:0, commission_pct:0 } when plugin_configs has no policy key', () => {
      const gateway = makeGateway(() => Promise.resolve(makeQuote('X', 100)));
      const svc = makeService(gateway);
      const portfolio = {
        plugin_configs: {},
      } as unknown as import('./pretest.service').PretestPortfolio;

      const policy = (
        svc as unknown as { _readPolicy: (p: typeof portfolio) => PretestPolicy }
      )._readPolicy(portfolio);

      expect(policy).toEqual({ sizing_pct: 0.05, slippage_pct: 0, commission_pct: 0 });
    });
  });

  describe('2.1.2 — partial override merges with defaults, coerce and clamp', () => {
    it('overrides sizing_pct and leaves others at default', () => {
      const gateway = makeGateway(() => Promise.resolve(makeQuote('X', 100)));
      const svc = makeService(gateway);
      const portfolio = {
        plugin_configs: { __pretest_policy__: { sizing_pct: 0.1 } },
      } as unknown as import('./pretest.service').PretestPortfolio;

      const policy = (
        svc as unknown as { _readPolicy: (p: typeof portfolio) => PretestPolicy }
      )._readPolicy(portfolio);

      expect(policy.sizing_pct).toBeCloseTo(0.1);
      expect(policy.slippage_pct).toBe(0);
      expect(policy.commission_pct).toBe(0);
    });

    it('clamps sizing_pct to (0, 1]: value 0 is clamped to a minimum positive value', () => {
      const gateway = makeGateway(() => Promise.resolve(makeQuote('X', 100)));
      const svc = makeService(gateway);
      const portfolio = {
        plugin_configs: { __pretest_policy__: { sizing_pct: 0 } },
      } as unknown as import('./pretest.service').PretestPortfolio;

      const policy = (
        svc as unknown as { _readPolicy: (p: typeof portfolio) => PretestPolicy }
      )._readPolicy(portfolio);

      expect(policy.sizing_pct).toBeGreaterThan(0);
    });

    it('clamps slippage_pct to [0, 1]: negative becomes 0', () => {
      const gateway = makeGateway(() => Promise.resolve(makeQuote('X', 100)));
      const svc = makeService(gateway);
      const portfolio = {
        plugin_configs: { __pretest_policy__: { slippage_pct: -0.5 } },
      } as unknown as import('./pretest.service').PretestPortfolio;

      const policy = (
        svc as unknown as { _readPolicy: (p: typeof portfolio) => PretestPolicy }
      )._readPolicy(portfolio);

      expect(policy.slippage_pct).toBe(0);
    });

    it('clamps commission_pct to [0, 1]: value > 1 becomes 1', () => {
      const gateway = makeGateway(() => Promise.resolve(makeQuote('X', 100)));
      const svc = makeService(gateway);
      const portfolio = {
        plugin_configs: { __pretest_policy__: { commission_pct: 5 } },
      } as unknown as import('./pretest.service').PretestPortfolio;

      const policy = (
        svc as unknown as { _readPolicy: (p: typeof portfolio) => PretestPolicy }
      )._readPolicy(portfolio);

      expect(policy.commission_pct).toBe(1);
    });

    it('coerces string numbers to numeric values', () => {
      const gateway = makeGateway(() => Promise.resolve(makeQuote('X', 100)));
      const svc = makeService(gateway);
      const portfolio = {
        plugin_configs: { __pretest_policy__: { sizing_pct: '0.10', commission_pct: '0.001' } },
      } as unknown as import('./pretest.service').PretestPortfolio;

      const policy = (
        svc as unknown as { _readPolicy: (p: typeof portfolio) => PretestPolicy }
      )._readPolicy(portfolio);

      expect(policy.sizing_pct).toBeCloseTo(0.1);
      expect(policy.commission_pct).toBeCloseTo(0.001);
    });
  });

  describe('2.1.3 — buy quantity uses state.cash * policy.sizing_pct, not hardcoded 0.05', () => {
    it('with sizing_pct=0.10, quantity is based on cash*0.10 budget', async () => {
      const PRICE = 100;
      const CASH = 10_000;
      // sizing_pct=0.10 → budget=1000 → qty=floor(1000/100)=10
      // sizing_pct=0.05 (old) → budget=500 → qty=5
      const gateway = makeGateway(() => Promise.resolve(makeQuote('AAPL', PRICE)));
      const svc = makeService(gateway);
      const portfolio = {
        plugin_configs: { __pretest_policy__: { sizing_pct: 0.1 } },
      } as unknown as import('./pretest.service').PretestPortfolio;
      const state = makeState({ cash: CASH });

      const trades = await (
        svc as unknown as {
          _simulateFills: (
            tc: unknown[],
            s: PretestState,
            policy: PretestPolicy,
          ) => Promise<PretestTrade[]>;
        }
      )._simulateFills(
        [makeToolCall('AAPL', 'buy')],
        state,
        (svc as unknown as { _readPolicy: (p: typeof portfolio) => PretestPolicy })._readPolicy(
          portfolio,
        ),
      );

      expect(trades).toHaveLength(1);
      // qty = floor(cash * 0.10 / price) = floor(10000 * 0.10 / 100) = 10
      expect(trades[0].quantity).toBe(10);
    });

    it('with default sizing_pct=0.05, quantity matches legacy behavior', async () => {
      const PRICE = 100;
      const CASH = 10_000;
      const gateway = makeGateway(() => Promise.resolve(makeQuote('AAPL', PRICE)));
      const svc = makeService(gateway);
      const portfolio = {
        plugin_configs: {},
      } as unknown as import('./pretest.service').PretestPortfolio;
      const state = makeState({ cash: CASH });

      const trades = await (
        svc as unknown as {
          _simulateFills: (
            tc: unknown[],
            s: PretestState,
            policy: PretestPolicy,
          ) => Promise<PretestTrade[]>;
        }
      )._simulateFills(
        [makeToolCall('AAPL', 'buy')],
        state,
        (svc as unknown as { _readPolicy: (p: typeof portfolio) => PretestPolicy })._readPolicy(
          portfolio,
        ),
      );

      expect(trades).toHaveLength(1);
      // qty = floor(cash * 0.05 / price) = floor(10000 * 0.05 / 100) = 5
      expect(trades[0].quantity).toBe(5);
    });
  });

  describe('2.1.4 — slippage applied to fill price', () => {
    it('buy fill price = last * (1 + slippage_pct)', async () => {
      const LAST = 100;
      const SLIPPAGE = 0.01; // 1%
      const gateway = makeGateway(() => Promise.resolve(makeQuote('AAPL', LAST)));
      const svc = makeService(gateway);
      const portfolio = {
        plugin_configs: { __pretest_policy__: { slippage_pct: SLIPPAGE } },
      } as unknown as import('./pretest.service').PretestPortfolio;
      const state = makeState({ cash: 10_000 });

      const trades = await (
        svc as unknown as {
          _simulateFills: (
            tc: unknown[],
            s: PretestState,
            policy: PretestPolicy,
          ) => Promise<PretestTrade[]>;
        }
      )._simulateFills(
        [makeToolCall('AAPL', 'buy')],
        state,
        (svc as unknown as { _readPolicy: (p: typeof portfolio) => PretestPolicy })._readPolicy(
          portfolio,
        ),
      );

      expect(trades).toHaveLength(1);
      // fill price = 100 * (1 + 0.01) = 101
      expect(trades[0].price).toBeCloseTo(LAST * (1 + SLIPPAGE));
    });

    it('sell fill price = last * (1 - slippage_pct)', async () => {
      const LAST = 200;
      const SLIPPAGE = 0.005; // 0.5%
      const gateway = makeGateway(() => Promise.resolve(makeQuote('TSLA', LAST)));
      const svc = makeService(gateway);
      const portfolio = {
        plugin_configs: { __pretest_policy__: { slippage_pct: SLIPPAGE } },
      } as unknown as import('./pretest.service').PretestPortfolio;
      const state = makeState({
        cash: 5_000,
        positions: [{ symbol: 'TSLA', quantity: 5, avg_price: 180 }],
      });

      const trades = await (
        svc as unknown as {
          _simulateFills: (
            tc: unknown[],
            s: PretestState,
            policy: PretestPolicy,
          ) => Promise<PretestTrade[]>;
        }
      )._simulateFills(
        [makeToolCall('TSLA', 'sell')],
        state,
        (svc as unknown as { _readPolicy: (p: typeof portfolio) => PretestPolicy })._readPolicy(
          portfolio,
        ),
      );

      expect(trades).toHaveLength(1);
      // fill price = 200 * (1 - 0.005) = 199
      expect(trades[0].price).toBeCloseTo(LAST * (1 - SLIPPAGE));
    });

    it('with zero slippage (default), fill price equals quote.last exactly', async () => {
      const LAST = 150;
      const gateway = makeGateway(() => Promise.resolve(makeQuote('AAPL', LAST)));
      const svc = makeService(gateway);
      const portfolio = {
        plugin_configs: {},
      } as unknown as import('./pretest.service').PretestPortfolio;
      const state = makeState({ cash: 10_000 });

      const trades = await (
        svc as unknown as {
          _simulateFills: (
            tc: unknown[],
            s: PretestState,
            policy: PretestPolicy,
          ) => Promise<PretestTrade[]>;
        }
      )._simulateFills(
        [makeToolCall('AAPL', 'buy')],
        state,
        (svc as unknown as { _readPolicy: (p: typeof portfolio) => PretestPolicy })._readPolicy(
          portfolio,
        ),
      );

      expect(trades).toHaveLength(1);
      expect(trades[0].price).toBe(LAST); // no slippage
    });
  });

  describe('2.1.5 — commission deducted from cash on buy and sell', () => {
    it('buy: cash deducted by cost + cost * commission_pct', () => {
      const gateway = makeGateway(() => Promise.resolve(makeQuote('X', 100)));
      const svc = makeService(gateway);

      // Manually apply a buy trade with commission
      const FILL_PRICE = 100;
      const QTY = 5;
      const COMMISSION = 0.001; // 0.1%
      const INITIAL_CASH = 10_000;
      const state = makeState({ cash: INITIAL_CASH });

      const trade: PretestTrade = {
        ts: new Date().toISOString(),
        symbol: 'AAPL',
        action: 'buy',
        price: FILL_PRICE,
        quantity: QTY,
      };

      (
        svc as unknown as {
          _applyBuy: (s: PretestState, t: PretestTrade, commission_pct: number) => void;
        }
      )._applyBuy(state, trade, COMMISSION);

      const cost = FILL_PRICE * QTY; // 500
      // cash = 10000 - cost - cost * commission_pct = 10000 - 500 - 0.5 = 9499.5
      expect(state.cash).toBeCloseTo(INITIAL_CASH - cost - cost * COMMISSION);
    });

    it('sell: cash increased by proceeds - proceeds * commission_pct', () => {
      const gateway = makeGateway(() => Promise.resolve(makeQuote('X', 100)));
      const svc = makeService(gateway);

      const FILL_PRICE = 200;
      const QTY = 5;
      const COMMISSION = 0.001;
      const INITIAL_CASH = 5_000;
      const state = makeState({
        cash: INITIAL_CASH,
        positions: [{ symbol: 'TSLA', quantity: QTY, avg_price: 180 }],
      });

      const trade: PretestTrade = {
        ts: new Date().toISOString(),
        symbol: 'TSLA',
        action: 'sell',
        price: FILL_PRICE,
        quantity: QTY,
      };

      (
        svc as unknown as {
          _applySell: (s: PretestState, t: PretestTrade, commission_pct: number) => void;
        }
      )._applySell(state, trade, COMMISSION);

      const proceeds = FILL_PRICE * QTY; // 1000
      // cash = 5000 + proceeds - proceeds * commission_pct = 5000 + 1000 - 1 = 5999
      expect(state.cash).toBeCloseTo(INITIAL_CASH + proceeds - proceeds * COMMISSION);
    });

    it('with zero commission (default), cash matches legacy behavior exactly', () => {
      const gateway = makeGateway(() => Promise.resolve(makeQuote('X', 100)));
      const svc = makeService(gateway);

      const FILL_PRICE = 100;
      const QTY = 5;
      const INITIAL_CASH = 10_000;
      const state = makeState({ cash: INITIAL_CASH });

      const trade: PretestTrade = {
        ts: new Date().toISOString(),
        symbol: 'AAPL',
        action: 'buy',
        price: FILL_PRICE,
        quantity: QTY,
      };

      (
        svc as unknown as {
          _applyBuy: (s: PretestState, t: PretestTrade, commission_pct: number) => void;
        }
      )._applyBuy(state, trade, 0);

      const cost = FILL_PRICE * QTY; // 500
      // cash = 10000 - 500 = 9500 (same as before)
      expect(state.cash).toBeCloseTo(INITIAL_CASH - cost);
    });
  });

  describe('2.1.6 — commission subtracted from realized PnL on sell', () => {
    it('realized_pnl includes commission deduction on sell', () => {
      const gateway = makeGateway(() => Promise.resolve(makeQuote('X', 100)));
      const svc = makeService(gateway);

      const AVG_PRICE = 180;
      const FILL_PRICE = 200;
      const QTY = 5;
      const COMMISSION = 0.001; // 0.1%
      const state = makeState({
        cash: 5_000,
        positions: [{ symbol: 'TSLA', quantity: QTY, avg_price: AVG_PRICE }],
        realized_pnl: 0,
      });

      const trade: PretestTrade = {
        ts: new Date().toISOString(),
        symbol: 'TSLA',
        action: 'sell',
        price: FILL_PRICE,
        quantity: QTY,
      };

      (
        svc as unknown as {
          _applySell: (s: PretestState, t: PretestTrade, commission_pct: number) => void;
        }
      )._applySell(state, trade, COMMISSION);

      const proceeds = FILL_PRICE * QTY; // 1000
      const gross_pnl = (FILL_PRICE - AVG_PRICE) * QTY; // (200-180)*5 = 100
      const commission_cost = proceeds * COMMISSION; // 1000 * 0.001 = 1
      // realized_pnl = gross_pnl - commission = 100 - 1 = 99
      expect(state.realized_pnl).toBeCloseTo(gross_pnl - commission_cost);
    });

    it('with zero commission (default), realized_pnl = gross_pnl (legacy behavior)', () => {
      const gateway = makeGateway(() => Promise.resolve(makeQuote('X', 100)));
      const svc = makeService(gateway);

      const AVG_PRICE = 180;
      const FILL_PRICE = 200;
      const QTY = 5;
      const state = makeState({
        cash: 5_000,
        positions: [{ symbol: 'TSLA', quantity: QTY, avg_price: AVG_PRICE }],
        realized_pnl: 0,
      });

      const trade: PretestTrade = {
        ts: new Date().toISOString(),
        symbol: 'TSLA',
        action: 'sell',
        price: FILL_PRICE,
        quantity: QTY,
      };

      (
        svc as unknown as {
          _applySell: (s: PretestState, t: PretestTrade, commission_pct: number) => void;
        }
      )._applySell(state, trade, 0);

      const gross_pnl = (FILL_PRICE - AVG_PRICE) * QTY; // 100
      expect(state.realized_pnl).toBeCloseTo(gross_pnl);
    });
  });
});

// ── Fix 2: Ghost-trade guard in _applyTrades ─────────────────────────────────
//
// Currently _applyTrades appends ALL trades to state.trades BEFORE calling
// _applyBuy/_applySell. _applyBuy silently returns when cost > cash, leaving
// a ghost trade (recorded but never executed) in state.trades. The fix: only
// record a trade when it actually executes. _applyBuy/_applySell push on
// success; _applyTrades does NOT pre-append.

describe('PretestService._applyTrades — ghost-trade guard (fix 2)', () => {
  describe('fix2.1 — two buys, combined cost > cash: only executed trade is recorded', () => {
    it('state.trades contains only the first (affordable) buy, not the rejected second', () => {
      // cash=1000, price=500, 5% budget = 50 → qty = Math.floor(50/500) = 0 ... use price 100
      // cash=1000, 5% budget=50, price=10 → qty=5, cost=50 ✓
      // second buy same symbol: remaining cash=950, budget=47.5, qty=4, cost=40 ✓
      // Let's use a bigger price so the second fails:
      // cash=600, price=100 → budget=30, qty=0... need qty > 0
      // Easiest: build trades manually (simulate already-filled by _simulateFills)
      // cash=600, trade1: price=500 qty=1 cost=500 → passes (600>=500), remaining=100
      // trade2: price=200 qty=1 cost=200 → fails (100<200) → ghost without fix
      const gateway = makeGateway(() => Promise.resolve(makeQuote('X', 0)));
      const svc = makeService(gateway);
      const state = makeState({ cash: 600 });

      const trade1: PretestTrade = {
        ts: new Date().toISOString(),
        symbol: 'AAPL',
        action: 'buy',
        price: 500,
        quantity: 1,
      };
      const trade2: PretestTrade = {
        ts: new Date().toISOString(),
        symbol: 'MSFT',
        action: 'buy',
        price: 200,
        quantity: 1, // cost=200 > remaining cash=100 after trade1 → should be rejected
      };

      const result = (
        svc as unknown as {
          _applyTrades: (s: PretestState, trades: PretestTrade[]) => PretestState;
        }
      )._applyTrades(state, [trade1, trade2]);

      // Only trade1 executed — state.trades must have exactly 1 entry
      expect(result.trades).toHaveLength(1);
      expect(result.trades[0].symbol).toBe('AAPL');

      // Cash = 600 - 500 = 100 (not 600 - 500 - 200)
      expect(result.cash).toBeCloseTo(100);

      // Only AAPL position, no MSFT
      expect(result.positions).toHaveLength(1);
      expect(result.positions[0].symbol).toBe('AAPL');
    });
  });

  describe('fix2.2 — rejected buy leaves cash unchanged', () => {
    it('cash is not affected by a trade that was not executed', () => {
      const gateway = makeGateway(() => Promise.resolve(makeQuote('X', 0)));
      const svc = makeService(gateway);
      const INITIAL_CASH = 50;

      const state = makeState({ cash: INITIAL_CASH });
      const unaffordable: PretestTrade = {
        ts: new Date().toISOString(),
        symbol: 'GOOG',
        action: 'buy',
        price: 3_000,
        quantity: 1, // cost 3000 > cash 50
      };

      const result = (
        svc as unknown as {
          _applyTrades: (s: PretestState, trades: PretestTrade[]) => PretestState;
        }
      )._applyTrades(state, [unaffordable]);

      expect(result.cash).toBe(INITIAL_CASH);
      expect(result.trades).toHaveLength(0);
      expect(result.positions).toHaveLength(0);
    });
  });
});

// ── Fix 3 (PR2 jd): reserved-key exclusion invariant ─────────────────────────
//
// '__pretest_policy__' is a reserved key in plugin_configs, NOT a plugin id.
// It must never appear in the plugin_ids array passed to sandbox.runCycle.
// This test constructs a portfolio where plugin_configs contains
// '__pretest_policy__', verifies that plugin_ids is built from pretestPlugins
// (which are filtered from allPlugins by actual ids), and confirms that
// '__pretest_policy__' never ends up in the ids sent to runCycle.

import type { SandboxGateway as SandboxGatewayType } from '../sandbox/sandbox.gateway';

describe('PretestService.runCycle — __pretest_policy__ exclusion (fix 3)', () => {
  it('does not pass __pretest_policy__ as a plugin_id to sandbox.runCycle', async () => {
    // Build a minimal service wiring with mocked db, sandbox, plugins, llm, memory
    const runCycleMock = jest.fn().mockResolvedValue({ result: { pending_signals: [] } });
    const sandbox = { runCycle: runCycleMock } as unknown as SandboxGatewayType;

    const fakePretestPluginId = 'real-plugin-123';
    const pluginsFindActive = jest
      .fn()
      .mockResolvedValue([{ id: fakePretestPluginId, config: {} }]);
    const pluginsService = {
      findActive: pluginsFindActive,
    } as unknown as import('../plugins/plugins.service').PluginsService;

    const portfolioRow = {
      id: 'port-1',
      name: 'Test Portfolio',
      description: null,
      initial_capital: 10_000,
      plugin_ids: JSON.stringify([fakePretestPluginId]),
      // plugin_configs has both the real plugin override AND the reserved policy key
      plugin_configs: JSON.stringify({
        [fakePretestPluginId]: {},
        __pretest_policy__: { commission_pct: 0.001 },
      }),
      state: JSON.stringify({
        equity: 10_000,
        cash: 10_000,
        positions: [],
        trades: [],
        max_equity: 10_000,
        max_drawdown_pct: 0,
        realized_pnl: 0,
        win_trades: 0,
        loss_trades: 0,
      }),
      run_count: 0,
      last_run_at: null,
      is_active: true,
      created_at: new Date(),
      updated_at: new Date(),
    };

    const db = {
      pretestPortfolio: {
        findUnique: jest.fn().mockResolvedValue(portfolioRow),
        update: jest.fn().mockResolvedValue(portfolioRow),
      },
    } as unknown as import('../prisma/prisma.service').PrismaService;

    const llm = {
      complete: jest.fn().mockResolvedValue({ text: '', tool_calls: [] }),
    } as unknown as import('../llm/llm.service').LlmService;

    const memory = {
      toContextString: jest.fn().mockResolvedValue(''),
    } as unknown as import('../context-memory/context-memory.service').ContextMemoryService;

    const gateway = makeGateway(() => Promise.resolve(makeQuote('X', 100)));

    const mockAgents = {
      runGovernedTurn: jest.fn().mockResolvedValue({
        cycle_id: 'fix3-cycle',
        text: '',
        tool_calls: [],
        decisions: [],
        sandbox_results: [],
        backend: 'api',
        skills_read: [],
        skills_written: [],
        llm_response: {
          text: '',
          tool_calls: [],
          backend: 'api',
          skills_read: [],
          skills_written: [],
        },
        signalsEmitted: [],
      }),
    } as unknown as import('../agents/agents.service').AgentsService;

    const svc = new (await import('./pretest.service')).PretestService(
      db,
      sandbox,
      pluginsService,
      llm,
      memory,
      gateway,
      mockAgents,
    );

    await svc.runCycle('port-1');

    // sandbox.runCycle must have been called
    expect(runCycleMock).toHaveBeenCalledTimes(1);
    const [pluginIds] = runCycleMock.mock.calls[0] as [string[], unknown];

    // '__pretest_policy__' must NOT be in the ids passed to sandbox
    expect(pluginIds).not.toContain('__pretest_policy__');
    // The real plugin id IS present
    expect(pluginIds).toContain(fakePretestPluginId);
  });
});

// ── Fix 4 (PR2 jd): commission cost-basis in avg_price — cash/pnl conservation ──
//
// BUG: _applyBuy deducts buy commission from cash but does NOT embed it in
// avg_price. _applySell's realized_pnl = (sell - avg_price)*qty - sell_commission
// only subtracts sell commission → PnL is overstated by the buy commission.
// This breaks the invariant: initial_cash + realized_pnl == final_cash (after
// a flat round-trip with no open positions).
//
// FIX: embed buy commission in cost basis:
//   avg_price = (price * qty + buy_commission) / qty
// Then realized_pnl = (sell_price - avg_price_with_commission)*qty - sell_commission
// satisfies the conservation invariant exactly.

describe('PretestService — commission cost-basis and cash/pnl conservation (fix 4)', () => {
  describe('fix4.1 — round-trip conservation: initial_cash + realized_pnl ≈ final_cash', () => {
    it('holds the conservation invariant buy 10@100 → sell 10@120 with commission_pct=0.001', () => {
      const gateway = makeGateway(() => Promise.resolve(makeQuote('X', 100)));
      const svc = makeService(gateway);

      const INITIAL_CASH = 10_000;
      const BUY_PRICE = 100;
      const SELL_PRICE = 120;
      const QTY = 10;
      const COMMISSION = 0.001; // 0.1%

      const state = makeState({ cash: INITIAL_CASH });

      // Buy 10 @ 100
      const buyTrade: PretestTrade = {
        ts: new Date().toISOString(),
        symbol: 'AAPL',
        action: 'buy',
        price: BUY_PRICE,
        quantity: QTY,
      };
      (
        svc as unknown as {
          _applyBuy: (s: PretestState, t: PretestTrade, commission_pct: number) => void;
        }
      )._applyBuy(state, buyTrade, COMMISSION);

      // Sell 10 @ 120
      const sellTrade: PretestTrade = {
        ts: new Date().toISOString(),
        symbol: 'AAPL',
        action: 'sell',
        price: SELL_PRICE,
        quantity: QTY,
      };
      (
        svc as unknown as {
          _applySell: (s: PretestState, t: PretestTrade, commission_pct: number) => void;
        }
      )._applySell(state, sellTrade, COMMISSION);

      // Conservation invariant: after flat round-trip (no open positions)
      // final_cash must equal initial_cash + realized_pnl
      expect(state.positions).toHaveLength(0); // flat, no open position
      expect(state.cash).toBeCloseTo(INITIAL_CASH + state.realized_pnl, 8);
    });

    it('conservation holds with zero commission (no regression on defaults)', () => {
      const gateway = makeGateway(() => Promise.resolve(makeQuote('X', 100)));
      const svc = makeService(gateway);

      const INITIAL_CASH = 10_000;
      const state = makeState({ cash: INITIAL_CASH });

      const buyTrade: PretestTrade = {
        ts: new Date().toISOString(),
        symbol: 'AAPL',
        action: 'buy',
        price: 100,
        quantity: 10,
      };
      (
        svc as unknown as {
          _applyBuy: (s: PretestState, t: PretestTrade, commission_pct: number) => void;
        }
      )._applyBuy(state, buyTrade, 0);

      const sellTrade: PretestTrade = {
        ts: new Date().toISOString(),
        symbol: 'AAPL',
        action: 'sell',
        price: 120,
        quantity: 10,
      };
      (
        svc as unknown as {
          _applySell: (s: PretestState, t: PretestTrade, commission_pct: number) => void;
        }
      )._applySell(state, sellTrade, 0);

      expect(state.positions).toHaveLength(0);
      expect(state.cash).toBeCloseTo(INITIAL_CASH + state.realized_pnl, 8);
    });
  });

  describe('fix4.2 — avg_price embeds buy commission (cost-basis accounting)', () => {
    it('avg_price = (price * qty + buy_commission) / qty after a buy with commission', () => {
      const gateway = makeGateway(() => Promise.resolve(makeQuote('X', 100)));
      const svc = makeService(gateway);

      const BUY_PRICE = 100;
      const QTY = 10;
      const COMMISSION = 0.001; // buy_commission = 100*10*0.001 = 1.0
      // expected avg_price = (100*10 + 1.0) / 10 = 100.1
      const EXPECTED_AVG = (BUY_PRICE * QTY + BUY_PRICE * QTY * COMMISSION) / QTY;

      const state = makeState({ cash: 10_000 });
      const trade: PretestTrade = {
        ts: new Date().toISOString(),
        symbol: 'AAPL',
        action: 'buy',
        price: BUY_PRICE,
        quantity: QTY,
      };

      (
        svc as unknown as {
          _applyBuy: (s: PretestState, t: PretestTrade, commission_pct: number) => void;
        }
      )._applyBuy(state, trade, COMMISSION);

      expect(state.positions).toHaveLength(1);
      expect(state.positions[0].avg_price).toBeCloseTo(EXPECTED_AVG, 8);
    });

    it('with zero commission, avg_price equals fill price exactly (no regression)', () => {
      const gateway = makeGateway(() => Promise.resolve(makeQuote('X', 100)));
      const svc = makeService(gateway);

      const BUY_PRICE = 100;
      const QTY = 5;
      const state = makeState({ cash: 10_000 });
      const trade: PretestTrade = {
        ts: new Date().toISOString(),
        symbol: 'AAPL',
        action: 'buy',
        price: BUY_PRICE,
        quantity: QTY,
      };

      (
        svc as unknown as {
          _applyBuy: (s: PretestState, t: PretestTrade, commission_pct: number) => void;
        }
      )._applyBuy(state, trade, 0);

      expect(state.positions[0].avg_price).toBe(BUY_PRICE); // byte-identical default
    });
  });
});

// ── Fix 5 (PR2 jd): _calcQuantity accounts for commission in budget ───────────
//
// BUG: qty = floor(budget / price). With commission, total_cost = price*qty*(1+commission_pct)
// can exceed budget → trade computed but then rejected at _applyBuy (cost > cash after sizing).
// FIX: qty = floor(budget / (price * (1 + commission_pct))) so sizing pre-accounts for fee.

describe('PretestService._calcQuantity — commission-aware sizing (fix 5)', () => {
  describe('fix5.1 — computed qty total_cost (incl commission) stays within budget', () => {
    it('with commission_pct=0.001, total cost including fee does not exceed budget', async () => {
      const PRICE = 100;
      const CASH = 10_000;
      const COMMISSION = 0.001;
      // budget = 10000 * 0.05 = 500; without fix: qty=5, total_cost=500*(1.001)=500.5 > 500
      // with fix: qty = floor(500 / (100 * 1.001)) = floor(500/100.1) = floor(4.995) = 4
      //           total_cost = 4 * 100 * 1.001 = 400.4 ≤ 500 ✓
      const gateway = makeGateway(() => Promise.resolve(makeQuote('AAPL', PRICE)));
      const svc = makeService(gateway);
      const portfolio = {
        plugin_configs: { __pretest_policy__: { commission_pct: COMMISSION } },
      } as unknown as import('./pretest.service').PretestPortfolio;
      const state = makeState({ cash: CASH });
      const policy = (
        svc as unknown as { _readPolicy: (p: typeof portfolio) => PretestPolicy }
      )._readPolicy(portfolio);

      const trades = await (
        svc as unknown as {
          _simulateFills: (
            tc: unknown[],
            s: PretestState,
            policy: PretestPolicy,
          ) => Promise<PretestTrade[]>;
        }
      )._simulateFills([makeToolCall('AAPL', 'buy')], state, policy);

      expect(trades).toHaveLength(1);
      const qty = trades[0].quantity;
      const budget = state.cash * policy.sizing_pct;
      const total_cost = PRICE * qty * (1 + COMMISSION);
      // The key invariant: total cost including commission must not exceed budget
      expect(total_cost).toBeLessThanOrEqual(budget + Number.EPSILON);
    });

    it('with zero commission, sizing is unchanged (no regression on defaults)', async () => {
      const PRICE = 100;
      const CASH = 10_000;
      // qty = floor(10000*0.05 / 100) = floor(5) = 5
      const gateway = makeGateway(() => Promise.resolve(makeQuote('AAPL', PRICE)));
      const svc = makeService(gateway);
      const portfolio = {
        plugin_configs: {},
      } as unknown as import('./pretest.service').PretestPortfolio;
      const state = makeState({ cash: CASH });
      const policy = (
        svc as unknown as { _readPolicy: (p: typeof portfolio) => PretestPolicy }
      )._readPolicy(portfolio);

      const trades = await (
        svc as unknown as {
          _simulateFills: (
            tc: unknown[],
            s: PretestState,
            policy: PretestPolicy,
          ) => Promise<PretestTrade[]>;
        }
      )._simulateFills([makeToolCall('AAPL', 'buy')], state, policy);

      expect(trades).toHaveLength(1);
      expect(trades[0].quantity).toBe(5); // floor(500/100) = 5, unchanged
    });
  });
});

// ── PR3 (3.1.6): PretestService.runCycle calls agents.runGovernedTurn ─────────
//
// PretestService must use agents.runGovernedTurn({source:'pretest', virtual_only:true})
// instead of llm.complete(). llm.complete must NEVER be called from PretestService.runCycle.

describe('PretestService.runCycle — uses agents.runGovernedTurn (PR3)', () => {
  it('3.1.6 — runCycle calls agents.runGovernedTurn with source:pretest + virtual_only:true; llm.complete is never called', async () => {
    const PORTFOLIO_ID = 'portfolio-pr3';

    const governedTurnResult = {
      cycle_id: 'cycle-pr3',
      text: 'pretest llm analysis',
      tool_calls: [],
      decisions: [],
      sandbox_results: [],
      backend: 'api' as const,
      skills_read: [],
      skills_written: [],
      llm_response: {
        text: '',
        tool_calls: [],
        backend: 'api' as const,
        skills_read: [],
        skills_written: [],
      },
      signalsEmitted: [],
    };

    const mockAgents = {
      runGovernedTurn: jest.fn().mockResolvedValue(governedTurnResult),
    } as unknown as AgentsService;

    const mockLlm = {
      complete: jest.fn().mockResolvedValue({ text: '', tool_calls: [], backend: 'api' }),
    } as unknown as LlmService;

    const gateway = makeGateway(() => Promise.resolve(makeQuote('AAPL', 150)));
    const memory = {
      toContextString: jest.fn().mockResolvedValue(''),
    } as unknown as ContextMemoryService;
    const plugins = { findActive: jest.fn().mockResolvedValue([]) } as unknown as PluginsService;
    const sandbox = {
      runCycle: jest.fn().mockResolvedValue({ ok: true, result: { pending_signals: [] } }),
    } as unknown as SandboxGateway;

    const portfolioRow = {
      id: PORTFOLIO_ID,
      name: 'PR3 Portfolio',
      description: null,
      initial_capital: 10000,
      plugin_ids: JSON.stringify([]),
      plugin_configs: JSON.stringify({}),
      state: JSON.stringify({
        equity: 10000,
        cash: 10000,
        positions: [],
        trades: [],
        max_equity: 10000,
        max_drawdown_pct: 0,
        realized_pnl: 0,
        win_trades: 0,
        loss_trades: 0,
      }),
      run_count: 0,
      last_run_at: null,
      is_active: true,
      created_at: new Date(),
      updated_at: new Date(),
    };

    const db = {
      pretestPortfolio: {
        findUnique: jest.fn().mockResolvedValue(portfolioRow),
        update: jest.fn().mockResolvedValue(portfolioRow),
      },
    } as unknown as PrismaService;

    // Build service with both llm AND agents injected
    const svc = new PretestService(db, sandbox, plugins, mockLlm, memory, gateway, mockAgents);

    await svc.runCycle(PORTFOLIO_ID);

    // agents.runGovernedTurn must have been called with source:'pretest' and virtual_only:true
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockAgents.runGovernedTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'pretest',
        virtual_only: true,
      }),
    );

    // llm.complete must NEVER be called from PretestService
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockLlm.complete).not.toHaveBeenCalled();
  });
});
