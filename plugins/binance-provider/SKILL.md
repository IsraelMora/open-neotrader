---
name: Binance Provider
description: Proveedor de datos y ejecución para crypto via Binance API. Mayor volumen de trading crypto del mundo. Soporta BTCUSDT, ETHUSDT, y +350 pares. Testnet disponible para pruebas sin riesgo. Usar con universo Crypto Top 50.
---

# Binance Provider

## Por qué Binance para crypto

| Métrica | Binance | Coinbase | Kraken |
|---------|---------|----------|--------|
| Volumen 24h | ~$20B | ~$2B | ~$0.5B |
| Pares disponibles | 350+ | 250+ | 200+ |
| API fiabilidad | alta | alta | alta |
| Fees (maker/taker) | 0.10%/0.10% | 0.40%/0.60% | 0.16%/0.26% |
| Testnet | ✅ | ✅ | ❌ |

## Credenciales

1. Crear cuenta en https://www.binance.com
2. API Management → Create API Key
3. Permisos: "Read Info" + "Enable Spot & Margin Trading"
4. **Whitelist de IPs** — recomendado para seguridad

## Formato de símbolos

Binance usa pares concatenados: `{base}{quote}` → BTCUSDT, ETHBUSD, BNBUSDT

El config `quote_asset` (default: USDT) se añade automáticamente al símbolo base.

```
BTC → BTCUSDT
ETH → ETHUSDT
BNB → BNBUSDT
```

## Timeframes disponibles

`1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 8h, 12h, 1d, 3d, 1w, 1M`

## Testnet

Binance Testnet: https://testnet.binance.vision
- Fondos ficticios para paper trading
- Misma API que mainnet
- Recomendado antes de activar mainnet

## Combinaciones

| Con plugin | Efecto |
|------------|--------|
| + Crypto Top 50 Universe | Universo completo de los 50 principales crypto |
| + Volatility Regime | Crypto tiene regímenes propios; VIX menos relevante |
| + Bollinger Squeeze | Muy efectivo en crypto por la alta volatilidad |
| + EMA Crossover 9/21 | Funciona bien en BTC/ETH timeframes de 4h-1d |

## Notas aprendidas

<!-- El LLM actualiza con observaciones -->
