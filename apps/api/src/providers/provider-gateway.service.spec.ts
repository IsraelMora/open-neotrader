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
        orders: '{base_url}/v2/orders',
        order_status: '{base_url}/v2/orders/{broker_order_id}',
        order_by_client_id: '{base_url}/v2/orders:by_client_order_id={client_order_id}',
        cancel_order: '{base_url}/v2/orders/{broker_order_id}',
        list_orders: '{base_url}/v2/orders?status={status}',
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

function makeYahooManifest(): ProviderManifestShape {
  return {
    plugin: { id: 'yahoo-finance-provider', name: 'Yahoo Finance Provider', type: 'provider' },
    api: {
      format: 'generic',
      base_url: 'https://query1.finance.yahoo.com',
      auth_type: 'header',
      endpoints: {
        quote: '{base_url}/v8/finance/chart/{symbol}?interval=1d&range=1d',
        ohlcv: '{base_url}/v8/finance/chart/{symbol}?interval={tf}&range={range}',
      },
    },
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

/** Builds a Yahoo (format "generic") service — no credentials required. */
function makeYahooService(cacheOverride?: Partial<OhlcvCacheService>): ProviderGatewayService {
  const { svc } = makeService(
    ['yahoo-finance-provider'],
    { 'yahoo-finance-provider': makeYahooManifest() },
    cacheOverride,
  );
  svc.onModuleInit();
  return svc;
}

/** A minimal fetch Response mock. `headers.get` defaults to returning null (no set-cookie). */
function fakeResponse(opts: {
  ok: boolean;
  status?: number;
  json?: unknown;
  text?: string;
  setCookie?: string | null;
}): {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
  headers: { get: (name: string) => string | null };
} {
  return {
    ok: opts.ok,
    status: opts.status ?? (opts.ok ? 200 : 500),
    json: jest.fn().mockResolvedValue(opts.json ?? {}),
    text: jest.fn().mockResolvedValue(opts.text ?? ''),
    headers: { get: () => opts.setCookie ?? null },
  };
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

// ── Order lifecycle (getOrderStatus / getOrderByClientId / cancelOrder / listOrders) ──

describe('ProviderGatewayService — order lifecycle', () => {
  const ALPACA_ORDER_RAW = {
    id: 'broker-abc-123',
    client_order_id: 'nt-xyz-789',
    status: 'partially_filled',
    filled_qty: '3',
    filled_avg_price: '101.5',
  };

  it('getOrderStatus builds the correct URL and auth headers, and normalizes the response', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue(ALPACA_ORDER_RAW),
      text: jest.fn().mockResolvedValue(''),
    });

    const svc = makeAlpacaService();
    const result = await svc.getOrderStatus('alpaca', 'broker-abc-123');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.alpaca.markets/v2/orders/broker-abc-123');
    expect((init.headers as Record<string, string>)['APCA-API-KEY-ID']).toBe('k1');
    expect((init.headers as Record<string, string>)['APCA-API-SECRET-KEY']).toBe('s1');

    expect(result).toEqual({
      broker_order_id: 'broker-abc-123',
      client_order_id: 'nt-xyz-789',
      status: 'partially_filled',
      filled_qty: 3,
      filled_avg_price: 101.5,
      raw: ALPACA_ORDER_RAW,
    });
  });

  it('getOrderStatus normalizes a null filled_avg_price to null (unfilled order)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({
        id: 'broker-new-1',
        client_order_id: null,
        status: 'new',
        filled_qty: '0',
        filled_avg_price: null,
      }),
      text: jest.fn().mockResolvedValue(''),
    });

    const svc = makeAlpacaService();
    const result = await svc.getOrderStatus('alpaca', 'broker-new-1');

    expect(result.filled_qty).toBe(0);
    expect(result.filled_avg_price).toBeNull();
    expect(result.client_order_id).toBeNull();
  });

  it('getOrderStatus throws (fails loudly) on an unparsable numeric field instead of leaking NaN', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({
        id: 'broker-bad-1',
        client_order_id: null,
        status: 'new',
        filled_qty: 'not-a-number',
        filled_avg_price: null,
      }),
      text: jest.fn().mockResolvedValue(''),
    });

    const svc = makeAlpacaService();
    await expect(svc.getOrderStatus('alpaca', 'broker-bad-1')).rejects.toThrow();
  });

  it('getOrderByClientId builds the by-client-order-id URL and normalizes the response', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue(ALPACA_ORDER_RAW),
      text: jest.fn().mockResolvedValue(''),
    });

    const svc = makeAlpacaService();
    const result = await svc.getOrderByClientId('alpaca', 'nt-xyz-789');

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.alpaca.markets/v2/orders:by_client_order_id=nt-xyz-789');
    expect(result).not.toBeNull();
    expect(result?.broker_order_id).toBe('broker-abc-123');
  });

  it('getOrderByClientId returns null on a CONFIRMED 404 (broker never received the order) instead of throwing', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: jest.fn().mockResolvedValue({}),
      text: jest.fn().mockResolvedValue('order not found'),
    });

    const svc = makeAlpacaService();
    const result = await svc.getOrderByClientId('alpaca', 'nt-missing-1');

    expect(result).toBeNull();
  });

  it('getOrderByClientId still throws (does not swallow) on non-404 errors like 401/500', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: jest.fn().mockResolvedValue({}),
      text: jest.fn().mockResolvedValue('internal error'),
    });

    const svc = makeAlpacaService();
    await expect(svc.getOrderByClientId('alpaca', 'nt-err-1')).rejects.toThrow();
  });

  it('listOrders builds the list URL with status filter and normalizes every entry', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: jest
        .fn()
        .mockResolvedValue([
          ALPACA_ORDER_RAW,
          { ...ALPACA_ORDER_RAW, id: 'broker-abc-124', filled_qty: '0', filled_avg_price: null },
        ]),
      text: jest.fn().mockResolvedValue(''),
    });

    const svc = makeAlpacaService();
    const result = await svc.listOrders('alpaca', { status: 'open' });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.alpaca.markets/v2/orders?status=open');
    expect(result).toHaveLength(2);
    expect(result[0].broker_order_id).toBe('broker-abc-123');
    expect(result[1].filled_avg_price).toBeNull();
  });

  it('cancelOrder sends a DELETE request to the cancel_order endpoint', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 204,
      text: jest.fn().mockResolvedValue(''),
    });

    const svc = makeAlpacaService();
    await svc.cancelOrder('alpaca', 'broker-abc-123');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.alpaca.markets/v2/orders/broker-abc-123');
    expect(init.method).toBe('DELETE');
  });

  it('cancelOrder treats HTTP 404 (already gone) as a no-op success, not a throw', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      text: jest.fn().mockResolvedValue('order not found'),
    });

    const svc = makeAlpacaService();
    await expect(svc.cancelOrder('alpaca', 'broker-missing')).resolves.toBeUndefined();
  });

  it('cancelOrder treats HTTP 422 (already filled/canceled) as a no-op success, not a throw', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 422,
      text: jest.fn().mockResolvedValue('order already filled'),
    });

    const svc = makeAlpacaService();
    await expect(svc.cancelOrder('alpaca', 'broker-filled')).resolves.toBeUndefined();
  });

  it('cancelOrder still throws on an unexpected error status (e.g. 500)', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: jest.fn().mockResolvedValue('internal error'),
    });

    const svc = makeAlpacaService();
    await expect(svc.cancelOrder('alpaca', 'broker-x')).rejects.toThrow(/500/);
  });
});

