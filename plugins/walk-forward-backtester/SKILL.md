# Walk-Forward Backtester

Validación out-of-sample con ventanas rodantes para detectar overfitting en estrategias de trading.

## Fundamento matemático

**Pardo (2008) "The Evaluation and Optimization of Trading Strategies"**

El problema del overfitting en trading: una estrategia optimizada sobre datos históricos puede mostrar Sharpe > 2.0 in-sample pero rendimiento negativo en datos nuevos. El walk-forward resuelve esto dividiendo la historia en ventanas solapadas:

```
|─── IS (70%) ───|─ OOS (30%) ─|
       ventana 1

|────── IS (70%) ──────|─ OOS (30%) ─|
             ventana 2
...
```

**Robustness Ratio** = Sharpe_OOS / Sharpe_IS

- `>= 0.5` → estrategia robusta (OOS preserva ≥50% del IS)
- `< 0.5` → sobreajustada (OOS se degrada significativamente)

**Veredicto:**
- `ROBUSTO` → ≥50% de las ventanas tienen robustness ≥ 0.5
- `SOBREAJUSTADO` → la estrategia no generaliza a datos nuevos
- `INSUFICIENTE_DATOS` → menos de 60 precios o menos de 2 ventanas válidas

## Cuándo usar

Antes de desplegar cualquier estrategia en vivo. Un backtest tradicional con Sharpe alto no es suficiente — siempre valida con walk-forward. Señales de alerta:

- Robustness ratio < 0.3 → probable curva-fitting severo
- IS Sharpe >> OOS Sharpe consistentemente → los parámetros están sobreoptimizados
- Win rate IS > 70% pero OOS < 45% → el modelo ha memorizado noise

## Parámetros clave

| Parámetro | Default | Descripción |
|-----------|---------|-------------|
| `n_windows` | 5 | Número de ventanas walk-forward |
| `in_sample_pct` | 0.70 | % de in-sample (Pardo recomienda 67-75%) |
| `min_trades` | 10 | Mínimo de trades en OOS para ventana válida |
| `commission_pct` | 0.001 | Comisión (0.1%) — Interactive Brokers ≈ 0.05% |
| `slippage_pct` | 0.0005 | Slippage realista para mid-cap |

## Interpretación

```json
{
  "verdict": "ROBUSTO",
  "avg_oos_sharpe": 0.87,
  "avg_robustness_ratio": 0.73,
  "robust_windows": 4,
  "total_windows": 5,
  "summary": {
    "avg_oos_win_rate": 0.54,
    "avg_oos_profit_factor": 1.42,
    "pct_robust_windows": 0.80
  }
}
```

Un `avg_robustness_ratio` de 0.73 con 4/5 ventanas robustas indica que la estrategia
generaliza bien y no está sobreajustada al período histórico.

## Limitaciones

- Usa momentum simple como señal de ejemplo. Para tu estrategia real, pasa las señales
  precomputadas a `walk_forward_backtest()` o modifica el script.
- No incluye costes de financiación overnight ni dividendos.
- El walk-forward ancored (IS siempre empieza desde el inicio) es más conservador que el
  rolling walk-forward (IS de longitud fija).
