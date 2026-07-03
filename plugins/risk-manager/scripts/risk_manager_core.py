"""
Risk Manager Core — unified layered risk discipline.

Consolidates four overlapping risk-gate plugins into one module with
individually toggle-able layers. Each layer function is pure and
independently unit-testable.

Layers (applied in order by the on_cycle hook):
  1. Exposure      — hard veto + qty rescale (from risk-envelope)
  2. Concentration — sector cap + max positions (from portfolio-risk-manager)
  3. Correlation   — Pearson-based entry cancellation (from correlation-guard)
  4. Drawdown      — graduated circuit breaker (from max-drawdown-circuit-breaker)

Signal mutation contract:
  - Cancelled signals: action = "cancelled", cancel_reason = <str>
  - Rescaled signals:  qty reduced in-place (exposure layer), or
                       position_usd / kelly.position_usd scaled down (drawdown layer)
  - Non-entry signals (exit, sell, cover, neutral): always pass through each layer unchanged
"""

from __future__ import annotations

import math
from dataclasses import dataclass

# Epsilon below which a float qty/market-value is treated as flat (zero),
# guarding against exact-equality (`== 0`) false negatives from float residue
# (e.g. a partial close leaving a tiny non-zero remainder).
EPS = 1e-9

# ─────────────────────────────────────────────────────────────────────────────
# Layer 1: Exposure (ported from risk-envelope)
# ─────────────────────────────────────────────────────────────────────────────