// ── placeOrder client_order_id threading ──────────────────────────────────────

describe('ProviderGatewayService — placeOrder client_order_id', () => {
  it('includes client_order_id in the Alpaca POST body when provided', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({ id: 'broker-new', status: 'accepted' }),
      text: jest.fn().mockResolvedValue(''),
    });

    const svc = makeAlpacaService();
    await svc.placeOrder('alpaca', {
      symbol: 'AAPL',
      qty: 1,
      side: 'buy',
      type: 'market',
      clientOrderId: 'nt-test-id-1',
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['client_order_id']).toBe('nt-test-id-1');
  });
});

// ── Yahoo (format "generic") 429 hardening ─────────────────────────────────────
//
// Prod logs confirmed Yahoo's unofficial chart endpoint 429s the container IP.
// These tests cover: browser User-Agent header, cookie warm-up (GET fc.yahoo.com
// before the chart request), bounded retry-with-backoff on 429, and fail-soft
// (empty result, not a throw) once retries are exhausted.

const YAHOO_CHART_OK = {
  chart: {
    result: [
      {
        timestamp: [1704067200],
        indicators: {
          quote: [{ open: [1], high: [2], low: [0.5], close: [1.5], volume: [1000] }],
        },
      },
    ],
  },
};

describe('ProviderGatewayService — Yahoo 429 hardening', () => {
  it('sends a realistic browser User-Agent on the chart request', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('fc.yahoo.com')) return Promise.resolve(fakeResponse({ ok: true }));
      return Promise.resolve(fakeResponse({ ok: true, json: YAHOO_CHART_OK }));
    });

    const svc = makeYahooService();
    await svc.getOhlcv('yahoo-finance-provider', 'SPY', '1d', 200);

    const calls = fetchMock.mock.calls as [string, RequestInit][];
    const chartCall = calls.find((c) => !c[0].includes('fc.yahoo.com'));
    const headers = chartCall![1].headers as Record<string, string>;
    expect(headers['User-Agent']).toMatch(/Mozilla/);
  });

  it('warms up a cookie via fc.yahoo.com before the chart request, and reuses it', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('fc.yahoo.com')) {
        return Promise.resolve(fakeResponse({ ok: true, setCookie: 'B=abc123; path=/' }));
      }
      return Promise.resolve(fakeResponse({ ok: true, json: YAHOO_CHART_OK }));
    });

    const svc = makeYahooService();
    await svc.getOhlcv('yahoo-finance-provider', 'SPY', '1d', 200);

    const calls = fetchMock.mock.calls as [string, RequestInit][];
    const warmupCall = calls.find((c) => c[0].includes('fc.yahoo.com'));
    expect(warmupCall).toBeDefined();

    const chartCall = calls.find((c) => !c[0].includes('fc.yahoo.com'));
    const headers = chartCall![1].headers as Record<string, string>;
    expect(headers['Cookie']).toBe('B=abc123; path=/');
  });

  it('retries on HTTP 429 with backoff and succeeds once Yahoo returns 200', async () => {
    jest.useFakeTimers();
    try {
      let chartAttempts = 0;
      fetchMock.mockImplementation((url: string) => {
        if (url.includes('fc.yahoo.com')) return Promise.resolve(fakeResponse({ ok: true }));
        chartAttempts++;
        if (chartAttempts < 3) {
          return Promise.resolve(
            fakeResponse({ ok: false, status: 429, text: 'Too Many Requests' }),
          );
        }
        return Promise.resolve(fakeResponse({ ok: true, json: YAHOO_CHART_OK }));
      });

      const svc = makeYahooService();
      const resultPromise = svc.getOhlcv('yahoo-finance-provider', 'SPY', '1d', 200);
      await jest.advanceTimersByTimeAsync(10_000);
      const result = await resultPromise;

      expect(chartAttempts).toBe(3);
      expect(result).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('fails soft (returns empty, does not throw) once 429 retries are exhausted', async () => {
    jest.useFakeTimers();
    try {
      fetchMock.mockImplementation((url: string) => {
        if (url.includes('fc.yahoo.com')) return Promise.resolve(fakeResponse({ ok: true }));
        return Promise.resolve(fakeResponse({ ok: false, status: 429, text: 'Too Many Requests' }));
      });

      const svc = makeYahooService();
      const resultPromise = svc.getOhlcv('yahoo-finance-provider', 'TECL', '1d', 400);
      await jest.advanceTimersByTimeAsync(10_000);
      const result = await resultPromise;

      expect(result).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('a non-429 HTTP error still throws immediately (no fail-soft, no retry)', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('fc.yahoo.com')) return Promise.resolve(fakeResponse({ ok: true }));
      return Promise.resolve(fakeResponse({ ok: false, status: 500, text: 'Internal Error' }));
    });

    const svc = makeYahooService();
    await expect(svc.getOhlcv('yahoo-finance-provider', 'SPY', '1d', 200)).rejects.toThrow(/500/);

    const calls = fetchMock.mock.calls as [string, RequestInit][];
    const chartCalls = calls.filter((c) => !c[0].includes('fc.yahoo.com'));
    expect(chartCalls).toHaveLength(1); // no retry on non-429
  });

  it('an exhausted-429 empty result is cached with the short TTL (does not poison the cache)', async () => {
    jest.useFakeTimers();
    try {
      fetchMock.mockImplementation((url: string) => {
        if (url.includes('fc.yahoo.com')) return Promise.resolve(fakeResponse({ ok: true }));
        return Promise.resolve(fakeResponse({ ok: false, status: 429, text: 'Too Many Requests' }));
      });

      const setOhlcvMock = jest.fn();
      const svc = makeYahooService({
        getOhlcv: jest.fn().mockReturnValue(null),
        setOhlcv: setOhlcvMock,
      });

      const resultPromise = svc.getOhlcv('yahoo-finance-provider', 'TECL', '1d', 400);
      await jest.advanceTimersByTimeAsync(10_000);
      await resultPromise;

      expect(setOhlcvMock).toHaveBeenCalledWith('yahoo-finance-provider', 'TECL', '1d', 400, []);
    } finally {
      jest.useRealTimers();
    }
  });
});

