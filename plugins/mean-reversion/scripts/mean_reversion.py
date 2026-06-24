"""
Mean Reversion — consolidated strategy plugin.

Combines:
- Ornstein-Uhlenbeck half-life estimation (stationarity gate)
- Z-score entry/exit thresholds
- Wilder RSI confirmation (optional)

References:
  Vasicek, O. (1977). An equilibrium characterization of the term structure.
  Jegadeesh, N. (1990). Evidence of predictable behavior of security returns.
  Wilder, J.W. (1978). New Concepts in Technical Trading Systems.
"""

from __future__ import annotations

import math
from typing import Any


# ── OU half-life estimation ───────────────────────────────────────────────────


def estimate_half_life(prices: list[float]) -> float | None:
    """
    Estimate mean-reversion half-life via OU/Vasicek OLS regression.

    Regresses delta_price on lagged_price (demeaned):
        delta_X = theta * (lagged_X - mean(lagged_X)) + epsilon

    Half-life = -ln(2) / ln(1 + theta)

    Returns None when the series is not mean-reverting (theta >= 0),
    the result is non-finite, or there is insufficient variance.
    """
    n = len(prices)
    if n < 5:
        return None

    delta = [prices[i] - prices[i - 1] for i in range(1, n)]
    lagged_raw = prices[:-1]
    mean_lag = sum(lagged_raw) / len(lagged_raw)
    lagged = [p - mean_lag for p in lagged_raw]

    ss_ll = sum(v * v for v in lagged)
    if ss_ll < 1e-10:
        return None

    # OLS: theta = sum(lagged * delta) / sum(lagged^2)
    theta = sum(lagged[i] * delta[i] for i in range(len(lagged))) / ss_ll

    if theta >= 0:
        # Not mean-reverting — no pull back to mean
        return None

    log_arg = 1.0 + theta
    if log_arg <= 0:
        # Overdamped or explosive; can't compute log
        return None

    half_life = -math.log(2) / math.log(log_arg)

    if half_life <= 0 or not math.isfinite(half_life):
        return None

    return float(half_life)


# ── RSI (Wilder smoothing) ────────────────────────────────────────────────────


def _wilder_rsi(closes: list[float], period: int = 14) -> float | None:
    """
    Compute the most recent RSI value using Wilder's smoothing (alpha = 1/period).

    Returns None when there are fewer than period+1 bars.
    """
    n = len(closes)
    if n < period + 1:
        return None

    deltas = [closes[i] - closes[i - 1] for i in range(1, n)]
    gains = [max(d, 0.0) for d in deltas]
    losses = [abs(min(d, 0.0)) for d in deltas]

    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period

    alpha = 1.0 / period
    for i in range(period, len(deltas)):
        avg_gain = alpha * gains[i] + (1.0 - alpha) * avg_gain
        avg_loss = alpha * losses[i] + (1.0 - alpha) * avg_loss

    if avg_loss == 0.0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100.0 - (100.0 / (1.0 + rs))


# ── Main analyze function ─────────────────────────────────────────────────────