def apply_exposure_layer(
    signals: list[dict],
    portfolio_value: float,
    positions: list[dict],
    config: dict,
) -> list[dict]:
    """
    Apply hard exposure limits to pending signals.

    Config keys used:
      enable_exposure        (bool, default True)
      max_single_trade_pct   (float, default 0.10)  — per-trade notional cap
      max_position_pct       (float, default 0.40)  — per-asset cap
      max_open_positions     (int,   default 10)    — position count cap
      max_total_exposure     (float, default 0.80)  — total portfolio exposure cap
      allow_shorts           (bool,  default False) — veto shorts when False

    Signal keys read:  action, symbol, qty, price
    Signal mutations:
      - qty reduced (rescale) when a per-trade or per-asset cap is hit
      - action = "cancelled", cancel_reason = <str> on hard veto
    Non-entry signals (action not in long/short/buy/sell/exit) pass through.
    """
    if not config.get("enable_exposure", True):
        return list(signals)

    cfg_max_trade_pct = float(config.get("max_single_trade_pct", 0.10))
    cfg_max_pos_pct = float(config.get("max_position_pct", 0.40))
    cfg_max_open = int(config.get("max_open_positions", 10))
    cfg_max_exposure = float(config.get("max_total_exposure", 0.80))
    cfg_allow_shorts = bool(config.get("allow_shorts", False))

    # Build current exposure from positions list
    existing: dict[str, float] = {}
    for p in positions:
        sym = p.get("symbol", "")
        mv = float(p.get("market_value", p.get("qty", 0) * p.get("current_price", 0)))
        existing[sym] = mv

    current_exposure = sum(existing.values())
    current_positions: dict[str, float] = dict(existing)

    # Action mapping: align bus event actions to canonical buy/sell/short
    _ENTRY_ACTIONS = {"long", "buy", "short", "sell_short"}
    _EXIT_ACTIONS = {"exit", "sell", "close", "cover"}

    result: list[dict] = []

    for sig in signals:
        action = sig.get("action", "")

        # Non-entry/exit actions pass through
        if action in _EXIT_ACTIONS:
            result.append(sig)
            # Update exposure tracking for sells
            sym = sig.get("symbol", "")
            qty = float(sig.get("qty", 0))
            price = float(sig.get("price", sig.get("entry_price", 0)))
            if price > 0 and qty > 0:
                notional = qty * price
                current_positions[sym] = max(0.0, current_positions.get(sym, 0.0) - notional)
                current_exposure = max(0.0, current_exposure - notional)
            continue

        if action not in _ENTRY_ACTIONS:
            result.append(sig)
            continue

        # Map long → buy for internal logic
        canonical = "buy" if action in ("long", "buy") else action

        # Rule 1: Shorts veto
        if not cfg_allow_shorts and canonical in ("short", "sell_short"):
            result.append({
                **sig,
                "action": "cancelled",
                "cancel_reason": "Shorts prohibited (allow_shorts=false)",
            })
            continue

        price = float(sig.get("price", sig.get("entry_price", 0)))
        qty = float(sig.get("qty", 0))

        if price <= 0 or qty <= 0:
            result.append(sig)
            continue

        notional = qty * price

        # Rule 2: Per-trade size cap
        max_notional_per_trade = portfolio_value * cfg_max_trade_pct
        if notional > max_notional_per_trade and max_notional_per_trade > 0:
            factor = max_notional_per_trade / notional
            qty = qty * factor
            notional = notional * factor

        # Rule 3: Per-asset cap
        sym = sig.get("symbol", "")
        current_in_sym = current_positions.get(sym, 0.0)
        projected_pos = current_in_sym + notional
        max_allowed = portfolio_value * cfg_max_pos_pct

        if projected_pos > max_allowed:
            available = max_allowed - current_in_sym
            if available <= 0:
                result.append({
                    **sig,
                    "action": "cancelled",
                    "cancel_reason": (
                        f"Per-asset limit reached for {sym}"
                        f" ({cfg_max_pos_pct * 100:.0f}% of portfolio)"
                    ),
                })
                continue
            factor = available / notional
            qty = qty * factor
            notional = notional * factor

        # Rule 4: Max open positions (only for brand-new symbols)
        is_new = sym not in current_positions or abs(current_positions[sym]) < EPS
        if is_new and canonical == "buy":
            active_count = sum(1 for v in current_positions.values() if v > 0)
            if active_count >= cfg_max_open:
                result.append({
                    **sig,
                    "action": "cancelled",
                    "cancel_reason": f"Max open positions limit ({cfg_max_open}) reached",
                })
                continue

        # Rule 5: Total exposure cap
        projected_exposure = current_exposure + notional
        max_exposure = portfolio_value * cfg_max_exposure

        if projected_exposure > max_exposure:
            available = max_exposure - current_exposure
            if available <= 0:
                result.append({
                    **sig,
                    "action": "cancelled",
                    "cancel_reason": (
                        f"Total exposure cap ({cfg_max_exposure * 100:.0f}%) reached"
                    ),
                })
                continue
            factor = available / notional
            qty = qty * factor
            notional = notional * factor

        # Approved — emit (possibly rescaled) signal
        out = dict(sig)
        if abs(qty - float(sig.get("qty", 0))) > 1e-8:
            out["qty"] = round(qty, 6)
        result.append(out)

        # Update running state for subsequent signals in this batch
        current_positions[sym] = current_positions.get(sym, 0.0) + notional
        current_exposure += notional

    return result


# ─────────────────────────────────────────────────────────────────────────────
# Layer 2: Concentration (ported from portfolio-risk-manager)
# ─────────────────────────────────────────────────────────────────────────────


