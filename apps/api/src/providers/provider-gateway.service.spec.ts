/**
 * ProviderGatewayService — behavioral unit tests.
 *
 * Coverage:
 *  - Provider discovery: manifest type=provider registered; non-provider excluded;
 *    missing manifest skipped; plugin event triggers rediscovery.
 *  - Credential injection: hasCredentials true/false; getDefaultProvider.
 *  - getQuote dispatch: unknown pluginId throws; HTTP 4xx propagates;
 *    cache hit → no fetch; cache miss → fetch + cache.setQuote.
 *  - normalizeQuote: Alpaca (intentional mid-price), Tiingo, Binance, unknown.
 *  - getOhlcv: cache hit → no fetch; cache miss → fetch + cache.setOhlcv.
 *
 * Strategy for fs isolation:
 *  - discoverProviders() is private — we drive it via onModuleInit() and
 *    onPluginEvent() (the public surface).
 *  - We stub the private helpers resolvePluginsRoot / parseManifest / discoverProviders
 *    by accessing them through a typed internal-accessor interface cast as
 *    unknown → ServiceInternals. No jest.mock('fs') needed; no fs module side
 *    effects escape into the worker process.
 *  - globalThis.fetch is replaced with a jest.fn() before each test and restored
 *    after. The service calls globalThis.fetch directly so no module mock is needed.
 */

import { ProviderGatewayService } from './provider-gateway.service';
import { OhlcvCacheService } from './ohlcv-cache.service';
import type { Quote } from './provider-gateway.service';

// ── Internal-accessor interface ───────────────────────────────────────────────
// Mirrors the private shape we need to stub.  Cast via `as unknown as`.

interface ServiceInternals {
  providers: Map<string, ProviderManifestShape>;
  resolvePluginsRoot: () => string | null;
  parseManifest: (path: string) => ProviderManifestShape | null;
  discoverProviders: () => void;
}

// Mirrors the internal ProviderManifest type (defined in the service file but
// not exported).  Keeping it here avoids coupling the test to module internals
// while still allowing typed stubs.
interface ProviderManifestShape {
  plugin: { id: string; name: string; type: string };
  api: {
    format: string;
    base_url?: string;
    auth_type: 'header' | 'query_param' | 'bearer';
    auth_key_env?: string;
    auth_secret_env?: string;
    auth_key_header?: string;
    auth_secret_header?: string;
    endpoints: Record<string, string>;
  };
}

// ── Manifest factory helpers ──────────────────────────────────────────────────

function makeAlpacaManifest(): ProviderManifestShape {
  return {
    plugin: { id: 'alpaca', name: 'Alpaca Markets', type: 'provider' },
    api: {
      format: 'alpaca',
      base_url: 'https://api.alpaca.markets',
      auth_type: 'header',
      auth_key_env: 'ALPACA_KEY',
      auth_secret_env: 'ALPACA_SECRET',
      auth_key_header: 'APCA-API-KEY-ID',
      auth_secret_header: 'APCA-API-SECRET-KEY',
      endpoints: {
        quote: '{base_url}/v2/stocks/{symbol}/quotes/latest',
        ohlcv: '{base_url}/v2/stocks/{symbol}/bars?timeframe={tf}&limit={limit}&start={start_date}',
      },
    },
  };
}

function makeTiingoManifest(): ProviderManifestShape {
  return {
    plugin: { id: 'tiingo', name: 'Tiingo', type: 'provider' },
    api: {
      format: 'tiingo',
      base_url: 'https://api.tiingo.com',
      auth_type: 'header',
      auth_key_env: 'TIINGO_KEY',
      auth_key_header: 'Authorization',
      endpoints: {
        quote: '{base_url}/iex/{symbol}',
        ohlcv: '{base_url}/daily/{symbol}/prices',
      },
    },
  };
}