def analyze(bars: list[dict[str, Any]], config: dict[str, Any]) -> dict[str, Any]:
    """
    Analyze a price series for mean-reversion opportunities.

    Args:
        bars:   list of OHLCV dicts [{date, open, high, low, close, volume}, ...]
                in chronological order (oldest first, most recent last).
        config: strategy parameters (see manifest.toml for defaults).

    Returns:
        {
            "signal":     "long" | "short" | "exit" | "none",
            "confirmed":  bool,      # True when OU validation passed
            "confidence": float,     # 0..1
            "reason":     str,
            "zscore":     float,
            "half_life":  float | None,
        }

    Invariants:
        - Never indexes beyond len(bars)-1 (no lookahead).
        - Pure function: does not mutate bars or config.
    """
    _none = _make_result("none", False, 0.0, "insufficient data", 0.0, None)

    lookback: int = int(config.get("lookback", 20))
    entry_z: float = float(config.get("entry_z", 2.0))
    exit_z: float = float(config.get("exit_z", 0.5))
    rsi_period: int = int(config.get("rsi_period", 14))
    rsi_oversold: float = float(config.get("rsi_oversold", 30))
    rsi_overbought: float = float(config.get("rsi_overbought", 70))
    require_stationarity: bool = bool(config.get("require_stationarity", True))
    max_half_life: float = float(config.get("max_half_life", 60))
    use_rsi_confirm: bool = bool(config.get("use_rsi_confirm", True))

    # Need at least lookback bars (and extra for RSI when enabled)
    min_bars = lookback
    if len(bars) < min_bars:
        return _none

    # Extract closes — only from bars[0..len(bars)-1], never beyond
    closes = [float(b["close"]) for b in bars]
    current_price = closes[-1]

    # 1. Rolling mean/std over last `lookback` bars
    window = closes[-lookback:]
    mean_price = sum(window) / len(window)
    variance = sum((p - mean_price) ** 2 for p in window) / (len(window) - 1) if len(window) > 1 else 0.0
    std_price = math.sqrt(variance) if variance > 0 else 0.0

    if std_price < 1e-10:
        return _make_result("none", False, 0.0, "zero variance in window", 0.0, None)

    zscore = (current_price - mean_price) / std_price

    # 2. OU half-life estimation (stationarity gate)
    half_life: float | None = None
    ou_valid = True

    if require_stationarity:
        # Use the full price history for OU estimation — more data yields a more
        # accurate characterization of the underlying process. A truncated window
        # can mistake a single-bar dip in a strongly trending series as reversion.
        half_life = estimate_half_life(closes)

        if half_life is None or half_life > max_half_life:
            # Not mean-reverting or reversion too slow → veto
            ou_valid = False
    else:
        # Still attempt estimation for informational output
        half_life = estimate_half_life(closes)

    # 3. RSI confirmation (optional)
    rsi_value: float | None = None
    rsi_ok_long = True
    rsi_ok_short = True

    if use_rsi_confirm:
        rsi_value = _wilder_rsi(closes, rsi_period)
        if rsi_value is not None:
            rsi_ok_long = rsi_value <= rsi_oversold
            rsi_ok_short = rsi_value >= rsi_overbought
        else:
            # Not enough bars for RSI → block confirmation
            rsi_ok_long = False
            rsi_ok_short = False

    # 4. Signal logic
    abs_z = abs(zscore)
    stationarity_factor = 1.0 if ou_valid else 0.5

    if abs_z <= exit_z:
        # Exit condition: price is back near mean — always emit regardless of OU
        confidence = min(1.0, (exit_z - abs_z + 0.1) / (exit_z + 0.1))
        return _make_result(
            "exit",
            ou_valid,
            round(confidence, 3),
            f"z={zscore:.3f} within exit_z={exit_z}",
            round(zscore, 6),
            round(half_life, 2) if half_life is not None else None,
        )

    if zscore <= -entry_z and ou_valid and rsi_ok_long:
        confidence = min(1.0, abs_z / entry_z * stationarity_factor)
        hl_str = f", half_life={half_life:.1f}d" if half_life is not None else ""
        reason = f"z={zscore:.3f} <= -{entry_z}{hl_str}"
        if use_rsi_confirm and rsi_value is not None:
            reason += f", RSI={rsi_value:.1f}"
        return _make_result(
            "long",
            True,
            round(confidence, 3),
            reason,
            round(zscore, 6),
            round(half_life, 2) if half_life is not None else None,
        )

    if zscore >= entry_z and ou_valid and rsi_ok_short:
        confidence = min(1.0, abs_z / entry_z * stationarity_factor)
        hl_str = f", half_life={half_life:.1f}d" if half_life is not None else ""
        reason = f"z={zscore:.3f} >= +{entry_z}{hl_str}"
        if use_rsi_confirm and rsi_value is not None:
            reason += f", RSI={rsi_value:.1f}"
        return _make_result(
            "short",
            True,
            round(confidence, 3),
            reason,
            round(zscore, 6),
            round(half_life, 2) if half_life is not None else None,
        )

    # Neutral / vetoed
    if not ou_valid and abs_z > entry_z:
        hl_desc = f"half_life={half_life:.1f}d (> max {max_half_life}d)" if half_life is not None else "half_life=None (not mean-reverting)"
        reason = f"OU veto: {hl_desc}, z={zscore:.3f}"
    elif use_rsi_confirm and abs_z > entry_z:
        reason = f"RSI confirmation failed (RSI={rsi_value}), z={zscore:.3f}"
    else:
        reason = f"z={zscore:.3f} within [{-entry_z}, +{entry_z}] — no signal"

    return _make_result(
        "none",
        ou_valid,
        0.0,
        reason,
        round(zscore, 6),
        round(half_life, 2) if half_life is not None else None,
    )


def _make_result(
    signal: str,
    confirmed: bool,
    confidence: float,
    reason: str,
    zscore: float,
    half_life: float | None,
) -> dict[str, Any]:
    return {
        "signal": signal,
        "confirmed": confirmed,
        "confidence": confidence,
        "reason": reason,
        "zscore": zscore,
        "half_life": half_life,
    }
