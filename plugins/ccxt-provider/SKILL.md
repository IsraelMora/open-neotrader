---
name: CCXT Universal Provider
description: Provider genérico que da acceso a 200+ exchanges via la librería CCXT. Interfaz uniforme para OHLCV, quotes y órdenes en cualquier exchange compatible.
---

# CCXT Universal Provider

## Qué es CCXT

CCXT (CryptoCurrency eXchange Trading Library) es la librería open-source más usada para integrar exchanges de criptomonedas. Soporta más de 200 exchanges con una API unificada.

- **GitHub**: github.com/ccxt/ccxt  
- **Licencia**: MIT  
- **Exchanges soportados**: Binance, Kraken, KuCoin, OKX, Bybit, Coinbase, Bitfinex, Huobi, Gate.io...

## Cuándo usar CCXT vs providers específicos

| Situación | Recomendación |
|-----------|---------------|
| Exchange principal con alta frecuencia | Provider específico (Binance, Alpaca) — más eficiente |
| Explorar un exchange nuevo | CCXT — cero código, solo cambiar `exchange` en config |
| Arbitraje multi-exchange | CCXT — interfaz uniforme facilita comparar precios |
| Exchange sin provider específico | CCXT — cobertura de 200+ exchanges |

## Configuración de exchanges comunes

```toml
# Kraken (spot)
exchange = "kraken"
symbol_fmt = "slash"  # BTC/USD, ETH/USD

# KuCoin (spot + futuros)
exchange = "kucoin"
symbol_fmt = "slash"

# OKX (spot + perpetuos)
exchange = "okx"
market_type = "swap"
symbol_fmt = "slash"  # BTC/USDT:USDT para perpetuos

# Bybit (perpetuos)
exchange = "bybit"
market_type = "swap"
```

## Normalización de datos

El ProviderGatewayService normaliza la respuesta CCXT al formato interno:

```python
# CCXT OHLCV devuelve: [[timestamp_ms, open, high, low, close, volume], ...]
# Normalizado a: [{"ts": "2024-01-01T00:00:00Z", "o": 1.0, "h": 1.1, "l": 0.9, "c": 1.05, "v": 1000}, ...]
```

## Rate limits

Cada exchange tiene sus propios límites. CCXT los conoce internamente:
- Binance: 1200 req/min
- Kraken: 1 req/seg
- KuCoin: 30 req/10seg

Configura `rate_limit` en ms entre peticiones para no ser bloqueado.

## Notas aprendidas

<!-- El LLM actualiza con observaciones sobre exchanges específicos -->
