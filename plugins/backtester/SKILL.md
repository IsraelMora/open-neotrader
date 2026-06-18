---
name: Backtester
description: Motor de backtesting integrado. Evalúa estrategias con señales históricas. Calcula Sharpe, max drawdown, win rate, profit factor y curva de equity sin dependencias externas.
---

# Backtester

## Cuándo usar

- Validar una nueva estrategia antes de activarla en live
- Comparar versiones de un skill tras ajustar parámetros
- Auditoría periódica de estrategias activas con datos históricos
- Responder al usuario "¿cómo habría funcionado esta estrategia en los últimos 2 años?"

## Métricas calculadas

| Métrica | Qué mide | Umbral aceptable |
|---------|----------|-----------------|
| Sharpe Ratio | Retorno ajustado por riesgo (vs RF) | > 1.0 (bueno), > 1.5 (excelente) |
| Sortino Ratio | Solo penaliza volatilidad negativa | > 1.5 |
| Max Drawdown | Peor caída desde máximo | < 20% (conservador), < 35% (agresivo) |
| Calmar Ratio | CAGR / Max Drawdown | > 0.5 |
| Win Rate | % de trades ganadores | > 45% (importante: también mide avg win/loss) |
| Profit Factor | Total ganado / Total perdido | > 1.5 |
| Avg Win / Avg Loss | Relación riesgo/beneficio | Avg Win > 2x Avg Loss |

## Flujo de uso

```
1. LLM recopila señales históricas del skill a testear
   → inject_backtest_signals([...])

2. LLM obtiene precios históricos del provider
   → get_ohlcv(symbol, timeframe="1d", limit=500)
   → inject_backtest_prices({AAPL: [...], NVDA: [...]})

3. Ejecutar backtest
   → run_backtest()

4. Interpretar resultados
   → ¿Sharpe > 1? ¿Profit factor > 1.5? ¿Max DD aceptable?
   → Si pasa: recomendar activar; si falla: sugerir ajuste de parámetros
```

## Interpretación práctica

```
Sharpe 0.8, Win Rate 60%, Max DD 12%:
→ Estrategia defensiva, baja rentabilidad pero muy estable.
  Aceptable para perfiles conservadores.

Sharpe 1.4, Win Rate 48%, Profit Factor 2.1, Max DD 18%:
→ Buena estrategia trend-following. El bajo win rate es normal en momentum.
  El profit factor compensa perdiendo pocas veces pero ganando más.

Sharpe 2.1, Win Rate 55%, Max DD 8%:
→ Excelente. Típico de mean reversion con gestión estricta de riesgo.
```

## Limitaciones del backtester embebido

1. **Sin look-ahead bias** — las señales deben estar en fechas pasadas, no futuras
2. **Slippage fijo** — el slippage real varía por liquidez; configurar slippage_pct generoso
3. **Sin order book** — asume ejecución siempre disponible al precio de cierre
4. **Sin dividendos** — no ajusta precios por dividendos (importante para backtests > 3 años)
5. **Sin market impact** — posiciones grandes moverían el precio en realidad

Para backtests avanzados (walk-forward, Monte Carlo), considera vectorbt o backtrader.

## Notas aprendidas

<!-- El LLM actualiza con observaciones sobre estrategias testeadas y sus resultados -->