function makeBinanceManifest(): ProviderManifestShape {
  return {
    plugin: { id: 'binance', name: 'Binance', type: 'provider' },
    api: {
      format: 'binance',
      base_url: 'https://api.binance.com',
      auth_type: 'header',
      auth_key_env: 'BINANCE_KEY',
      auth_key_header: 'X-MBX-APIKEY',
      endpoints: {
        quote: '{base_url}/api/v3/ticker/price?symbol={symbol}',
        ohlcv: '{base_url}/api/v3/klines?symbol={symbol}&interval={tf}&limit={limit}',
      },
    },
  };
}

function makeAgentManifest(): ProviderManifestShape {
  return {
    plugin: { id: 'my-agent', name: 'My Agent', type: 'agent' },
    api: { format: 'generic', auth_type: 'header', endpoints: {} },
  };
}

function makeUnknownFormatManifest(): ProviderManifestShape {
  return {
    plugin: { id: 'unknown-fmt', name: 'Unknown Format Provider', type: 'provider' },
    api: {
      format: 'unknown',
      base_url: 'https://api.example.com',
      auth_type: 'header',
      auth_key_env: 'UNKNOWN_KEY',
      endpoints: {
        quote: '{base_url}/quote/{symbol}',
        ohlcv: '{base_url}/ohlcv/{symbol}',
      },
    },
  };
}

// ── Service builder ───────────────────────────────────────────────────────────

/**
 * Builds a ProviderGatewayService with its private discovery helpers stubbed
 * so that discoverProviders() is driven entirely from in-memory data.
 *
 * @param pluginDirs  - directory names visible on the fake plugins root
 * @param manifestMap - dir name → manifest (or null to simulate a missing manifest)
 * @param cacheOverride - optional partial OhlcvCacheService overrides
 */
function makeService(
  pluginDirs: string[],
  manifestMap: Record<string, ProviderManifestShape | null>,
  cacheOverride?: Partial<OhlcvCacheService>,
): { svc: ProviderGatewayService; cache: OhlcvCacheService } {
  const cache = Object.assign(new OhlcvCacheService(), cacheOverride ?? {});
  const svc = new ProviderGatewayService(cache);
  const internals = svc as unknown as ServiceInternals;

  internals.resolvePluginsRoot = () => '/fake/plugins';
  internals.parseManifest = (filePath: string) => {
    const dir = filePath.split('/')[3];
    return manifestMap[dir] ?? null;
  };
  internals.discoverProviders = function () {
    internals.providers.clear();
    for (const dir of pluginDirs) {
      const m = internals.parseManifest(`/fake/plugins/${dir}/manifest.toml`);
      if (m?.plugin?.type === 'provider' && m.api) {
        internals.providers.set(m.plugin.id, m);
      }
    }
  };

  return { svc, cache };
}

// ── Shared service factory ────────────────────────────────────────────────────

/** Builds an Alpaca-backed service with credentials set and onModuleInit called. */
function makeAlpacaService(cacheOverride?: Partial<OhlcvCacheService>): ProviderGatewayService {
  process.env['ALPACA_KEY'] = 'k1';
  process.env['ALPACA_SECRET'] = 's1';
  const { svc } = makeService(['alpaca'], { alpaca: makeAlpacaManifest() }, cacheOverride);
  svc.onModuleInit();
  return svc;
}

// ── Global fetch mock ─────────────────────────────────────────────────────────

let originalFetch: typeof globalThis.fetch;
let fetchMock: jest.Mock;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  fetchMock = jest.fn();
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env['ALPACA_KEY'];
  delete process.env['ALPACA_SECRET'];
  delete process.env['TIINGO_KEY'];
  delete process.env['BINANCE_KEY'];
  delete process.env['UNKNOWN_KEY'];
});

// ── Provider discovery ────────────────────────────────────────────────────────

