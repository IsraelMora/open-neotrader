---
name: Position Sizing (Unified)
description: Unified position-sizing discipline with four selectable modes — Kelly Criterion, Van Tharp Pyramiding, Fixed Fractional, and Vol-Target (inverse-vol / risk-parity). Use BEFORE opening any position to determine how many shares/units to buy. Consolidates kelly-criterion and position-sizing-pyramid into one plugin.
---

# Position Sizing — Unified Discipline

## Modes

### `mode = "kelly"` — Kelly Criterion (default)

Sizes positions by maximizing geometric capital growth, derived from trade history.

**Formula:**
```
f* = (p × b - q) / b

where:
  f* = optimal fraction of capital
  p  = win rate (from trade history)
  q  = 1 - p
  b  = payoff ratio = avg_win / avg_loss

Position = capital × f* / stop_loss_pct
```

**Config params used:** `kelly_fraction_cap`, `max_position_pct`, `min_trades_required`, `safety_size_pct`

**Safety fallback:** if trade history has fewer than `min_trades_required` trades, uses `safety_size_pct` (default 2%) instead of Kelly.

**Example (Half-Kelly):**
```
win_rate = 0.55, payoff = 1.5, kelly_fraction_cap = 0.5
f* = (0.55×1.5 - 0.45) / 1.5 = 0.25 → Half-Kelly = 0.125 (12.5%)
stop_loss_pct = 2% → position = 12.5% / 2% = 6.25% of capital
```

---

### `mode = "pyramid"` — Van Tharp Pyramiding

Enters in tranches and adds to winners. Reduces average cost without increasing initial risk.

**Algorithm (3 tranches, entry_pct=40%, add_pct=30%):**
```
Total target: 9% of capital
Tranche 1 (entry):  40% × 9% = 3.6% @ entry_price
Tranche 2 (add #1): 30% × 9% = 2.7% @ entry_price + 1 ATR
Tranche 3 (add #2): 30% × 9% = 2.7% @ entry_price + 2 ATR
```

**Config params used:** `entry_pct`, `add_pct`, `max_tranches`, `add_trigger_r`, `trail_stop_after_add`

**Signals emitted:**
- For new entries: enriches signal with `size_pct` (first tranche only) and `pyramid_plan`
- For open positions: emits `type=pyramid_add` signals when price reaches the next trigger

---

### `mode = "fixed"` — Fixed Fractional

Sizes all positions at a fixed `fixed_pct` of capital, regardless of trade history.

**Config params used:** `fixed_pct`, `max_position_pct`

Best for: early-stage portfolios, strategies without enough history for Kelly, or when simplicity is preferred over optimality.

---

### `mode = "vol_target"` — Inverse-Vol / Risk-Parity

Weights each long candidate in the current batch inversely to its own volatility, so
lower-vol assets get more capital and no single position dominates. This is the sizing
half of the dual/time-series momentum strategy (`docs/design/trading-strategy.md` step 4).

**Formula:**
```
w_i = (1 / vol_i) / sum_j(1 / vol_j)
position_i = min(w_i, max_position_pct) × portfolio_value
```

**Volatility source (in priority order):** `signal["volatility_12m"]` (emitted by
`momentum-factor-12-1`) → `signal["volatility"]` → `config.default_volatility_pct` (with a
warning log when falling back).

**Config params used:** `max_position_pct`, `default_volatility_pct`

**Example (two candidates):**
```
vol_A = 0.10, vol_B = 0.30
w_A = (1/0.10) / (1/0.10 + 1/0.30) = 10 / 13.33 ≈ 0.75
w_B = (1/0.30) / (1/0.10 + 1/0.30) = 3.33 / 13.33 ≈ 0.25
```

---

## ctx contract (`on_cycle`)

| Field | Type | Required by |
|---|---|---|
| `pending_signals` | `list[dict]` | all modes |
| `portfolio_value` | `float` | kelly, fixed, vol_target |
| `portfolio` | `dict[symbol → position]` | pyramid (for adds) |
| `trade_history` | `list[dict]` with `pnl_pct` | kelly |
| `config` | `dict` | all modes |

## Signal enrichment output

| Mode | Key added to signal | Contents |
|---|---|---|
| `kelly` | `"kelly"` | shares, position_usd, position_pct, risk_usd, reward_usd, rr_ratio, warning |
| `pyramid` | `"pyramid_plan"` + sets `size_pct` | total_tranches, executed_tranches, remaining_tranches |
| `fixed` | `"fixed"` | shares, position_usd, position_pct, risk_usd, reward_usd, rr_ratio |
| `vol_target` | `"vol_target"` | weight, volatility_used, shares, position_usd, position_pct, capped_at_max |

Non-long signals (exit, neutral) always pass through unchanged.

## LLM tool usage

```
# Before any new position:
position-sizing__calculate_position_size(
    capital=50000, price=150.0, stop_loss_pct=2.0, take_profit_pct=3.0
)

# Check historical edge (kelly mode):
position-sizing__get_kelly_stats()

# Get pyramid plan:
position-sizing__calculate_tranches(
    symbol="AAPL", entry_price=150.0, stop_loss=147.0, target_price=162.0
)

# Evaluate add for open position:
position-sizing__evaluate_add(
    symbol="AAPL", current_price=153.5, entry_price=150.0, stop_loss=147.0,
    tranches_executed=1, max_tranches=3
)
```

## Combining modes

| With plugin | Effect |
|---|---|
| ATR Stop Loss | Provides ATR for pyramid trigger calculations |
| Kelly (legacy) | Superseded by this plugin in kelly mode |
| Position Sizing Pyramid (legacy) | Superseded by this plugin in pyramid mode |
| Volatility Regime | In "crisis" regime: switch to fixed mode or reduce kelly_fraction_cap |
| Max Drawdown Circuit Breaker | Applies veto after this plugin sizes the position |

## References

- Kelly, J.L. (1956). "A New Interpretation of Information Rate." Bell System Technical Journal.
- Thorp, E.O. (2006). "The Kelly Criterion in Blackjack, Sports Betting, and the Stock Market."
- Van Tharp (1999). "Trade Your Way to Financial Freedom."
- Ed Seykota / Stanley Druckenmiller — pyramid practitioners.
