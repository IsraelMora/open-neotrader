import {
  Controller,
  Get,
  Post,
  Delete,
  Query,
  Param,
  ParseIntPipe,
  DefaultValuePipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ProviderGatewayService } from './provider-gateway.service';
import { OhlcvCacheService } from './ohlcv-cache.service';

/**
 * Endpoints de acceso a datos de mercado y operaciones: OHLCV, cotizaciones, noticias y portfolio.
 *
 * C1: there is intentionally NO raw order-placement route here. `ProviderGatewayService.placeOrder()`
 * talks to the real broker and must only ever be called from TradeIntentService.approve()/autoProcess(),
 * which enforces _effectiveMode (paper/real gate), risk gates, the per-order notional ceiling, and
 * HITL approval before ever reaching the broker. A former `POST /:pluginId/orders` route here called
 * gateway.placeOrder() directly (TOTP-only) and bypassed all of that — removed, no legitimate caller
 * existed for it anywhere in the monorepo.
 */
@Controller('providers')
export class ProviderGatewayController {
  constructor(
    private readonly gateway: ProviderGatewayService,
    private readonly ohlcvCache: OhlcvCacheService,
  ) {}

  /** Lista todos los providers activos y su estado de credenciales */
  @Get()
  list() {
    return this.gateway.listProviders();
  }

  /** Estadísticas de la caché OHLCV */
  @Get('cache/stats')
  cacheStats() {
    return this.ohlcvCache.stats();
  }

  /** Vacía la caché OHLCV (útil para forzar refresh de datos) */
  @Delete('cache')
  @HttpCode(HttpStatus.NO_CONTENT)
  flushCache() {
    this.ohlcvCache.flush();
  }

  /** Datos OHLCV: /providers/:pluginId/ohlcv?symbol=AAPL&timeframe=1d&limit=100 */
  @Get(':pluginId/ohlcv')
  async ohlcv(
    @Param('pluginId') pluginId: string,
    @Query('symbol') symbol: string,
    @Query('timeframe') timeframe: string = '1d',
    @Query('limit', new DefaultValuePipe(200), ParseIntPipe) limit: number,
  ) {
    return this.gateway.getOhlcv(pluginId, symbol, timeframe, limit);
  }

  /** Cotización: /providers/:pluginId/quote?symbol=AAPL */
  @Get(':pluginId/quote')
  async quote(@Param('pluginId') pluginId: string, @Query('symbol') symbol: string) {
    return this.gateway.getQuote(pluginId, symbol);
  }

  /** Test de conexión: /providers/:pluginId/test */
  @Post(':pluginId/test')
  async test(@Param('pluginId') pluginId: string) {
    return this.gateway.testConnection(pluginId);
  }

  /** Usando el primer provider disponible (shortcut) */
  @Get('default/ohlcv')
  async ohlcvDefault(
    @Query('symbol') symbol: string,
    @Query('timeframe') timeframe: string = '1d',
    @Query('limit', new DefaultValuePipe(200), ParseIntPipe) limit: number,
  ) {
    return this.gateway.getOhlcv(null, symbol, timeframe, limit);
  }

  @Get('default/quote')
  async quoteDefault(@Query('symbol') symbol: string) {
    return this.gateway.getQuote(null, symbol);
  }

  /** Noticias: /providers/:pluginId/news?query=AAPL&hours_back=24&limit=10 */
  @Get(':pluginId/news')
  async news(
    @Param('pluginId') pluginId: string,
    @Query('query') query: string,
    @Query('hours_back', new DefaultValuePipe(24), ParseIntPipe) hoursBack: number,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
  ) {
    return this.gateway.getNews(pluginId, query, hoursBack, limit);
  }

  /** Portfolio y posiciones: GET /providers/:pluginId/portfolio */
  @Get(':pluginId/portfolio')
  async portfolio(@Param('pluginId') pluginId: string) {
    return this.gateway.getPortfolio(pluginId);
  }

  @Get('default/portfolio')
  async portfolioDefault() {
    return this.gateway.getPortfolio(null);
  }
}