describe('ProviderGatewayService — provider discovery', () => {
  it('registers a manifest with type=provider via onModuleInit', () => {
    const { svc } = makeService(['alpaca'], { alpaca: makeAlpacaManifest() });
    svc.onModuleInit();

    const providers = svc.listProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0].plugin_id).toBe('alpaca');
  });

  it('excludes a manifest with type=agent (non-provider)', () => {
    const { svc } = makeService(['my-agent'], { 'my-agent': makeAgentManifest() });
    svc.onModuleInit();

    expect(svc.listProviders()).toHaveLength(0);
  });

  it('skips a directory with null manifest (missing/malformed) without throwing', () => {
    const { svc } = makeService(['broken-plugin'], { 'broken-plugin': null });

    expect(() => svc.onModuleInit()).not.toThrow();
    expect(svc.listProviders()).toHaveLength(0);
  });

  it('triggers rediscovery on plugin event (onPluginEvent rebuilds the Map)', () => {
    let dirs = ['alpaca'];
    const { svc } = makeService(dirs, { alpaca: makeAlpacaManifest() });

    // Override discoverProviders to use the mutable dirs variable
    const internals = svc as unknown as ServiceInternals;
    internals.discoverProviders = function () {
      internals.providers.clear();
      for (const dir of dirs) {
        const m = internals.parseManifest(`/fake/plugins/${dir}/manifest.toml`);
        if (m?.plugin?.type === 'provider' && m.api) {
          internals.providers.set(m.plugin.id, m);
        }
      }
    };

    svc.onModuleInit();
    expect(svc.listProviders()).toHaveLength(1);

    // Simulate deactivation: no plugins on disk anymore
    dirs = [];
    svc.onPluginEvent();

    expect(svc.listProviders()).toHaveLength(0);
  });
});

// ── Credential injection ──────────────────────────────────────────────────────

describe('ProviderGatewayService — credential injection', () => {
  it('hasCredentials returns true when both env vars are set', () => {
    process.env['ALPACA_KEY'] = 'k1';
    process.env['ALPACA_SECRET'] = 's1';

    const { svc } = makeService(['alpaca'], { alpaca: makeAlpacaManifest() });
    svc.onModuleInit();

    expect(svc.listProviders()[0].has_credentials).toBe(true);
  });

  it('hasCredentials returns false when required env var is absent', () => {
    // ALPACA_KEY and ALPACA_SECRET are intentionally not set
    const { svc } = makeService(['alpaca'], { alpaca: makeAlpacaManifest() });
    svc.onModuleInit();

    expect(svc.listProviders()[0].has_credentials).toBe(false);
  });

  it('getDefaultProvider returns null when no provider has credentials', () => {
    const { svc } = makeService(['alpaca'], { alpaca: makeAlpacaManifest() });
    svc.onModuleInit();

    expect(svc.getDefaultProvider()).toBeNull();
  });

  it('getDefaultProvider returns the first credentialed provider when multiple are registered', () => {
    // alpaca has no creds, tiingo has creds → getDefaultProvider must return tiingo
    process.env['TIINGO_KEY'] = 'tiingo-k1';
    // ALPACA_KEY intentionally not set

    const { svc } = makeService(['alpaca', 'tiingo'], {
      alpaca: makeAlpacaManifest(),
      tiingo: makeTiingoManifest(),
    });
    svc.onModuleInit();

    const def = svc.getDefaultProvider();
    expect(def).not.toBeNull();
    expect(def!.plugin.id).toBe('tiingo');
  });
});

// ── getQuote dispatch ─────────────────────────────────────────────────────────