def apply_concentration_layer(
    signals: list[dict],
    portfolio: dict,
    config: dict,
) -> list[dict]:
    """
    Apply sector concentration and max-positions limits to pending signals.

    Config keys used:
      enable_concentration        (bool,  default True)
      max_sector_concentration_pct (float, default 30.0) — % cap per sector
      max_positions               (int,   default 10)   — position count cap
      min_cash_pct                (float, default 20.0) — minimum free cash %

    Portfolio format: { symbol: { size_pct, sector, ... } }
    Signal keys read:  action, symbol, size_pct, sector (optional)
    Signal mutations:
      - action = "cancelled", cancel_reason = <str> for hard blocks
      - size_pct reduced when exposure/cash limits hit (soft rescale)
    Non-entry signals pass through unchanged.
    """
    if not config.get("enable_concentration", True):
        return list(signals)

    cfg_max_sector = float(config.get("max_sector_concentration_pct", 30.0))
    cfg_max_pos = int(config.get("max_positions", 10))
    cfg_min_cash = float(config.get("min_cash_pct", 20.0))

    _ENTRY_ACTIONS = {"long", "short", "buy", "sell_short"}

    # Build running sector exposure from portfolio
    sector_exposure: dict[str, float] = {}
    for _sym, pos in portfolio.items():
        sector = pos.get("sector", pos.get("asset_class", "unknown"))
        sector_exposure[sector] = sector_exposure.get(sector, 0.0) + float(pos.get("size_pct", 0.0))

    current_positions_count = len(portfolio)
    current_total_exposure = sum(float(p.get("size_pct", 0.0)) for p in portfolio.values())

    result: list[dict] = []

    for sig in signals:
        action = sig.get("action", "")

        if action not in _ENTRY_ACTIONS:
            result.append(sig)
            continue

        sym = sig.get("symbol", "")
        sector = sig.get("sector", "unknown")
        size_pct = float(sig.get("size_pct", 5.0))

        # Check max positions (only for new symbols not already in portfolio)
        if sym not in portfolio and current_positions_count >= cfg_max_pos:
            result.append({
                **sig,
                "action": "cancelled",
                "cancel_reason": f"Max positions ({cfg_max_pos}) reached",
            })
            continue

        # Check sector concentration
        current_sector_pct = sector_exposure.get(sector, 0.0)
        if current_sector_pct + size_pct > cfg_max_sector:
            # Check if there is any room at all
            available_in_sector = cfg_max_sector - current_sector_pct
            if available_in_sector <= 0:
                result.append({
                    **sig,
                    "action": "cancelled",
                    "cancel_reason": (
                        f"Sector '{sector}' concentration cap"
                        f" ({cfg_max_sector:.0f}%) reached"
                    ),
                })
                continue
            # Rescale size_pct to fit within sector cap
            size_pct = available_in_sector

        # Check min cash constraint
        new_cash = 100.0 - current_total_exposure - size_pct
        if new_cash < cfg_min_cash:
            max_for_cash = 100.0 - current_total_exposure - cfg_min_cash
            if max_for_cash <= 0:
                result.append({
                    **sig,
                    "action": "cancelled",
                    "cancel_reason": (
                        f"Min cash reserve ({cfg_min_cash:.0f}%) not available"
                    ),
                })
                continue
            size_pct = min(size_pct, max_for_cash)

        out = {**sig, "size_pct": round(size_pct, 2)}
        result.append(out)

        # Update running state
        sector_exposure[sector] = sector_exposure.get(sector, 0.0) + size_pct
        current_total_exposure += size_pct
        if sym not in portfolio:
            current_positions_count += 1

    return result


# ─────────────────────────────────────────────────────────────────────────────
# Layer 3: Correlation (ported from correlation-guard)
# ─────────────────────────────────────────────────────────────────────────────


def pearson_correlation(returns_a: list[float], returns_b: list[float]) -> float:
    """Pearson correlation on two return series. Returns 0.0 if insufficient data."""
    n = min(len(returns_a), len(returns_b))
    if n < 5:
        return 0.0
    a = returns_a[-n:]
    b = returns_b[-n:]
    mean_a = sum(a) / n
    mean_b = sum(b) / n
    cov = sum((a[i] - mean_a) * (b[i] - mean_b) for i in range(n)) / n
    var_a = sum((x - mean_a) ** 2 for x in a) / n
    var_b = sum((x - mean_b) ** 2 for x in b) / n
    std_a = math.sqrt(var_a)
    std_b = math.sqrt(var_b)
    if std_a < EPS or std_b < EPS:
        return 0.0
    return round(cov / (std_a * std_b), 4)


