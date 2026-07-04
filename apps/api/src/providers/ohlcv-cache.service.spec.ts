/**
 * OhlcvCacheService — behavioral unit tests.
 *
 * Coverage: hit/miss, TTL per timeframe, key scoping, invalidateSymbol,
 * invalidateProvider, and quote cache (fresh / expired).
 *
 * TTL assertions use a ±100 ms tolerance to avoid flakiness from CI timing
 * variance. Never use exact equality for expiresAt.
 */

import { OhlcvCacheService } from './ohlcv-cache.service';
import type { OhlcvBar, Quote } from './provider-gateway.service';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeService(): OhlcvCacheService {
  return new OhlcvCacheService();
}

function makeBar(ts = '2024-01-01T00:00:00Z'): OhlcvBar {
  return { ts, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1000 };
}

function makeQuote(symbol = 'AAPL'): Quote {
  return { symbol, bid: 100, ask: 102, last: 101, ts: '2024-01-01T00:00:00Z' };
}

// ── Expose internals via type cast for TTL inspection ─────────────────────────

interface CacheServiceInternals {
  ohlcvCache: Map<string, { data: OhlcvBar[]; expiresAt: number }>;
  quoteCache: Map<string, { data: Quote; expiresAt: number }>;
}

function internals(svc: OhlcvCacheService): CacheServiceInternals {
  return svc as unknown as CacheServiceInternals;
}

// ── OHLCV Cache: miss ─────────────────────────────────────────────────────────

describe('OhlcvCacheService — cache miss', () => {
  it('returns null when key is not present', () => {
    const svc = makeService();
    expect(svc.getOhlcv('alpaca', 'AAPL', '1d', 200)).toBeNull();
  });

  it('returns null and deletes entry when entry has expired', () => {
    const svc = makeService();
    const bars = [makeBar()];
    svc.setOhlcv('alpaca', 'AAPL', '1d', 200, bars);

    // Manually force-expire the entry
    const key = 'alpaca:AAPL:1d:200';
    internals(svc).ohlcvCache.set(key, { data: bars, expiresAt: Date.now() - 1 });

    const result = svc.getOhlcv('alpaca', 'AAPL', '1d', 200);
    expect(result).toBeNull();
    expect(internals(svc).ohlcvCache.has(key)).toBe(false);
  });
});

// ── OHLCV Cache: hit ──────────────────────────────────────────────────────────

describe('OhlcvCacheService — cache hit', () => {
  it('returns stored bars when entry is fresh', () => {
    const svc = makeService();
    const bars = [makeBar(), makeBar('2024-01-02T00:00:00Z')];
    svc.setOhlcv('alpaca', 'AAPL', '1d', 200, bars);

    const result = svc.getOhlcv('alpaca', 'AAPL', '1d', 200);
    expect(result).toEqual(bars);
  });
});

// ── TTL per timeframe ─────────────────────────────────────────────────────────

describe('OhlcvCacheService — TTL per timeframe', () => {
  it('uses 4-hour TTL for 1d timeframe (±100 ms tolerance)', () => {
    const svc = makeService();
    const bars = [makeBar()];
    const before = Date.now();
    svc.setOhlcv('alpaca', 'AAPL', '1d', 200, bars);

    const entry = internals(svc).ohlcvCache.get('alpaca:AAPL:1d:200');
    expect(entry).toBeDefined();

    const expectedExpiry = before + 4 * 3_600_000;
    expect(entry!.expiresAt).toBeGreaterThanOrEqual(expectedExpiry - 100);
    expect(entry!.expiresAt).toBeLessThanOrEqual(expectedExpiry + 100);
  });

  it('uses DEFAULT_TTL (5 minutes) for unknown timeframe (±100 ms tolerance)', () => {
    const svc = makeService();
    const bars = [makeBar()];
    const before = Date.now();
    svc.setOhlcv('alpaca', 'AAPL', 'unknown', 200, bars);

    const entry = internals(svc).ohlcvCache.get('alpaca:AAPL:unknown:200');
    expect(entry).toBeDefined();

    const expectedExpiry = before + 5 * 60_000;
    expect(entry!.expiresAt).toBeGreaterThanOrEqual(expectedExpiry - 100);
    expect(entry!.expiresAt).toBeLessThanOrEqual(expectedExpiry + 100);
  });
});

// ── Empty results must not poison the cache with the normal TTL ───────────────

