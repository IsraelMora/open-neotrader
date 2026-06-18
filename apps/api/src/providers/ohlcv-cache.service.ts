/**
 * OhlcvCacheService — caché en memoria con TTL por timeframe.
 *
 * Evita golpear repetidamente las APIs de providers en ciclos frecuentes.
 * El TTL está calibrado para que la caché expire antes de que llegue la siguiente
 * barra del timeframe (datos 1d expiran en 4h, datos 1h en 15min, etc.).
 *
 * Seguridad: la caché está en memoria RAM del proceso — no persiste ni se serializa.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { OhlcvBar, Quote } from './provider-gateway.service';

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

// TTL por timeframe (ms) — expira mucho antes de que llegue la siguiente barra
const TTL_BY_TIMEFRAME: Record<string, number> = {
  '1m': 60_000, // 1 minuto
  '5m': 3 * 60_000, // 3 minutos
  '15m': 7 * 60_000, // 7 minutos
  '30m': 12 * 60_000, // 12 minutos
  '1h': 15 * 60_000, // 15 minutos
  '4h': 60 * 60_000, // 1 hora
  '1d': 4 * 3_600_000, // 4 horas
  '1w': 8 * 3_600_000, // 8 horas
  '1mo': 12 * 3_600_000, // 12 horas
};

const QUOTE_TTL = 30_000; // quotes: 30 segundos
const DEFAULT_TTL = 5 * 60_000;
const MAX_OHLCV_ENTRIES = 500;
const MAX_QUOTE_ENTRIES = 200;

@Injectable()
export class OhlcvCacheService {
  private readonly log = new Logger(OhlcvCacheService.name);
  private readonly ohlcvCache = new Map<string, CacheEntry<OhlcvBar[]>>();
  private readonly quoteCache = new Map<string, CacheEntry<Quote>>();
  private hits = 0;
  private misses = 0;

  // ── OHLCV ────────────────────────────────────────────────────────────────────

  getOhlcv(provider: string, symbol: string, timeframe: string, limit: number): OhlcvBar[] | null {
    const key = `${provider}:${symbol}:${timeframe}:${limit}`;
    const entry = this.ohlcvCache.get(key);

    if (!entry || Date.now() > entry.expiresAt) {
      this.ohlcvCache.delete(key);
      this.misses++;
      return null;
    }

    this.hits++;
    return entry.data;
  }

  setOhlcv(
    provider: string,
    symbol: string,
    timeframe: string,
    limit: number,
    bars: OhlcvBar[],
  ): void {
    if (this.ohlcvCache.size >= MAX_OHLCV_ENTRIES) {
      this.evictExpired(this.ohlcvCache);
    }
    const key = `${provider}:${symbol}:${timeframe}:${limit}`;
    const ttl = TTL_BY_TIMEFRAME[timeframe] ?? DEFAULT_TTL;
    this.ohlcvCache.set(key, { data: bars, expiresAt: Date.now() + ttl });
  }

  // ── Quotes ────────────────────────────────────────────────────────────────────

  getQuote(provider: string, symbol: string): Quote | null {
    const key = `${provider}:${symbol}`;
    const entry = this.quoteCache.get(key);

    if (!entry || Date.now() > entry.expiresAt) {
      this.quoteCache.delete(key);
      return null;
    }

    return entry.data;
  }

  setQuote(provider: string, symbol: string, quote: Quote): void {
    if (this.quoteCache.size >= MAX_QUOTE_ENTRIES) {
      this.evictExpired(this.quoteCache);
    }
    const key = `${provider}:${symbol}`;
    this.quoteCache.set(key, { data: quote, expiresAt: Date.now() + QUOTE_TTL });
  }

  // ── Invalidación ──────────────────────────────────────────────────────────────

  /** Invalida toda la caché de un símbolo (útil cuando se recibe un dato nuevo). */
  invalidateSymbol(symbol: string): void {
    for (const key of this.ohlcvCache.keys()) {
      if (key.includes(`:${symbol}:`)) this.ohlcvCache.delete(key);
    }
    for (const key of this.quoteCache.keys()) {
      if (key.endsWith(`:${symbol}`)) this.quoteCache.delete(key);
    }
  }

  /** Invalida toda la caché de un provider (e.g., cuando se desactiva). */
  invalidateProvider(provider: string): void {
    for (const key of this.ohlcvCache.keys()) {
      if (key.startsWith(`${provider}:`)) this.ohlcvCache.delete(key);
    }
    for (const key of this.quoteCache.keys()) {
      if (key.startsWith(`${provider}:`)) this.quoteCache.delete(key);
    }
  }

  /** Limpia toda la caché (útil en tests o reset manual). */
  flush(): void {
    this.ohlcvCache.clear();
    this.quoteCache.clear();
    this.log.log('Caché OHLCV vaciada');
  }

  stats(): {
    hits: number;
    misses: number;
    hit_rate_pct: number;
    ohlcv_entries: number;
    quote_entries: number;
  } {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hit_rate_pct: total > 0 ? Math.round((this.hits / total) * 100) : 0,
      ohlcv_entries: this.ohlcvCache.size,
      quote_entries: this.quoteCache.size,
    };
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  private evictExpired<T>(cache: Map<string, CacheEntry<T>>): void {
    const now = Date.now();
    for (const [key, entry] of cache.entries()) {
      if (now > entry.expiresAt) cache.delete(key);
    }
    // Si sigue llena, eliminar la mitad de las entradas (FIFO aproximado)
    if (cache.size >= MAX_OHLCV_ENTRIES * 0.9) {
      let removed = 0;
      for (const key of cache.keys()) {
        cache.delete(key);
        if (++removed >= Math.floor(cache.size / 2)) break;
      }
    }
  }
}
