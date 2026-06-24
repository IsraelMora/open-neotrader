# Trend Following — Multi-Confirmation Trend Strategy

## What it does

Consolidates three independent trend indicators into a single high-conviction consensus signal:

| Indicator | What it measures | Bull condition | Bear condition |
|-----------|-----------------|----------------|----------------|
| EMA Crossover (fast/slow) | Momentum direction | fast EMA > slow EMA | fast EMA < slow EMA |
| MACD (line vs signal) | Momentum acceleration | MACD line > signal line | MACD line < signal line |
| Ichimoku Cloud (price vs cloud + T/K) | Structural trend | price above cloud AND tenkan > kijun | price below cloud AND tenkan < kijun |

## Signal logic

- Count `bull_votes` and `bear_votes` across the three indicators
- `signal = "long"` when `bull_votes >= min_consensus`
- `signal = "short"` when `bear_votes >= min_consensus` (also serves as exit signal for long positions)
- `signal = "none"` when neither threshold is reached
- `confirmed = True` when all 3 indicators agree (3-of-3)
- `confidence = agreement_count / 3`

## When to use this skill

Call `trend-following.analyze` when you need a trend direction with multi-indicator confirmation before entering a position. Prefer this over single-indicator strategies when false-positive rate matters.

## Minimum data requirement

**78 bars** (senkou_b=52 + kijun=26) at the configured timeframe before any signal fires. With fewer bars, returns `{"signal": "none", "confirmed": false, "confidence": 0.0}`.

## Key config levers

- `min_consensus=2` (default): standard operation — two indicators must agree
- `min_consensus=3`: high-conviction mode — all three must agree (lower frequency, higher quality)
- `senkou_b=52`: increasing this raises bar requirements but makes the Ichimoku cloud more meaningful

## Return shape

```json
{
  "signal": "long | short | exit | none",
  "confirmed": true,
  "confidence": 1.0,
  "reason": "EMA=bull | MACD=bull | Ichimoku=bull | bull=3/bear=0 | consensus=2",
  "ema_vote": "bull | bear | neutral",
  "macd_vote": "bull | bear | neutral",
  "ichimoku_vote": "bull | bear | neutral",
  "bull_votes": 3,
  "bear_votes": 0
}
```