describe('OhlcvCacheService — empty result TTL (no cache poisoning)', () => {
  it('caches an empty OHLCV result with a short TTL (1 min), not the timeframe TTL (±100 ms tolerance)', () => {
    const svc = makeService();
    const before = Date.now();
    svc.setOhlcv('yahoo-finance-provider', 'TECL', '1d', 400, []);

    const entry = internals(svc).ohlcvCache.get('yahoo-finance-provider:TECL:1d:400');
    expect(entry).toBeDefined();

    // Must be the short empty-result TTL (60s), NOT the 4h '1d' TTL.
    const expectedExpiry = before + 60_000;
    expect(entry!.expiresAt).toBeGreaterThanOrEqual(expectedExpiry - 100);
    expect(entry!.expiresAt).toBeLessThanOrEqual(expectedExpiry + 100);
  });

  it('a transient empty result self-heals: after the short TTL elapses, cache misses again instead of serving [] for 4h', () => {
    const svc = makeService();
    svc.setOhlcv('yahoo-finance-provider', 'TECL', '1d', 400, []);

    // Simulate the short TTL having elapsed (well before the 4h '1d' TTL would).
    const key = 'yahoo-finance-provider:TECL:1d:400';
    internals(svc).ohlcvCache.set(key, { data: [], expiresAt: Date.now() - 1 });

    const result = svc.getOhlcv('yahoo-finance-provider', 'TECL', '1d', 400);
    expect(result).toBeNull();
    expect(internals(svc).ohlcvCache.has(key)).toBe(false);
  });

  it('a valid (non-empty) result still gets the full timeframe TTL', () => {
    const svc = makeService();
    const bars = [makeBar()];
    const before = Date.now();
    svc.setOhlcv('yahoo-finance-provider', 'SPY', '1d', 400, bars);

    const entry = internals(svc).ohlcvCache.get('yahoo-finance-provider:SPY:1d:400');
    expect(entry).toBeDefined();

    const expectedExpiry = before + 4 * 3_600_000;
    expect(entry!.expiresAt).toBeGreaterThanOrEqual(expectedExpiry - 100);
    expect(entry!.expiresAt).toBeLessThanOrEqual(expectedExpiry + 100);
  });
});

// ── Key scoping ───────────────────────────────────────────────────────────────

describe('OhlcvCacheService — key scoping', () => {
  it('same symbol with different timeframe produces distinct entries', () => {
    const svc = makeService();
    const bars1d = [makeBar('2024-01-01T00:00:00Z')];
    const bars1h = [makeBar('2024-01-01T01:00:00Z')];

    svc.setOhlcv('alpaca', 'AAPL', '1d', 200, bars1d);
    svc.setOhlcv('alpaca', 'AAPL', '1h', 200, bars1h);

    expect(svc.getOhlcv('alpaca', 'AAPL', '1h', 200)).toEqual(bars1h);
    expect(svc.getOhlcv('alpaca', 'AAPL', '1d', 200)).toEqual(bars1d);
  });

  it('same symbol with different provider produces distinct entries', () => {
    const svc = makeService();
    const barsAlpaca = [makeBar('2024-01-01T00:00:00Z')];
    const barsTiingo = [makeBar('2024-01-02T00:00:00Z')];

    svc.setOhlcv('alpaca', 'AAPL', '1d', 200, barsAlpaca);
    svc.setOhlcv('tiingo', 'AAPL', '1d', 200, barsTiingo);

    expect(svc.getOhlcv('tiingo', 'AAPL', '1d', 200)).toEqual(barsTiingo);
    expect(svc.getOhlcv('alpaca', 'AAPL', '1d', 200)).toEqual(barsAlpaca);
  });
});

// ── invalidateSymbol ──────────────────────────────────────────────────────────

describe('OhlcvCacheService — invalidateSymbol', () => {
  it('removes all OHLCV entries for the given symbol across providers and timeframes', () => {
    const svc = makeService();
    const bars = [makeBar()];

    svc.setOhlcv('alpaca', 'AAPL', '1d', 200, bars);
    svc.setOhlcv('tiingo', 'AAPL', '1h', 100, bars);
    // A different symbol that must survive
    svc.setOhlcv('alpaca', 'TSLA', '1d', 200, bars);

    svc.invalidateSymbol('AAPL');

    expect(svc.getOhlcv('alpaca', 'AAPL', '1d', 200)).toBeNull();
    expect(svc.getOhlcv('tiingo', 'AAPL', '1h', 100)).toBeNull();
    // TSLA must not be affected
    expect(svc.getOhlcv('alpaca', 'TSLA', '1d', 200)).toEqual(bars);
  });
});

// ── invalidateProvider ────────────────────────────────────────────────────────

describe('OhlcvCacheService — invalidateProvider', () => {
  it('removes only entries for the target provider, leaving others intact', () => {
    const svc = makeService();
    const bars = [makeBar()];

    svc.setOhlcv('alpaca', 'AAPL', '1d', 200, bars);
    svc.setOhlcv('tiingo', 'AAPL', '1d', 200, bars);

    svc.invalidateProvider('alpaca');

    expect(svc.getOhlcv('alpaca', 'AAPL', '1d', 200)).toBeNull();
    expect(svc.getOhlcv('tiingo', 'AAPL', '1d', 200)).toEqual(bars);
  });
});

// ── Quote cache ───────────────────────────────────────────────────────────────

describe('OhlcvCacheService — quote cache', () => {
  it('returns stored quote when entry is fresh', () => {
    const svc = makeService();
    const quote = makeQuote('AAPL');
    svc.setQuote('alpaca', 'AAPL', quote);

    expect(svc.getQuote('alpaca', 'AAPL')).toEqual(quote);
  });

  it('returns null and deletes entry when quote has expired', () => {
    const svc = makeService();
    const quote = makeQuote('AAPL');
    svc.setQuote('alpaca', 'AAPL', quote);

    // Force-expire the quote entry
    const key = 'alpaca:AAPL';
    internals(svc).quoteCache.set(key, { data: quote, expiresAt: Date.now() - 1 });

    expect(svc.getQuote('alpaca', 'AAPL')).toBeNull();
    expect(internals(svc).quoteCache.has(key)).toBe(false);
  });
});
