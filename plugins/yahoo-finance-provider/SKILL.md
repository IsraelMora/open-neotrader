---
name: Yahoo Finance Provider
description: Datos OHLCV gratuitos via Yahoo Finance (API no oficial). Sin API key. Perfecto como fallback o para desarrollo. Solo datos históricos diarios y datos diferidos ~15 min.
---

# Yahoo Finance Provider

## Cuándo usar

| Situación | Recomendación |
|-----------|---------------|
| Desarrollo / testing | Ideal — gratis, sin key |
| Producción (cripto 24/7) | No recomendado (diferido 15 min) |
| Producción (equities daily) | Aceptable para estrategias daily |
| Datos en tiempo real | No disponible (usar Alpaca/Tiingo/Binance) |
| Backtesting histórico | Excelente — décadas de datos gratuitos |

## Endpoints de Yahoo Finance (no oficial)

```
OHLCV: https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1d&range=1y
Quote: mismo endpoint con range=1d
```

Intervalos disponibles: `1m, 2m, 5m, 15m, 30m, 60m, 90m, 1h, 1d, 5d, 1wk, 1mo, 3mo`

## Normalización

El ProviderGatewayService normaliza la respuesta Yahoo al formato interno.
Yahoo devuelve timestamps Unix en segundos (no milisegundos como Binance).

## ADVERTENCIA importante

Esta API NO es oficial. Yahoo Finance puede:
- Cambiar el formato sin aviso
- Requerir autenticación en el futuro
- Bloquear IPs por exceso de requests

Tasa recomendada: máximo 200 requests/hora. El caché OHLCV reduce la necesidad de requests.

## Symbols de Yahoo Finance

| Tipo | Formato |
|------|---------|
| Acciones US | `AAPL`, `NVDA` |
| ETFs | `SPY`, `QQQ` |
| Índices | `^GSPC` (S&P 500), `^IXIC` (Nasdaq) |
| Forex | `EURUSD=X`, `GBPJPY=X` |
| Crypto | `BTC-USD`, `ETH-USD` |
| Futuros | `ES=F` (S&P), `GC=F` (Gold) |

## Notas aprendidas

<!-- El LLM actualiza con observaciones sobre disponibilidad y limitaciones observadas -->
