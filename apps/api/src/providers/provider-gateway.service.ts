/**
 * ProviderGatewayService — único punto de salida a internet para plugins de tipo "provider".
 *
 * Cada provider plugin declara su API en manifest.toml [api] + [api.endpoints].
 * Este servicio lee esa declaración, inyecta credenciales desde process.env,
 * y hace la llamada HTTP. Ningún plugin accede a la red directamente.
 *
 * Formato de respuesta normalizado a OhlcvBar[] y Quote para que los hooks
 * Python del sandbox reciban datos estándar independientemente del broker.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import * as fs from 'fs';
import * as path from 'path';
import { OhlcvCacheService } from './ohlcv-cache.service';

// ── Tipos públicos ────────────────────────────────────────────────────────────

export interface OhlcvBar {
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap?: number;
}

export interface Quote {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  ts: string;
}

export interface ProviderStatus {
  plugin_id: string;
  name: string;
  active: boolean;
  format: string;
  has_credentials: boolean;
}

export interface Position {
  symbol: string;
  qty: number; // unidades (positivo=long, negativo=short)
  avg_entry: number; // precio medio de entrada
  market_value: number; // valor de mercado actual en USD
  unrealized_pnl: number; // P&L no realizado en USD
  side: 'long' | 'short';
}

export interface Portfolio {
  provider_id: string;
  equity: number; // valor total de la cartera (cash + posiciones)
  cash: number; // efectivo disponible
  buying_power: number; // poder de compra efectivo
  positions: Position[];
  total_market_value: number; // Σ(market_value de posiciones abiertas)
  total_pnl: number; // Σ(unrealized_pnl)
  ts: string;
}

/** Normalized broker order status, independent of the underlying provider's raw response shape. */
export interface OrderStatusResult {
  broker_order_id: string;
  client_order_id: string | null;
  status: string;
  filled_qty: number;
  filled_avg_price: number | null;
  raw: unknown;
}

// ── Mapa de timeframes de la plataforma a formato por provider ────────────────

const TF_ALPACA: Record<string, string> = {
  '1m': '1Min',
  '5m': '5Min',
  '15m': '15Min',
  '30m': '30Min',
  '1h': '1Hour',
  '4h': '4Hour',
  '1d': '1Day',
  '1w': '1Week',
  '1mo': '1Month',
  '1Day': '1Day',
  '1Min': '1Min',
  '5Min': '5Min',
};

const TF_TIINGO: Record<string, string> = {
  '1m': '1min',
  '5m': '5min',
  '15m': '15min',
  '30m': '30min',
  '1h': '60min',
  '1d': 'daily',
  '1w': 'weekly',
  '1mo': 'monthly',
  '1Day': 'daily',
  '1Min': '1min',
};

const TF_CCXT: Record<string, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1d',
  '1w': '1w',
  '1mo': '1M',
};

const TF_BINANCE: Record<string, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1d',
  '1w': '1w',
  '1mo': '1M',
  '1Day': '1d',
  '1Min': '1m',
  '5Min': '5m',
};

// Yahoo Finance (format "generic"). Valid intervals per Yahoo's chart API:
// 1m,2m,5m,15m,30m,60m,90m,1h,4h,1d,5d,1wk,1mo,3mo. Without this map the gateway
// fell back to TF_ALPACA and sent "1Day", which Yahoo rejects with HTTP 400.
const TF_GENERIC: Record<string, string> = {
  '1m': '1m',
  '2m': '2m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1d',
  '5d': '5d',
  '1w': '1wk',
  '1mo': '1mo',
  '3mo': '3mo',
  '1Day': '1d',
  '1Min': '1m',
};

