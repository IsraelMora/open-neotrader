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

Para backtests avanzados (Monte Carlo), considera vectorbt o backtrader.

## Walk-Forward Mode (`run_walk_forward`)

Validates a strategy out-of-sample using Pardo (2008) anchored walk-forward. Drives the same `generate → engine` pipeline as `run`, so no separate backtest logic exists.

### When to use

Use after a plain backtest returns promising metrics to check whether those metrics hold on unseen data (detect overfitting before going live).

### How it works

1. IS always starts at bar 0 and grows (anchored, not rolling).
2. The OOS window slides forward by `oos_total / n_windows` bars per fold.
3. A full backtest runs on each (IS prices, OOS prices) pair independently.
4. Robustness ratio per window = `Sharpe_OOS / Sharpe_IS` (0 when `|IS Sharpe| ≤ 0.01`).

### Verdict thresholds

| Verdict              | Condition |
|----------------------|-----------|
| `ROBUSTO`            | ≥ 50% of valid windows have `robustness_ratio ≥ 0.5` |
| `SOBREAJUSTADO`      | < 50% of valid windows are robust |
| `INSUFICIENTE_DATOS` | < 2 valid windows (windows where `oos_trades ≥ min_trades`) OR < 60 total bars |

### Example usage

```
→ run_walk_forward(
    strategy_id = "trend-following",
    prices      = {"AAPL": [...500 bars...]},
    config      = {"n_windows": 5, "in_sample_pct": 0.7, "min_trades": 10}
  )
```

### Key config params

| Param          | Default | Description |
|----------------|---------|-------------|
| `n_windows`    | 5       | Number of IS/OOS folds |
| `in_sample_pct`| 0.7     | Fraction of history used as IS |
| `min_trades`   | 10      | Min OOS trades for a window to count |

## Notas aprendidas

<!-- El LLM actualiza con observaciones sobre estrategias testeadas y sus resultados -->