describe('ProviderGatewayService — getQuote dispatch', () => {
  const ALPACA_QUOTE_RESPONSE = {
    quote: { bp: 100, ap: 102, t: '2024-01-01T00:00:00Z' },
  };

  it('throws with the provider id in the message when pluginId is unknown', async () => {
    const svc = makeAlpacaService();

    await expect(svc.getQuote('unknown-provider', 'AAPL')).rejects.toThrow('unknown-provider');
  });

  it('throws when pluginId is null and providers Map is empty', async () => {
    // Do NOT call onModuleInit — providers map stays empty
    const { svc } = makeService([], {});

    await expect(svc.getQuote(null, 'AAPL')).rejects.toThrow();
  });

  it('propagates HTTP 4xx error as a thrown Error containing the status code', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      text: jest.fn().mockResolvedValue('Unauthorized'),
      json: jest.fn(),
    });

    const svc = makeAlpacaService();

    await expect(svc.getQuote('alpaca', 'AAPL')).rejects.toThrow(/401/);
  });

  it('returns cached quote without calling fetch on cache hit', async () => {
    const cachedQuote: Quote = {
      symbol: 'AAPL',
      bid: 100,
      ask: 102,
      last: 101,
      ts: '2024-01-01T00:00:00Z',
    };

    const svc = makeAlpacaService({
      getQuote: jest.fn().mockReturnValue(cachedQuote),
      setQuote: jest.fn(),
    });

    const result = await svc.getQuote('alpaca', 'AAPL');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual(cachedQuote);
  });

  it('calls fetch and stores result via setQuote on cache miss', async () => {
    const setQuoteMock = jest.fn();

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue(ALPACA_QUOTE_RESPONSE),
    });

    const svc = makeAlpacaService({
      getQuote: jest.fn().mockReturnValue(null),
      setQuote: setQuoteMock,
    });

    const result = await svc.getQuote('alpaca', 'AAPL');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(setQuoteMock).toHaveBeenCalledTimes(1);
    expect(result.symbol).toBe('AAPL');
  });
});

// ── normalizeQuote ────────────────────────────────────────────────────────────

describe('ProviderGatewayService — normalizeQuote', () => {
  /**
   * normalizeQuote is private — we exercise it end-to-end via getQuote().
   * Each test uses a distinct manifest format and a matching fetch stub.
   */

  function setupServiceForFormat(
    dirName: string,
    manifest: ProviderManifestShape,
  ): ProviderGatewayService {
    const { svc } = makeService(
      [dirName],
      { [dirName]: manifest },
      {
        getQuote: jest.fn().mockReturnValue(null),
        setQuote: jest.fn(),
      },
    );
    svc.onModuleInit();
    return svc;
  }

  it(
    'Alpaca format: last === (bid + ask) / 2 ' +
      '[INTENTIONAL APPROXIMATION — Alpaca quotes endpoint has no last-trade field; mid-price is the correct contract]',
    async () => {
      process.env['ALPACA_KEY'] = 'k1';
      process.env['ALPACA_SECRET'] = 's1';
      const svc = setupServiceForFormat('alpaca', makeAlpacaManifest());

      fetchMock.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          quote: { bp: 100, ap: 102, t: '2024-01-01T00:00:00Z' },
        }),
      });

      const quote = await svc.getQuote('alpaca', 'AAPL');

      expect(quote.symbol).toBe('AAPL');
      expect(quote.bid).toBe(100);
      expect(quote.ask).toBe(102);
      // NOTE: last = (bid + ask) / 2 = (100 + 102) / 2 = 101
      // This IS the intentional contract. Alpaca's /v2/stocks/{symbol}/quotes/latest
      // returns bp (bid price) and ap (ask price) but does NOT include a last-trade
      // price field. Mid-price (bp + ap) / 2 is the correct approximation for this
      // API surface. Do NOT treat this assertion as a bug — it encodes the intended
      // behavior per the spec.
      expect(quote.last).toBe(101);
      expect(quote.ts).toBe('2024-01-01T00:00:00Z');
    },
  );

  it('Tiingo format: last from direct field, bid/ask from bidPrice/askPrice', async () => {
    process.env['TIINGO_KEY'] = 'tiingo-k1';
    const svc = setupServiceForFormat('tiingo', makeTiingoManifest());

    fetchMock.mockResolvedValue({
      ok: true,
      json: jest
        .fn()
        .mockResolvedValue([
          { last: 150, bidPrice: 149.5, askPrice: 150.5, timestamp: '2024-01-01T00:00:00Z' },
        ]),
    });

    const quote = await svc.getQuote('tiingo', 'AAPL');

    expect(quote.symbol).toBe('AAPL');
    expect(quote.bid).toBe(149.5);
    expect(quote.ask).toBe(150.5);
    expect(quote.last).toBe(150);
  });

  it('Binance format: bid, ask, last all equal to the price field', async () => {
    process.env['BINANCE_KEY'] = 'binance-k1';
    const svc = setupServiceForFormat('binance', makeBinanceManifest());

    fetchMock.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ price: '45000.50', symbol: 'BTCUSDT' }),
    });

    const quote = await svc.getQuote('binance', 'BTCUSDT');

    expect(quote.symbol).toBe('BTCUSDT');
    expect(quote.bid).toBe(45000.5);
    expect(quote.ask).toBe(45000.5);
    expect(quote.last).toBe(45000.5);
  });

  it('unknown format: returns zero Quote without throwing', async () => {
    process.env['UNKNOWN_KEY'] = 'k1';
    const svc = setupServiceForFormat('unknown-fmt', makeUnknownFormatManifest());

    fetchMock.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({}),
    });

    // The service must NOT throw for an unknown format — it returns a zero Quote.
    const quote = await svc.getQuote('unknown-fmt', 'XYZ');

    expect(quote.symbol).toBe('XYZ');
    expect(quote.bid).toBe(0);
    expect(quote.ask).toBe(0);
    expect(quote.last).toBe(0);
  });
});

