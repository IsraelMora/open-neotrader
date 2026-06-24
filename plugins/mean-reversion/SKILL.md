# Mean Reversion

## Edge

Statistical arbitrage against short-term price dislocations. Prices that deviate
significantly from their historical mean tend to revert — but only when the underlying
process is genuinely mean-reverting (stationary). Trend-following in disguise is the
primary failure mode; the OU gate prevents it.

## Signal logic

| Condition | Signal |
|---|---|
| `\|z\|` ≤ `exit_z` | `exit` (position reverted, close it) |
| z ≤ −`entry_z` AND OU valid AND RSI ≤ oversold | `long` |
| z ≥ +`entry_z` AND OU valid AND RSI ≥ overbought | `short` |
| OU half-life > `max_half_life` or `None` | vetoed → `none` |

## OU stationarity gate

Half-life is estimated via Vasicek OLS regression on the full price history:

```
delta_X = theta * (X_lag - mean(X_lag)) + epsilon
half_life = -ln(2) / ln(1 + theta)
```

- theta ≥ 0 → no pull toward mean → return `None` (trending)
- half_life > `max_half_life` → reversion too slow to trade → veto

The OU fit uses the **full available history**, not a short window. A truncated window
can misclassify a single-bar dip in a trending series as reversion.

## Consolidation

Replaces three redundant plugins:
- `ornstein-uhlenbeck` — OU stationarity gate (ported)
- `mean-reversion-zscore` — z-score entry/exit (ported)
- `rsi-mean-reversion` — Wilder RSI confirmation (ported)

## Tool: `mean-reversion.analyze`

```json
{
  "bars": [{"date": "2024-01-01", "close": 150.0}, ...],
  "config": { "entry_z": 2.0, "require_stationarity": true }
}
```

Response:

```json
{
  "signal":     "long",
  "confirmed":  true,
  "confidence": 0.85,
  "reason":     "z=-2.45, half_life=14.2d",
  "zscore":     -2.45,
  "half_life":  14.2
}
```
