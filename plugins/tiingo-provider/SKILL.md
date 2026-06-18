---
name: Tiingo Provider
description: Proveedor de datos de mercado históricos via Tiingo API. Datos OHLCV diarios/intradía para acciones, ETFs y fundamentales. Alternativa libre a Yahoo Finance con API bien mantenida. NO ejecuta órdenes — solo datos.
---

# Tiingo Provider

## Ventajas vs Yahoo Finance / Alpaca

| Característica | Tiingo | Yahoo (no oficial) | Alpaca |
|---------------|--------|-------------------|--------|
| API oficial    | ✅     | ❌ (scraping)     | ✅     |
| Gratuito       | ✅ (5000 req/día) | ✅ | ✅ (paper) |
| Datos ajustados | ✅    | ✅                | ✅     |
| Histórico largo | ✅ (30+ años) | ✅ | ✅ |
| Intradía       | ✅ (IEX feed) | limitado | ✅ |
| Fundamentales  | ✅    | ✅                | ❌     |
| Ejecución órdenes | ❌ | ❌              | ✅     |
| Estabilidad    | alta  | baja (puede romperse) | alta |

## Obtener API token

1. Registrarse gratis en https://www.tiingo.com
2. En el dashboard: API → Token
3. Plan gratuito: 5000 requests/día, datos OHLCV completos

## Endpoints disponibles

```
OHLCV diario:    /daily/{symbol}/prices?startDate=YYYY-MM-DD
OHLCV intradía:  /iex/{symbol}/prices?resampleFreq=5min
Quote actual:    /iex/{symbol}
Fundamentales:   /fundamentals/{symbol}/daily
```

## Cuándo usar Tiingo vs Alpaca

- **Solo datos, sin broker**: usa Tiingo (token gratuito, más fácil de configurar)
- **Trading real o paper**: usa Alpaca (tiene ejecución de órdenes)
- **Datos + broker Alpaca**: activa ambos — el ProviderGateway elige Tiingo para datos y Alpaca para órdenes

## Notas aprendidas

<!-- El LLM actualiza con observaciones -->