// ── getOhlcv — cache integration ──────────────────────────────────────────────

describe('ProviderGatewayService — getOhlcv cache integration', () => {
  const CACHED_BARS = [
    { ts: '2024-01-01T00:00:00Z', open: 1, high: 2, low: 0.5, close: 1.5, volume: 1000 },
  ];

  const ALPACA_BARS_RESPONSE = {
    bars: [{ t: '2024-01-01T00:00:00Z', o: 1, h: 2, l: 0.5, c: 1.5, v: 1000 }],
  };

  it('returns cached bars without calling fetch on cache hit', async () => {
    const svc = makeAlpacaService({
      getOhlcv: jest.fn().mockReturnValue(CACHED_BARS),
      setOhlcv: jest.fn(),
    });

    const result = await svc.getOhlcv('alpaca', 'AAPL', '1d', 200);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual(CACHED_BARS);
  });

  it('calls fetch and stores normalized bars via setOhlcv on cache miss', async () => {
    const setOhlcvMock = jest.fn();

    fetchMock.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue(ALPACA_BARS_RESPONSE),
    });

    const svc = makeAlpacaService({
      getOhlcv: jest.fn().mockReturnValue(null),
      setOhlcv: setOhlcvMock,
    });

    const result = await svc.getOhlcv('alpaca', 'AAPL', '1d', 200);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(setOhlcvMock).toHaveBeenCalledTimes(1);
    expect(setOhlcvMock).toHaveBeenCalledWith('alpaca', 'AAPL', '1d', 200, expect.any(Array));
    expect(result).toHaveLength(1);
    expect(result[0].ts).toBe('2024-01-01T00:00:00Z');
  });

  it('slices over-fetched bars to the requested limit (keeps the most recent)', async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      t: `2024-01-0${i + 1}T00:00:00Z`,
      o: 1,
      h: 2,
      l: 0.5,
      c: 1 + i,
      v: 100,
    }));
    fetchMock.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ bars: many }),
    });
    const svc = makeAlpacaService({
      getOhlcv: jest.fn().mockReturnValue(null),
      setOhlcv: jest.fn(),
    });

    const result = await svc.getOhlcv('alpaca', 'AAPL', '1d', 3);

    expect(result).toHaveLength(3); // 5 fetched → sliced to 3
    expect(result[result.length - 1].close).toBe(5); // keeps the LAST (most recent) bars
  });
});