def _log_returns(prices: list[float]) -> list[float]:
    """Compute log returns: ln(P_t / P_{t-1})."""
    if len(prices) < 2:
        return []
    return [
        math.log(prices[i] / prices[i - 1])
        for i in range(1, len(prices))
        if prices[i - 1] > 0
    ]


def apply_correlation_layer(
    signals: list[dict],
    open_positions: list[str],
    price_series: dict[str, list[float]],
    config: dict,
) -> list[dict]:
    """
    Cancel 'long' entry signals that are highly correlated with open positions.

    Config keys used:
      enable_correlation  (bool,  default True)
      max_correlation     (float, default 0.70) — Pearson threshold (absolute)

    Signal keys read:  action, symbol
    Signal mutations:
      - action = "cancelled", cancel_reason = "correlación alta con posición abierta"
        for signals whose symbol is correlated with any open position

    Only 'long' action signals are candidates for cancellation.
    Short, exit and other actions always pass through.
    """
    if not config.get("enable_correlation", True):
        return list(signals)

    if not open_positions or not signals:
        return list(signals)

    max_corr = float(config.get("max_correlation", 0.70))

    # Build log-return series for all symbols we have data for
    returns: dict[str, list[float]] = {}
    for sym, prices in price_series.items():
        r = _log_returns(prices)
        if r:
            returns[sym] = r

    if len(returns) < 2:
        # Insufficient data — pass through everything unchanged
        return list(signals)

    # Pre-compute which candidate symbols are blocked
    blocked: set[str] = set()
    for sig in signals:
        if sig.get("action") != "long":
            continue
        candidate = sig.get("symbol", "")
        if candidate not in returns:
            continue
        for held in open_positions:
            if held not in returns:
                continue
            corr = pearson_correlation(returns[candidate], returns[held])
            if abs(corr) >= max_corr:
                blocked.add(candidate)
                break  # one correlated position is enough

    result: list[dict] = []
    for sig in signals:
        if sig.get("action") == "long" and sig.get("symbol", "") in blocked:
            result.append({
                **sig,
                "action": "cancelled",
                "cancel_reason": "correlación alta con posición abierta",
            })
        else:
            result.append(sig)

    return result


# ─────────────────────────────────────────────────────────────────────────────
# Layer 4: Drawdown Circuit Breaker (ported from max-drawdown-circuit-breaker)
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class _CircuitStatus:
    state: str
    size_multiplier: float
    trading_allowed: bool
    reason: str | None


_STATE_NORMAL = "normal"
_STATE_WARNING = "warning"
_STATE_DANGER = "danger"
_STATE_BREAKER = "breaker"
_STATE_DAILY = "daily"