const TIMEFRAME_MAPS: Record<string, Record<string, string>> = {
  alpaca: TF_ALPACA,
  tiingo: TF_TIINGO,
  ccxt: TF_CCXT,
  binance: TF_BINANCE,
  generic: TF_GENERIC,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Safely coerces an unknown API value to string (never produces "[object Object]"). */
function toStr(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

// ── Servicio ──────────────────────────────────────────────────────────────────

@Injectable()
export class ProviderGatewayService implements OnModuleInit {
  private readonly log = new Logger(ProviderGatewayService.name);

  /** Cache de manifests de providers activos: pluginId → parsed manifest */
  private providers = new Map<string, ProviderManifest>();

  constructor(private readonly cache: OhlcvCacheService) {}

  onModuleInit() {
    this.discoverProviders();
  }

  @OnEvent('plugin.activated')
  @OnEvent('plugin.deactivated')
  onPluginEvent() {
    this.discoverProviders();
  }

  // ── Descubrimiento ────────────────────────────────────────────────────────

  private discoverProviders() {
    const pluginsRoot = this.resolvePluginsRoot();
    if (!pluginsRoot) return;

    this.providers.clear();
    try {
      const dirs = fs.readdirSync(pluginsRoot);
      for (const dir of dirs) {
        const manifestPath = path.join(pluginsRoot, dir, 'manifest.toml');
        if (!fs.existsSync(manifestPath)) continue;
        const manifest = this.parseManifest(manifestPath);
        if (manifest?.plugin?.type === 'provider' && manifest.api) {
          this.providers.set(manifest.plugin.id, manifest);
          this.log.debug(`Provider registrado: ${manifest.plugin.id}`);
        }
      }
    } catch (err) {
      this.log.warn(`Error descubriendo providers: ${err}`);
    }
  }

  private resolvePluginsRoot(): string | null {
    const candidates = [
      path.resolve(process.cwd(), '../../plugins'),
      path.resolve(process.cwd(), '../plugins'),
      path.resolve(process.cwd(), 'plugins'),
    ];
    return candidates.find((p) => fs.existsSync(p)) ?? null;
  }

  // ── API pública ───────────────────────────────────────────────────────────

  /** Lista todos los providers activos con su estado de credenciales. */
  listProviders(): ProviderStatus[] {
    return Array.from(this.providers.entries()).map(([id, m]) => ({
      plugin_id: id,
      name: m.plugin.name,
      active: true,
      format: m.api.format,
      has_credentials: this.hasCredentials(m),
    }));
  }

  /** Proveedor activo disponible con credenciales (el primero que encuentre) */
  getDefaultProvider(): ProviderManifest | null {
    for (const m of this.providers.values()) {
      if (this.hasCredentials(m)) return m;
    }
    return null;
  }

  /** Obtiene velas OHLCV normalizadas para un símbolo y timeframe, con caché integrado. */
  async getOhlcv(
    pluginId: string | null,
    symbol: string,
    timeframe: string,
    limit = 200,
  ): Promise<OhlcvBar[]> {
    const manifest = this.resolveManifest(pluginId);
    const providerId = manifest.plugin.id;

    // Intentar devolver desde caché
    const cached = this.cache.getOhlcv(providerId, symbol, timeframe, limit);
    if (cached) {
      this.log.debug(`Cache HIT: ${providerId}:${symbol}:${timeframe}:${limit}`);
      return cached;
    }

    const fmt = manifest.api.format;
    const tf = (TIMEFRAME_MAPS[fmt] ?? TF_ALPACA)[timeframe] ?? timeframe;
    const isIntraday = ['1m', '5m', '15m', '30m', '1h', '4h', '1Min', '5Min', '15Min'].includes(
      timeframe,
    );

    let endpointKey = 'ohlcv';
    if (fmt === 'tiingo' && isIntraday) endpointKey = 'ohlcv_intraday';

    const startDate = this.nDaysAgo(limit + 15);
    const raw = await this.request(manifest, endpointKey, {
      symbol,
      tf,
      limit,
      start_date: startDate,
      // Yahoo (generic) takes a discrete `range`, not a bar count. Harmless for
      // other providers whose URL templates don't reference {range}.
      range: this.yahooRange(limit),
    });

    const bars = this.normalizeBars(raw, fmt);
    // Honor the requested bar count: providers like Yahoo only accept a coarse `range`
    // bucket and over-fetch, so slice to the LAST `limit` bars (most recent).
    const limited = limit > 0 && bars.length > limit ? bars.slice(-limit) : bars;
    this.cache.setOhlcv(providerId, symbol, timeframe, limit, limited);
    return limited;
  }

  /** Obtiene la cotización en tiempo real (bid/ask/last) para un símbolo, con caché. */
  async getQuote(pluginId: string | null, symbol: string): Promise<Quote> {
    const manifest = this.resolveManifest(pluginId);
    const providerId = manifest.plugin.id;

    const cached = this.cache.getQuote(providerId, symbol);
    if (cached) return cached;

    const raw = await this.request(manifest, 'quote', { symbol });
    const quote = this.normalizeQuote(raw, manifest.api.format, symbol);
    this.cache.setQuote(providerId, symbol, quote);
    return quote;
  }

  /**
   * Obtiene noticias financieras para un símbolo/query.
   * Requiere un provider con endpoint "headlines" declarado en manifest.toml (e.g. newsapi).
   * Retorna array de artículos en formato normalizado.
   */
  async getNews(
    pluginId: string | null,
    query: string,
    hoursBack = 24,
    limit = 10,
  ): Promise<
    { title: string; description: string; source: string; publishedAt: string; url: string }[]
  > {
    const manifest = this.resolveManifest(pluginId);
    const fromDate = new Date(Date.now() - hoursBack * 3600 * 1000).toISOString().split('T')[0];

    const raw = await this.request(manifest, 'headlines', {
      query: encodeURIComponent(query),
      limit,
      from_date: fromDate,
    });

    const data = raw as { articles?: Record<string, unknown>[] };
    return (data.articles ?? []).slice(0, limit).map((a) => ({
      title: toStr(a['title']),
      description: toStr(a['description']),
      source:
        typeof a['source'] === 'object'
          ? toStr((a['source'] as Record<string, unknown>)['name'])
          : toStr(a['source']),
      publishedAt: toStr(a['publishedAt']),
      url: toStr(a['url']),
    }));
  }

  /** Obtiene equity, cash, buying power y posiciones abiertas del broker. */
  async getPortfolio(pluginId: string | null): Promise<Portfolio> {
    const manifest = this.resolveManifest(pluginId);
    const providerId = manifest.plugin.id;
    const fmt = manifest.api.format;

    if (!manifest.api.endpoints['portfolio'] && !manifest.api.endpoints['positions']) {
      return {
        provider_id: providerId,
        equity: 0,
        cash: 0,
        buying_power: 0,
        positions: [],
        total_market_value: 0,
        total_pnl: 0,
        ts: new Date().toISOString(),
      };
    }

    const [accountRaw, positionsRaw] = await Promise.all([
      manifest.api.endpoints['portfolio']
        ? this.request(manifest, 'portfolio', {}).catch(() => null)
        : Promise.resolve(null),
      manifest.api.endpoints['positions']
        ? this.request(manifest, 'positions', {}).catch(() => [])
        : Promise.resolve([]),
    ]);

    return this.normalizePortfolio(accountRaw, positionsRaw, fmt, providerId);
  }

  private normalizePortfolio(
    account: unknown,
    positionsRaw: unknown,
    format: string,
    providerId: string,
  ): Portfolio {
    const ts = new Date().toISOString();
    let equity = 0,
      cash = 0,
      buying_power = 0;
    let positions: Position[] = [];

    if (format === 'alpaca') {
      const acc = account as {
        equity?: string;
        cash?: string;
        buying_power?: string;
        non_marginable_buying_power?: string;
      } | null;
      equity = Number(acc?.equity ?? 0);
      cash = Number(acc?.cash ?? 0);
      buying_power = Number(acc?.buying_power ?? 0);

      const rows = Array.isArray(positionsRaw)
        ? (positionsRaw as {
            symbol: string;
            qty: string;
            avg_entry_price: string;
            market_value: string;
            unrealized_pl: string;
            side: string;
          }[])
        : [];
      positions = rows.map((p) => ({
        symbol: p.symbol,
        qty: Number(p.qty),
        avg_entry: Number(p.avg_entry_price),
        market_value: Number(p.market_value),
        unrealized_pnl: Number(p.unrealized_pl),
        side: p.side === 'short' ? 'short' : 'long',
      }));
    } else if (format === 'binance') {
      const acc = account as { totalWalletBalance?: string; availableBalance?: string } | null;
      equity = Number(acc?.totalWalletBalance ?? 0);
      cash = Number(acc?.availableBalance ?? 0);
      buying_power = cash;

      const rows = Array.isArray(positionsRaw)
        ? (positionsRaw as {
            symbol: string;
            positionAmt: string;
            entryPrice: string;
            unrealizedProfit: string;
            notional?: string;
          }[])
        : [];
      positions = rows
        .filter((p) => Number(p.positionAmt) !== 0)
        .map((p) => {
          const qty = Number(p.positionAmt);
          return {
            symbol: p.symbol,
            qty,
            avg_entry: Number(p.entryPrice),
            market_value: Math.abs(Number(p.notional ?? 0)),
            unrealized_pnl: Number(p.unrealizedProfit),
            side: qty >= 0 ? 'long' : 'short',
          };
        });
    }

    const total_market_value = positions.reduce((s, p) => s + p.market_value, 0);
    const total_pnl = positions.reduce((s, p) => s + p.unrealized_pnl, 0);

    return {
      provider_id: providerId,
      equity,
      cash,
      buying_power,
      positions,
      total_market_value,
      total_pnl,
      ts,
    };
  }

  /** Verifica la conectividad y credenciales del provider haciendo una cotización de prueba. */
  async testConnection(pluginId: string): Promise<{ ok: boolean; message: string }> {
    try {
      const manifest = this.resolveManifest(pluginId);
      if (!this.hasCredentials(manifest)) {
        return { ok: false, message: 'Credenciales no configuradas' };
      }
      const testSymbol = manifest.api.format === 'binance' ? 'BTCUSDT' : 'AAPL';
      await this.getQuote(pluginId, testSymbol);
      return { ok: true, message: `Conexión verificada con ${manifest.plugin.name}` };
    } catch (err) {
      return { ok: false, message: String(err) };
    }
  }

  /**
   * Ejecuta una orden en el broker.
   * Solo disponible en providers que declaren `[api.endpoints] orders`.
   * Para Binance: firma HMAC SHA256 automáticamente.
   */
  async placeOrder(
    pluginId: string | null,
    order: {
      symbol: string;
      qty: number;
      side: 'buy' | 'sell';
      type: 'market' | 'limit';
      limitPrice?: number;
      timeInForce?: string;
      /** Idempotency key for the broker. Required so retries never double-submit. */
      clientOrderId: string;
    },
  ): Promise<Record<string, unknown>> {
    const manifest = this.resolveManifest(pluginId);
    if (!manifest.api.endpoints['orders']) {
      throw new Error(`Provider ${manifest.plugin.id}: no soporta ejecución de órdenes`);
    }

    const fmt = manifest.api.format;
    if (fmt === 'alpaca') {
      return this.placeAlpacaOrder(manifest, order);
    }
    if (fmt === 'binance') {
      return this.placeBinanceOrder(manifest, order);
    }
    throw new Error(`Ejecución de órdenes no implementada para formato "${fmt}"`);
  }

  private async placeAlpacaOrder(
    manifest: ProviderManifest,
    order: {
      symbol: string;
      qty: number;
      side: string;
      type: string;
      limitPrice?: number;
      timeInForce?: string;
      clientOrderId?: string;
    },
  ): Promise<Record<string, unknown>> {
    const api = manifest.api;
    const authKey = api.auth_key_env ? (process.env[api.auth_key_env] ?? '') : '';
    const authSecret = api.auth_secret_env ? (process.env[api.auth_secret_env] ?? '') : '';
    const url = `${api.base_url}/v2/orders`;

    const body: Record<string, unknown> = {
      symbol: order.symbol,
      qty: order.qty,
      side: order.side,
      type: order.type,
      time_in_force: order.timeInForce ?? 'day',
    };
    if (order.limitPrice != null) body['limit_price'] = order.limitPrice;
    if (order.clientOrderId != null) body['client_order_id'] = order.clientOrderId;

    const res = await globalThis.fetch(url, {
      method: 'POST',
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
      headers: {
        'Content-Type': 'application/json',
        [api.auth_key_header ?? 'APCA-API-KEY-ID']: authKey,
        [api.auth_secret_header ?? 'APCA-API-SECRET-KEY']: authSecret,
      },
    });
    if (!res.ok) {
      throw new Error(`Alpaca order ${res.status}: ${await res.text()}`);
    }
    return res.json() as Promise<Record<string, unknown>>;
  }

  private async placeBinanceOrder(
    manifest: ProviderManifest,
    order: {
      symbol: string;
      qty: number;
      side: string;
      type: string;
      limitPrice?: number;
      timeInForce?: string;
    },
  ): Promise<Record<string, unknown>> {
    const api = manifest.api;
    const apiKey = api.auth_key_env ? (process.env[api.auth_key_env] ?? '') : '';
    const apiSecret = api.auth_secret_env ? (process.env[api.auth_secret_env] ?? '') : '';

    const params: Record<string, string> = {
      symbol: order.symbol.replace('/', ''),
      side: order.side.toUpperCase(),
      type: order.type === 'limit' ? 'LIMIT' : 'MARKET',
      quantity: String(order.qty),
      timestamp: String(Date.now()),
      recvWindow: '5000',
    };
    if (order.type === 'limit' && order.limitPrice != null) {
      params['price'] = String(order.limitPrice);
      params['timeInForce'] = order.timeInForce?.toUpperCase() ?? 'GTC';
    }

    // HMAC SHA256 signature requerida por Binance
    const queryString = new URLSearchParams(params).toString();
    const signature = await this.hmacSha256(queryString, apiSecret);
    const url = `${api.base_url}/api/v3/order?${queryString}&signature=${signature}`;

    const res = await globalThis.fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-MBX-APIKEY': apiKey,
      },
    });
    if (!res.ok) {
      throw new Error(`Binance order ${res.status}: ${await res.text()}`);
    }
    return res.json() as Promise<Record<string, unknown>>;
  }

  private async hmacSha256(data: string, secret: string): Promise<string> {
    const crypto = await import('node:crypto');
    return crypto.createHmac('sha256', secret).update(data).digest('hex');
  }

  // ── HTTP core ─────────────────────────────────────────────────────────────

  /** Sustituye variables del template del endpoint declarado en manifest.toml, sanitizando params. */
  private buildRequestUrl(
    manifest: ProviderManifest,
    endpointKey: string,
    params: Record<string, unknown>,
  ): string {
    const api = manifest.api;
    const endpointTemplate = api.endpoints[endpointKey];
    if (!endpointTemplate) {
      throw new Error(`Provider ${manifest.plugin.id}: endpoint "${endpointKey}" no declarado`);
    }

    const authKey = api.auth_key_env ? (process.env[api.auth_key_env] ?? '') : '';

    // Sanitizar parámetros antes de interpolar en la URL (prevenir URL injection)
    const sanitized = Object.fromEntries(
      Object.entries(params).map(([k, v]) => {
        const str = toStr(v);
        // Permitir solo caracteres seguros en parámetros de URL: alfanumérico, /, -, _, ., =, +
        if (['symbol', 'tf', 'timeframe', 'start_date'].includes(k)) {
          const safe = str.replace(/[^A-Za-z0-9/\-_.=+]/g, '');
          if (safe !== str) {
            this.log.warn(
              `Parámetro "${k}" contenía caracteres no permitidos: ${JSON.stringify(str)}`,
            );
          }
          return [k, safe];
        }
        return [k, str];
      }),
    );

    // Construir URL sustituyendo variables del template
    const vars: Record<string, string> = {
      base_url: api.base_url ?? '',
      data_url: api.data_url ?? api.base_url ?? '',
      auth_key: authKey,
      ...sanitized,
    };
    return endpointTemplate.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');
  }

  /** Headers de autenticación según auth_type declarado en manifest.toml. */
  private buildAuthHeaders(manifest: ProviderManifest): Record<string, string> {
    const api = manifest.api;
    const authKey = api.auth_key_env ? (process.env[api.auth_key_env] ?? '') : '';
    const authSecret = api.auth_secret_env ? (process.env[api.auth_secret_env] ?? '') : '';

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (api.auth_type === 'header') {
      if (api.auth_key_header && authKey) headers[api.auth_key_header] = authKey;
      if (api.auth_secret_header && authSecret) headers[api.auth_secret_header] = authSecret;
    } else if (api.auth_type === 'bearer') {
      headers['Authorization'] = `Bearer ${authKey}`;
    }
    // query_param auth ya está en la URL template
    return headers;
  }

  private async request(
    manifest: ProviderManifest,
    endpointKey: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const url = this.buildRequestUrl(manifest, endpointKey, params);
    const headers = this.buildAuthHeaders(manifest);
    const timeoutMs = 10_000;

    const res = await globalThis.fetch(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`${manifest.plugin.id} HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json();
  }

  // ── Order lifecycle (Alpaca-specific: status / cancel / list) ──────────────
  // These operations are gated by manifest.api.format === 'alpaca' the same way
  // placeOrder branches per-format — the platform doesn't yet have a lifecycle
  // implementation for other brokers.

  /** Obtiene el estado normalizado de una orden por su id de broker. */
  async getOrderStatus(pluginId: string | null, brokerOrderId: string): Promise<OrderStatusResult> {
    const manifest = this.resolveManifest(pluginId);
    this.assertAlpacaFormat(manifest, 'getOrderStatus');
    const raw = await this.fetchOrderEndpoint(manifest, 'order_status', {
      broker_order_id: brokerOrderId,
    });
    return this.normalizeOrderStatus(manifest, raw);
  }

  /**
   * Obtiene el estado normalizado de una orden por su client_order_id (idempotencia).
   * Returns `null` specifically on a CONFIRMED 404 (the broker has no record of this
   * client_order_id — e.g. the process crashed before the broker ever received the
   * order). All other errors (401, 500, network failures, timeouts, ...) still throw —
   * a lookup failure must never be silently mistaken for "broker never received it".
   */
  async getOrderByClientId(
    pluginId: string | null,
    clientOrderId: string,
  ): Promise<OrderStatusResult | null> {
    const manifest = this.resolveManifest(pluginId);
    this.assertAlpacaFormat(manifest, 'getOrderByClientId');
    const raw = await this.fetchOrderEndpointOrNullOn404(manifest, 'order_by_client_id', {
      client_order_id: clientOrderId,
    });
    if (raw === null) return null;
    return this.normalizeOrderStatus(manifest, raw);
  }

  /** Lista órdenes filtradas por estado, normalizadas. */
  async listOrders(
    pluginId: string | null,
    opts: { status: string },
  ): Promise<OrderStatusResult[]> {
    const manifest = this.resolveManifest(pluginId);
    this.assertAlpacaFormat(manifest, 'listOrders');
    const raw = await this.fetchOrderEndpoint(manifest, 'list_orders', { status: opts.status });
    const rows = Array.isArray(raw) ? raw : [];
    return rows.map((row) => this.normalizeOrderStatus(manifest, row));
  }

  /**
   * Cancela una orden por id de broker. Tolerante: si el broker responde 404
   * (orden inexistente) o 422 (orden ya llena/cancelada — no cancelable), se
   * trata como no-op exitoso en vez de lanzar, porque el resultado deseado
   * ("la orden ya no está activa") ya se cumple.
   */
  async cancelOrder(pluginId: string | null, brokerOrderId: string): Promise<void> {
    const manifest = this.resolveManifest(pluginId);
    this.assertAlpacaFormat(manifest, 'cancelOrder');

    const url = this.buildRequestUrl(manifest, 'cancel_order', { broker_order_id: brokerOrderId });
    const headers = this.buildAuthHeaders(manifest);
    const res = await globalThis.fetch(url, {
      method: 'DELETE',
      headers,
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok) return;
    if (res.status === 404 || res.status === 422) {
      this.log.warn(
        `cancelOrder [${manifest.plugin.id}/${brokerOrderId}]: HTTP ${res.status} — orden ya inexistente/no cancelable, tratado como no-op`,
      );
      return;
    }
    const body = await res.text().catch(() => '');
    throw new Error(`${manifest.plugin.id} cancel_order HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  private assertAlpacaFormat(manifest: ProviderManifest, op: string): void {
    if (manifest.api.format !== 'alpaca') {
      throw new Error(
        `Provider ${manifest.plugin.id}: ${op} no implementado para formato "${manifest.api.format}"`,
      );
    }
  }

  private async fetchOrderEndpoint(
    manifest: ProviderManifest,
    endpointKey: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const url = this.buildRequestUrl(manifest, endpointKey, params);
    const headers = this.buildAuthHeaders(manifest);
    const res = await globalThis.fetch(url, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `${manifest.plugin.id} ${endpointKey} HTTP ${res.status}: ${body.slice(0, 200)}`,
      );
    }
    return res.json();
  }

  /**
   * Same as fetchOrderEndpoint, but a CONFIRMED 404 resolves to `null` instead of
   * throwing — used by getOrderByClientId so callers can distinguish "broker never
   * received this order" from "the lookup itself failed" (which still throws).
   */
  private async fetchOrderEndpointOrNullOn404(
    manifest: ProviderManifest,
    endpointKey: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const url = this.buildRequestUrl(manifest, endpointKey, params);
    const headers = this.buildAuthHeaders(manifest);
    const res = await globalThis.fetch(url, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `${manifest.plugin.id} ${endpointKey} HTTP ${res.status}: ${body.slice(0, 200)}`,
      );
    }
    return res.json();
  }

  /** Normaliza la respuesta cruda de Alpaca a OrderStatusResult, fallando ruidosamente ante campos numéricos ilegibles. */
  private normalizeOrderStatus(manifest: ProviderManifest, raw: unknown): OrderStatusResult {
    const o = raw as {
      id?: string;
      client_order_id?: string | null;
      status?: string;
      filled_qty?: string;
      filled_avg_price?: string | null;
    };
    if (!o.id || !o.status) {
      throw new Error(
        `${manifest.plugin.id}: respuesta de orden sin "id"/"status": ${JSON.stringify(raw)}`,
      );
    }
    return {
      broker_order_id: o.id,
      client_order_id: o.client_order_id ?? null,
      status: o.status,
      filled_qty: this.parseAlpacaOrderNumber(manifest, o.filled_qty, 'filled_qty'),
      filled_avg_price:
        o.filled_avg_price == null
          ? null
          : this.parseAlpacaOrderNumber(manifest, o.filled_avg_price, 'filled_avg_price'),
      raw,
    };
  }

  /** Number(...) nunca debe filtrar NaN silenciosamente: falla ruidosamente ante un valor ilegible. */
  private parseAlpacaOrderNumber(
    manifest: ProviderManifest,
    value: string | undefined,
    field: string,
  ): number {
    const n = Number(value);
    if (value == null || value === '' || Number.isNaN(n)) {
      throw new Error(
        `${manifest.plugin.id}: campo numérico "${field}" ilegible en respuesta de orden: ${JSON.stringify(value)}`,
      );
    }
    return n;
  }

  // ── Normalización ─────────────────────────────────────────────────────────

  private normalizeBars(raw: unknown, format: string): OhlcvBar[] {
    if (format === 'alpaca') {
      const data = raw as { bars?: AlpacaBar[] };
      return (data.bars ?? []).map((b) => ({
        ts: b.t,
        open: b.o,
        high: b.h,
        low: b.l,
        close: b.c,
        volume: b.v,
        vwap: b.vw,
      }));
    }
    if (format === 'tiingo') {
      const rows = Array.isArray(raw) ? (raw as TiingoBar[]) : [];
      return rows.map((b) => ({
        ts: b.date,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume ?? 0,
      }));
    }
    if (format === 'ccxt') {
      // CCXT devuelve [[ts, open, high, low, close, vol], ...]
      const rows = Array.isArray(raw) ? (raw as number[][]) : [];
      return rows.map((r) => ({
        ts: new Date(r[0]).toISOString(),
        open: r[1],
        high: r[2],
        low: r[3],
        close: r[4],
        volume: r[5] ?? 0,
      }));
    }
    if (format === 'binance') {
      // Binance klines: [[openTime, open, high, low, close, volume, ...], ...]
      const rows = Array.isArray(raw) ? (raw as (string | number)[][]) : [];
      return rows.map((r) => ({
        ts: new Date(Number(r[0])).toISOString(),
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        volume: Number(r[5]),
      }));
    }
    // Yahoo Finance: estructura chart.result[0] con timestamps + indicators
    if (format === 'generic') {
      const yahoo = raw as {
        chart?: {
          result?: [
            {
              timestamp?: number[];
              indicators?: {
                quote?: [
                  {
                    open?: number[];
                    high?: number[];
                    low?: number[];
                    close?: number[];
                    volume?: number[];
                  },
                ];
                adjclose?: [{ adjclose?: number[] }];
              };
            },
          ];
        };
      };
      const result = yahoo?.chart?.result?.[0];
      if (result?.timestamp) {
        const timestamps = result.timestamp;
        const q = result.indicators?.quote?.[0];
        const adjClose = result.indicators?.adjclose?.[0]?.adjclose;
        return timestamps
          .map((ts, i) => ({
            ts: new Date(ts * 1000).toISOString(),
            open: Number(q?.open?.[i] ?? 0),
            high: Number(q?.high?.[i] ?? 0),
            low: Number(q?.low?.[i] ?? 0),
            close: Number(adjClose?.[i] ?? q?.close?.[i] ?? 0),
            volume: Number(q?.volume?.[i] ?? 0),
          }))
          .filter((b) => b.close > 0);
      }
    }

    // Formato genérico: intenta inferir campos comunes
    const arr = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
    return arr.map((b) => ({
      ts: toStr(b['t'] ?? b['date'] ?? b['timestamp']),
      open: Number(b['o'] ?? b['open'] ?? 0),
      high: Number(b['h'] ?? b['high'] ?? 0),
      low: Number(b['l'] ?? b['low'] ?? 0),
      close: Number(b['c'] ?? b['close'] ?? 0),
      volume: Number(b['v'] ?? b['volume'] ?? 0),
    }));
  }

  private normalizeQuote(raw: unknown, format: string, symbol: string): Quote {
    if (format === 'alpaca') {
      const data = raw as { quote?: { bp: number; ap: number; t: string } };
      const q = data.quote ?? { bp: 0, ap: 0, t: new Date().toISOString() };
      return { symbol, bid: q.bp, ask: q.ap, last: (q.bp + q.ap) / 2, ts: q.t };
    }
    if (format === 'tiingo') {
      const arr = Array.isArray(raw)
        ? (raw as { last: number; bidPrice: number; askPrice: number; timestamp: string }[])
        : [];
      const q = arr[0] ?? {
        last: 0,
        bidPrice: 0,
        askPrice: 0,
        timestamp: new Date().toISOString(),
      };
      return { symbol, bid: q.bidPrice, ask: q.askPrice, last: q.last, ts: q.timestamp };
    }
    if (format === 'binance') {
      // Binance ticker/price: { symbol, price }
      const data = raw as { price?: string; symbol?: string };
      const last = Number(data.price ?? 0);
      return { symbol, bid: last, ask: last, last, ts: new Date().toISOString() };
    }
    if (format === 'generic') {
      // Yahoo Finance: extraer último close del chart
      const yahoo = raw as {
        chart?: {
          result?: [{ meta?: { regularMarketPrice?: number; regularMarketTime?: number } }];
        };
      };
      const meta = yahoo?.chart?.result?.[0]?.meta;
      if (meta?.regularMarketPrice) {
        const last = Number(meta.regularMarketPrice);
        const ts = meta.regularMarketTime
          ? new Date(meta.regularMarketTime * 1000).toISOString()
          : new Date().toISOString();
        return { symbol, bid: last, ask: last, last, ts };
      }
    }
    return { symbol, bid: 0, ask: 0, last: 0, ts: new Date().toISOString() };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private resolveManifest(pluginId: string | null): ProviderManifest {
    if (pluginId) {
      const m = this.providers.get(pluginId);
      if (m) return m;
      throw new Error(`Provider "${pluginId}" no encontrado o inactivo`);
    }
    const def = this.getDefaultProvider();
    if (!def) throw new Error('Sin provider activo con credenciales configuradas');
    return def;
  }

  private hasCredentials(manifest: ProviderManifest): boolean {
    const api = manifest.api;
    if (api.auth_key_env && !process.env[api.auth_key_env]) return false;
    if (api.auth_secret_env && !process.env[api.auth_secret_env]) return false;
    return true;
  }

  private nDaysAgo(days: number): string {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString().split('T')[0];
  }

  /**
   * Yahoo Finance accepts only a discrete `range` token (not a bar count). Pick
   * the smallest bucket that covers `limit` bars (approximated as trading days,
   * which is correct for daily data and a safe over-fetch for intraday — the
   * adapter slices the window it needs). Falls back to "max".
   */
  private yahooRange(limit: number): string {
    const buckets: Array<[string, number]> = [
      ['5d', 5],
      ['1mo', 21],
      ['3mo', 63],
      ['6mo', 126],
      ['1y', 252],
      ['2y', 504],
      ['5y', 1260],
      ['10y', 2520],
    ];
    for (const [range, bars] of buckets) {
      if (limit <= bars) return range;
    }
    return 'max';
  }

  // ── TOML parser mínimo ────────────────────────────────────────────────────
  // Evitamos dependencia externa parseando sólo lo necesario del manifest.

  private parseManifest(filePath: string): ProviderManifest | null {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return this.tomlToProviderManifest(content);
    } catch {
      return null;
    }
  }

  private tomlToProviderManifest(toml: string): ProviderManifest | null {
    const plugin: Record<string, string> = {};
    const api: Record<string, string> = {};
    const endpoints: Record<string, string> = {};

    let section = '';
    for (const rawLine of toml.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;

      // Detectar sección
      if (line.startsWith('[')) {
        section = line.replace(/[[\]]/g, '').trim();
        continue;
      }

      const eqIdx = line.indexOf('=');
      if (eqIdx === -1) continue;
      const key = line.slice(0, eqIdx).trim();
      const valRaw = line
        .slice(eqIdx + 1)
        .trim()
        .replace(/^["']|["']$/g, '');

      if (section === 'plugin') plugin[key] = valRaw;
      else if (section === 'api') api[key] = valRaw;
      else if (section === 'api.endpoints') endpoints[key] = valRaw;
    }

    if (!plugin['id'] || !plugin['type']) return null;

    return {
      plugin: { id: plugin['id'], name: plugin['name'] ?? plugin['id'], type: plugin['type'] },
      api: {
        format: api['format'] ?? 'generic',
        base_url: api['base_url'],
        data_url: api['data_url'],
        auth_type: (api['auth_type'] ?? 'header') as 'header' | 'query_param' | 'bearer',
        auth_key_env: api['auth_key_env'],
        auth_secret_env: api['auth_secret_env'],
        auth_key_header: api['auth_key_header'],
        auth_secret_header: api['auth_secret_header'],
        auth_key_param: api['auth_key_param'],
        endpoints,
      },
    };
  }
}

// ── Tipos internos ────────────────────────────────────────────────────────────

interface ProviderManifest {
  plugin: { id: string; name: string; type: string };
  api: {
    format: string;
    base_url?: string;
    data_url?: string;
    auth_type: 'header' | 'query_param' | 'bearer';
    auth_key_env?: string;
    auth_secret_env?: string;
    auth_key_header?: string;
    auth_secret_header?: string;
    auth_key_param?: string;
    endpoints: Record<string, string>;
  };
}

interface AlpacaBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  vw?: number;
}
interface TiingoBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}
