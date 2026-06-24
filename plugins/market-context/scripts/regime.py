"""
Volatility Regime Detection (ported from volatility-regime plugin).

Combines VIX level and realized volatility to classify market regime
and recommend strategy adjustments.

References:
  Ang, Hodrick, Xing & Zhang (2006): volatility risk is systematic
  Lo (2002): financial markets have statistically distinct regimes
"""

from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass
class RegimeResult:
    regime: str  # "low" | "normal" | "high" | "crisis" | "unknown"
    vix: float | None
    rv_21d: float
    rv_percentile: float
    size_multiplier: float
    preferred_strategies: list[str]
    avoid_strategies: list[str]
    market_trend_up: bool
    vix_term_structure: float | None
    description: str


def compute_rv(log_returns: list[float], days: int = 21) -> float:
    """Annualized realized volatility for the last N days."""
    window = log_returns if len(log_returns) < days else log_returns[-days:]
    if len(window) < 2:
        return 0.0
    mean = sum(window) / len(window)
    variance = sum((r - mean) ** 2 for r in window) / (len(window) - 1)
    return math.sqrt(variance * 252)


def compute_rv_percentile(
    log_returns: list[float], current_rv: float, lookback: int = 252
) -> float:
    """Percentile of current RV vs historical distribution."""
    if len(log_returns) < 22:
        return 0.5

    historical_rvs: list[float] = []
    for i in range(21, min(len(log_returns), lookback + 21)):
        rv_i = compute_rv(log_returns[:i], 21)
        if rv_i > 0:
            historical_rvs.append(rv_i)

    if not historical_rvs:
        return 0.5

    below = sum(1 for rv in historical_rvs if rv <= current_rv)
    return round(below / len(historical_rvs), 4)


def detect_regime(
    index_closes: list[float],
    vix_value: float | None = None,
    vix_3m: float | None = None,
    vix_low: float = 15.0,
    vix_high: float = 25.0,
    vix_crisis: float = 40.0,
    lookback_days: int = 252,
) -> RegimeResult:
    """
    Detect current volatility regime.

    Args:
        index_closes: reference index close prices (SPY, SPX, etc.)
        vix_value:    current VIX level (optional)
        vix_3m:       3-month VIX for term structure (optional)
        vix_low/high/crisis: classification thresholds
        lookback_days: days for historical RV percentile

    Returns:
        RegimeResult with classification and strategy recommendations
    """
    if len(index_closes) < 22:
        return RegimeResult(
            regime="unknown",
            vix=vix_value,
            rv_21d=0.0,
            rv_percentile=0.5,
            size_multiplier=0.5,
            preferred_strategies=[],
            avoid_strategies=[],
            market_trend_up=True,
            vix_term_structure=None,
            description="Insufficient data to detect regime",
        )

    log_returns = [
        math.log(index_closes[i] / index_closes[i - 1]) for i in range(1, len(index_closes))
    ]

    rv_21d = compute_rv(log_returns, 21)
    rv_percentile = compute_rv_percentile(log_returns, rv_21d, lookback_days)

    ma200 = (
        sum(index_closes[-200:]) / min(len(index_closes), 200)
        if len(index_closes) >= 20
        else index_closes[-1]
    )
    market_trend_up = index_closes[-1] > ma200

    vix_term = None
    if vix_value and vix_3m and vix_value > 0:
        vix_term = round(vix_3m / vix_value, 4)

    if vix_value is not None:
        if vix_value > vix_crisis:
            regime = "crisis"
        elif vix_value > vix_high:
            regime = "high"
        elif vix_value > vix_low:
            regime = "normal"
        else:
            regime = "low"
    else:
        if rv_percentile > 0.90:
            regime = "crisis"
        elif rv_percentile > 0.70:
            regime = "high"
        elif rv_percentile > 0.30:
            regime = "normal"
        else:
            regime = "low"

    if regime == "low":
        size_multiplier = 1.0
        preferred = ["momentum_factor_12_1", "ema_crossover_9_21", "bollinger_squeeze"]
        avoid: list[str] = []
        desc = (
            f"Low volatility (VIX={vix_value}, RV={rv_21d:.1%}). "
            "Momentum works well. Full exposure."
        )
    elif regime == "normal":
        size_multiplier = 1.0
        preferred = ["ema_crossover_9_21", "bollinger_squeeze", "rsi_mean_reversion"]
        avoid = []
        desc = (
            f"Normal volatility (VIX={vix_value}, RV={rv_21d:.1%}). "
            "All strategies operational."
        )
    elif regime == "high":
        size_multiplier = 0.50
        preferred = ["rsi_mean_reversion"]
        avoid = ["momentum_factor_12_1"]
        desc = (
            f"Elevated volatility (VIX={vix_value}, RV={rv_21d:.1%}). "
            "Reduce exposure 50%. Prefer mean reversion."
        )
    else:  # crisis
        size_multiplier = 0.10
        preferred = []
        avoid = ["momentum_factor_12_1", "ema_crossover_9_21", "bollinger_squeeze"]
        desc = (
            f"CRISIS (VIX={vix_value}, RV={rv_21d:.1%}). Maximum caution. Activate circuit breaker."
        )

    if not market_trend_up and regime == "low":
        regime = "normal"
        size_multiplier = 0.75
        desc += " (adjusted: market below MA200)"

    return RegimeResult(
        regime=regime,
        vix=round(vix_value, 2) if vix_value else None,
        rv_21d=round(rv_21d, 4),
        rv_percentile=rv_percentile,
        size_multiplier=size_multiplier,
        preferred_strategies=preferred,
        avoid_strategies=avoid,
        market_trend_up=market_trend_up,
        vix_term_structure=vix_term,
        description=desc,
    )