def _evaluate_circuit(
    equity_history: list[float],
    equity_open_today: float,
    warning_pct: float,
    danger_pct: float,
    breaker_pct: float,
    recovery_pct: float,
    daily_limit_pct: float,
    previous_state: str,
    worst_drawdown_in_state: float,
) -> _CircuitStatus:
    if not equity_history:
        return _CircuitStatus(_STATE_NORMAL, 1.0, True, None)

    peak = max(equity_history)
    current = equity_history[-1]
    drawdown = (peak - current) / peak * 100 if peak > 0 else 0.0

    daily_loss = 0.0
    if equity_open_today > 0:
        daily_loss = max(0.0, (equity_open_today - current) / equity_open_today * 100)

    # Evaluate state (daily check first — highest priority)
    if daily_loss >= daily_limit_pct:
        return _CircuitStatus(
            _STATE_DAILY, 0.0, False,
            f"Daily loss {daily_loss:.1f}% exceeds limit {daily_limit_pct:.1f}%",
        )

    if drawdown >= breaker_pct:
        return _CircuitStatus(
            _STATE_BREAKER, 0.0, False,
            f"Drawdown {drawdown:.1f}% exceeds circuit breaker {breaker_pct:.1f}%",
        )

    if drawdown >= danger_pct:
        # Recovery lock: if previous state was BREAKER, require recovery before DANGER
        if previous_state == _STATE_BREAKER:
            recovery_from_worst = worst_drawdown_in_state - drawdown
            if recovery_from_worst < recovery_pct:
                return _CircuitStatus(
                    _STATE_BREAKER, 0.0, False,
                    (
                        f"Recovering from circuit breaker. "
                        f"Recovered {recovery_from_worst:.1f}% of {recovery_pct:.1f}% required"
                    ),
                )
        return _CircuitStatus(
            _STATE_DANGER, 0.25, True,
            f"Drawdown {drawdown:.1f}% in danger zone",
        )

    if drawdown >= warning_pct:
        return _CircuitStatus(
            _STATE_WARNING, 0.50, True,
            f"Drawdown {drawdown:.1f}% in warning zone",
        )

    return _CircuitStatus(_STATE_NORMAL, 1.0, True, None)


def apply_drawdown_layer(
    signals: list[dict],
    equity_history: list[float],
    equity_open_today: float,
    circuit_state: str,
    worst_drawdown_in_state: float,
    config: dict,
) -> list[dict]:
    """
    Apply graduated drawdown circuit breaker to pending signals.

    Config keys used:
      enable_drawdown_breaker  (bool,  default True)
      warning_drawdown_pct     (float, default 5.0)
      danger_drawdown_pct      (float, default 10.0)
      circuit_breaker_pct      (float, default 15.0)
      recovery_threshold_pct   (float, default 3.0)
      daily_loss_limit_pct     (float, default 3.0)

    ctx keys read:  equity_history, equity_open_today, circuit_state, worst_drawdown_in_state
    Signal mutations:
      - action = "cancelled", cancel_reason = <str> when trading_allowed=False
      - position_usd (or kelly.position_usd/kelly.shares) scaled by size_multiplier
        when size_multiplier < 1.0; circuit_reduced=True added to signal

    Exit / non-entry signals pass through unchanged.
    """
    if not config.get("enable_drawdown_breaker", True):
        return list(signals)

    if not equity_history:
        return list(signals)

    status = _evaluate_circuit(
        equity_history=equity_history,
        equity_open_today=equity_open_today if equity_open_today > 0 else equity_history[0],
        warning_pct=float(config.get("warning_drawdown_pct", 5.0)),
        danger_pct=float(config.get("danger_drawdown_pct", 10.0)),
        breaker_pct=float(config.get("circuit_breaker_pct", 15.0)),
        recovery_pct=float(config.get("recovery_threshold_pct", 3.0)),
        daily_limit_pct=float(config.get("daily_loss_limit_pct", 3.0)),
        previous_state=circuit_state,
        worst_drawdown_in_state=worst_drawdown_in_state,
    )

    _ENTRY_ACTIONS = {"long", "short", "buy", "sell_short"}
    result: list[dict] = []

    for sig in signals:
        action = sig.get("action", "")

        if action not in _ENTRY_ACTIONS:
            result.append(sig)
            continue

        if not status.trading_allowed:
            result.append({
                **sig,
                "action": "cancelled",
                "cancel_reason": status.reason,
            })
            continue

        if status.size_multiplier < 1.0:
            out = dict(sig)
            if "kelly" in sig and "position_usd" in sig["kelly"]:
                kelly = dict(sig["kelly"])
                kelly["position_usd"] = round(kelly["position_usd"] * status.size_multiplier, 2)
                kelly["shares"] = int(kelly.get("shares", 0) * status.size_multiplier)
                out["kelly"] = kelly
                out["circuit_reduced"] = True
                out["size_multiplier"] = status.size_multiplier
            elif "position_usd" in sig:
                out["position_usd"] = round(sig["position_usd"] * status.size_multiplier, 2)
                out["circuit_reduced"] = True
                out["size_multiplier"] = status.size_multiplier
            result.append(out)
            continue

        result.append(sig)

    return result