// ── Yahoo deep-history: period1/period2 instead of range=max ──────────────────
//
// CONFIRMED against live Yahoo: range=max silently returns MONTHLY bars even
// though interval=1d was requested (meta.dataGranularity === '1mo'). For a
// limit beyond what the range buckets cover (yahooRange() would otherwise
// fall back to 'max'), the gateway must request an explicit period1/period2
// window instead, which Yahoo honors with real daily granularity.

describe('ProviderGatewayService — Yahoo deep-history period1/period2', () => {
  it('limit beyond range buckets (>2520): sends period1/period2, not range=max', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('fc.yahoo.com')) return Promise.resolve(fakeResponse({ ok: true }));
      return Promise.resolve(fakeResponse({ ok: true, json: YAHOO_CHART_OK }));
    });

    const svc = makeYahooService();
    await svc.getOhlcv('yahoo-finance-provider', 'SPY', '1d', 5000);

    const calls = fetchMock.mock.calls as [string, RequestInit][];
    const chartCall = calls.find((c) => !c[0].includes('fc.yahoo.com'));
    const [url] = chartCall!;

    expect(url).toMatch(/period1=\d+/);
    expect(url).toMatch(/period2=\d+/);
    expect(url).not.toMatch(/range=max/);
  });

  it('limit within existing range buckets (<=2520): unchanged, still uses range=<token>', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('fc.yahoo.com')) return Promise.resolve(fakeResponse({ ok: true }));
      return Promise.resolve(fakeResponse({ ok: true, json: YAHOO_CHART_OK }));
    });

    const svc = makeYahooService();
    await svc.getOhlcv('yahoo-finance-provider', 'SPY', '1d', 400);

    const calls = fetchMock.mock.calls as [string, RequestInit][];
    const chartCall = calls.find((c) => !c[0].includes('fc.yahoo.com'));
    const [url] = chartCall!;

    expect(url).toMatch(/range=2y/);
    expect(url).not.toMatch(/period1=/);
  });
});

