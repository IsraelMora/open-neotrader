# Market Context — Breadth & Volatility Regime

Unified market context plugin that merges **market-breadth** and **volatility-regime** into a single cycle hook.
Load this plugin to get a complete picture of market health: breadth participation AND volatility regime in one call.

## What it does in every cycle

### 1. Market Breadth (ctx injection)

Injects into the cycle context:

| Key | Type | Semantics |
|-----|------|-----------|
| `market_breadth_score` | float 0–100 | Composite breadth health score |
| `market_breadth_regime` | string | `bullish` \| `neutral` \| `bearish` \| `extreme_bullish` \| `extreme_bearish` |
| `market_breadth_divergence` | string \| None | `bearish_divergence` \| `bullish_divergence` \| `None` |
| `market_breadth_details` | dict | `ad_ratio`, `pct_above_ma`, `mcclellan_osc`, `nh_nl_ratio`, `breadth_thrust`, `details` |

Also appends to `emit_alerts` when regime is `extreme_bearish` or divergence is `bearish_divergence`.

### 2. Volatility Regime (emitted signal)

Returns a signal of type `"volatility_regime"` in the cycle signals list:

```json
{
  "type": "volatility_regime",
  "symbol": "SPY",
  "action": "info",
  "regime": "low | normal | high | crisis",
  "vix": 18.5,
  "rv_21d": 0.142,
  "rv_percentile": 0.35,
  "size_multiplier": 1.0,
  "preferred_strategies": ["momentum_factor_12_1", "ema_crossover_9_21"],
  "avoid_strategies": [],
  "market_trend_up": true,
  "description": "..."
}
```

## Breadth Indicators

| Indicator | What it measures |
|-----------|-----------------|
| **Advance/Decline Ratio** | Fraction of assets rising vs falling today |
| **% above MA200** | Assets trading above their 200-day moving average |
| **McClellan Oscillator** | EMA(19) − EMA(39) of net advances; momentum of breadth |
| **NH/NL Ratio** | New 52-week highs vs lows |
| **Breadth Thrust (Zweig)** | A/D goes from <40% to >61.5% in 10 days — strong buy signal |
| **Price/Breadth Divergence** | Index and breadth moving in opposite directions |

### Breadth Score → Regime

| Score | Regime | Recommended action |
|-------|--------|-------------------|
| 80–100 | `extreme_bullish` | Amplify signals, increase position size |
| 70–79 | `bullish` | Long bias, favorable conditions |
| 30–69 | `neutral` | Normal sizing, selective |
| 20–29 | `bearish` | Reduce exposure, prefer defensive |
| 0–19 | `extreme_bearish` | Maximum caution, triggers CORRELATION_SPIKE alert |

## Volatility Regimes

| Regime | VIX | RV Percentile | Optimal behavior |
|--------|-----|--------------|-----------------|
| **low** | < 15 | < 30th pctile | Momentum, trend following — full exposure |
| **normal** | 15–25 | 30th–70th | Mixed strategies — normal sizing |
| **high** | 25–40 | 70th–90th | Mean reversion — reduce 50% |
| **crisis** | > 40 | > 90th | Cash / safe havens — reduce 90% |

### Combining both signals

```python
# Example discipline plugin logic
if ctx["market_breadth_regime"] == "extreme_bullish" and vol_regime == "low":
    position_scale = 1.2   # best conditions: full momentum
elif ctx["market_breadth_regime"] == "bearish" or vol_regime == "high":
    position_scale = 0.5   # deteriorating: be careful
elif vol_regime == "crisis":
    position_scale = 0.1   # crisis: near-cash
```

## Academic references

- McClellan, S. & McClellan, T. (1970). McClellan Oscillator
- Zweig, M. (1986). *Winning on Wall Street*. Warner Books
- Murphy, J.J. (1999). *Technical Analysis of Financial Markets*, Ch. 18
- Ang, A., Hodrick, R., Xing, Y., & Zhang, X. (2006). The Cross-Section of Volatility and Expected Returns. *Journal of Finance*
- Lo, A. (2002). The Statistics of Sharpe Ratios. *Financial Analysts Journal*

## Recommended plugin combinations

| With plugin | Effect |
|-------------|--------|
| Max Drawdown Circuit Breaker | Regime pre-warns before circuit breaker triggers |
| Kelly Criterion | Adjust kelly_fraction via `size_multiplier` from vol regime |
| Momentum Factor 12-1 | Enable only in `low` or `normal` vol regime |
| RSI Mean Reversion | Activate preferentially in `high` vol regime |

## Notes

<!-- The LLM updates this section with observations from real cycles -->