# ─────────────────────────────────────────────────────────────────────────────
# Portfolio health diagnostic (LLM-callable tool)
# ─────────────────────────────────────────────────────────────────────────────


def check_portfolio_health(
    portfolio_value: float,
    positions: list[dict],
    portfolio: dict | None = None,
    config: dict | None = None,
) -> dict:
    """
    Diagnose the current portfolio against risk-manager limits.

    Combines exposure-level checks (from positions list) and sector-level checks
    (from portfolio dict) into a single health report.

    Returns:
      {
        healthy:            bool,
        total_exposure:     float,
        total_exposure_pct: float,
        n_positions:        int,
        by_symbol:          { symbol: pct },
        sector_exposure:    { sector: pct },
        violations:         [str],
        warnings:           [str],
        alerts:             [str],  # combined violations + warnings
      }
    """
    cfg = config or {}
    portfolio = portfolio or {}
    cfg_max_pos_pct = float(cfg.get("max_position_pct", 0.40))
    cfg_max_exposure = float(cfg.get("max_total_exposure", 0.80))
    cfg_max_open = int(cfg.get("max_open_positions", 10))
    cfg_max_sector = float(cfg.get("max_sector_concentration_pct", 30.0))

    violations: list[str] = []
    warnings: list[str] = []

    # Position-level checks (from positions list)
    by_symbol: dict[str, float] = {}
    total_exposure = 0.0
    for p in positions:
        sym = p.get("symbol", "")
        mv = float(p.get("market_value", p.get("qty", 0) * p.get("current_price", 0)))
        by_symbol[sym] = mv
        total_exposure += mv
        pct = mv / portfolio_value if portfolio_value > 0 else 0
        if pct > cfg_max_pos_pct:
            violations.append(
                f"{sym}: {pct:.1%} exceeds per-asset limit {cfg_max_pos_pct:.0%}"
            )

    exposure_pct = total_exposure / portfolio_value if portfolio_value > 0 else 0
    if exposure_pct > cfg_max_exposure:
        violations.append(
            f"Total exposure {exposure_pct:.1%} exceeds limit {cfg_max_exposure:.0%}"
        )
    elif exposure_pct > cfg_max_exposure * 0.9:
        warnings.append(
            f"Total exposure {exposure_pct:.1%} near limit ({cfg_max_exposure:.0%})"
        )

    if len(by_symbol) > cfg_max_open:
        violations.append(
            f"{len(by_symbol)} open positions exceeds limit {cfg_max_open}"
        )

    # Sector-level checks (from portfolio dict)
    sector_exposure: dict[str, float] = {}
    for _sym, pos in portfolio.items():
        sector = pos.get("sector", pos.get("asset_class", "unknown"))
        sector_exposure[sector] = sector_exposure.get(sector, 0.0) + float(pos.get("size_pct", 0.0))

    for sector, exposure in sector_exposure.items():
        if exposure > cfg_max_sector:
            violations.append(
                f"Sector '{sector}': {exposure:.1f}% exceeds limit {cfg_max_sector:.0f}%"
            )
        elif exposure > cfg_max_sector * 0.85:
            warnings.append(f"Sector '{sector}': {exposure:.1f}% near limit")

    return {
        "healthy": len(violations) == 0,
        "total_exposure": round(total_exposure, 2),
        "total_exposure_pct": round(exposure_pct, 3),
        "n_positions": len(by_symbol),
        "by_symbol": {sym: round(mv / portfolio_value, 3) for sym, mv in by_symbol.items()},
        "sector_exposure": sector_exposure,
        "violations": violations,
        "warnings": warnings,
        "alerts": violations + warnings,
    }