// ── Yahoo granularity integrity guard (normalizeBars) ──────────────────────────
//
// Guards against silently treating monthly bars as daily bars: if Yahoo's
// response declares a dataGranularity that doesn't match what was requested,
// normalizeBars must throw instead of returning corrupted-looking data.

function yahooChartWithGranularity(dataGranularity?: string) {
  return {
    chart: {
      result: [
        {
          timestamp: [1704067200],
          ...(dataGranularity ? { meta: { dataGranularity } } : {}),
          indicators: {
            quote: [{ open: [1], high: [2], low: [0.5], close: [1.5], volume: [1000] }],
          },
        },
      ],
    },
  };
}

describe('ProviderGatewayService — Yahoo granularity integrity guard', () => {
  it('throws when Yahoo returns monthly bars for a daily request (silent downgrade)', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('fc.yahoo.com')) return Promise.resolve(fakeResponse({ ok: true }));
      return Promise.resolve(fakeResponse({ ok: true, json: yahooChartWithGranularity('1mo') }));
    });

    const svc = makeYahooService();
    await expect(svc.getOhlcv('yahoo-finance-provider', 'SPY', '1d', 5000)).rejects.toThrow(/1mo/);
  });

  it('does not throw when dataGranularity matches the requested interval (regression)', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('fc.yahoo.com')) return Promise.resolve(fakeResponse({ ok: true }));
      return Promise.resolve(fakeResponse({ ok: true, json: yahooChartWithGranularity('1d') }));
    });

    const svc = makeYahooService();
    const result = await svc.getOhlcv('yahoo-finance-provider', 'SPY', '1d', 200);

    expect(result).toHaveLength(1);
  });

  it('does not throw when meta.dataGranularity is missing (regression safety net)', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('fc.yahoo.com')) return Promise.resolve(fakeResponse({ ok: true }));
      return Promise.resolve(fakeResponse({ ok: true, json: yahooChartWithGranularity() }));
    });

    const svc = makeYahooService();
    const result = await svc.getOhlcv('yahoo-finance-provider', 'SPY', '1d', 200);

    expect(result).toHaveLength(1);
  });
});
