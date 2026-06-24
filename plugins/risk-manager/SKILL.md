# Risk Manager — Unified Layered Risk Discipline

**Plugin ID:** `risk-manager`
**Type:** `discipline`
**Hook:** `on_cycle`

## What this plugin does

Consolidates four overlapping risk-gate plugins into a single ordered pipeline applied to `pending_signals` every cycle. Each of the four layers can be independently toggled via config flags.

## Layer pipeline (applied in order)

| # | Layer | Source plugin | What it does |
|---|-------|--------------|--------------|
| 1 | **Exposure** | risk-envelope | Hard veto + qty rescale: per-trade notional cap, per-asset position cap, max open positions, total exposure cap. Shorts optionally prohibited. |
| 2 | **Concentration** | portfolio-risk-manager | Blocks new entries that push sector concentration or position count beyond limits. Rescales `size_pct` when partially OK. |
| 3 | **Correlation** | correlation-guard | Cancels `long` entries whose Pearson log-return correlation with any open position exceeds `max_correlation`. Requires `provider_tools.get_ohlcv` for real data; passes through if data unavailable. |
| 4 | **Drawdown Breaker** | max-drawdown-circuit-breaker | Graduated response to portfolio drawdown: WARNING (50% size), DANGER (25% size), BREAKER (halt). Recovery lock prevents resuming before sufficient recovery. |

## ctx contract

### Keys consumed

| Key | Type | Required by |
|-----|------|------------|
| `pending_signals` | `list[dict]` | all layers |
| `portfolio` | `dict` | concentration, correlation |
| `positions` | `list[dict]` | exposure |
| `portfolio_value` | `float` | exposure |
| `equity_history` | `list[float]` | drawdown |
| `equity_open_today` | `float` | drawdown (daily loss check) |
| `circuit_state` | `str` | drawdown (recovery lock) |
| `worst_drawdown_in_state` | `float` | drawdown (recovery lock) |
| `config` | `dict` | all layers |
| `provider_tools` | `dict` | correlation (optional) |

### Returns

```python
{
  "signals": list[dict],   # pending_signals after all enabled layers applied
  "logs":    list[dict],   # [{"level": str, "msg": str}] audit trail
}
```

## Signal mutation semantics

- **Hard veto (cancelled):** `signal["action"] = "cancelled"`, `signal["cancel_reason"] = <str>`
- **Rescale (exposure layer):** `signal["qty"]` reduced proportionally
- **Size reduction (drawdown layer):** `signal["position_usd"]` (or `signal["kelly"]["position_usd"]`) multiplied by `size_multiplier`; `signal["circuit_reduced"] = True` added
- **Exit signals** (`action in exit/sell/close/cover`) pass through ALL layers unchanged

## Config toggles

```toml
enable_exposure         = true   # Layer 1
enable_concentration    = true   # Layer 2
enable_correlation      = true   # Layer 3
enable_drawdown_breaker = true   # Layer 4
```

## Key thresholds and their defaults

### Exposure layer
```toml
max_total_exposure    = 0.80   # 80% portfolio max invested
max_position_pct      = 0.40   # 40% max per asset
max_single_trade_pct  = 0.10   # 10% max per individual trade
max_open_positions    = 10
allow_shorts          = false
```

### Concentration layer
```toml
max_sector_concentration_pct = 30.0  # %
max_positions                = 10
min_cash_pct                 = 20.0  # %
```

### Correlation layer
```toml
max_correlation = 0.70
lookback_days   = 60
```

### Drawdown circuit breaker
```toml
warning_drawdown_pct    = 5.0   # → 50% size
danger_drawdown_pct     = 10.0  # → 25% size
circuit_breaker_pct     = 15.0  # → halt
recovery_threshold_pct  = 3.0   # % recovery required to exit BREAKER
daily_loss_limit_pct    = 3.0   # intraday loss limit → halt
```

## LLM-callable tools

| Tool | Description |
|------|-------------|
| `apply_risk_envelope` | Pre-execution exposure gate: veto/rescale trade proposals |
| `check_portfolio_health` | Diagnose portfolio vs risk limits (violations + warnings) |

## Design notes

- Layer order matters: exposure runs first so concentration/correlation never see already-cancelled signals, reducing noise in logs.
- The concentration layer only operates on the non-cancelled subset from layer 1; cancelled signals are passed through and merged back.
- The correlation layer gracefully degrades when `provider_tools.get_ohlcv` is unavailable (passes all signals through).
- The drawdown circuit breaker preserves the `kelly` sub-dict structure when scaling, matching the kelly-criterion plugin's signal format.
