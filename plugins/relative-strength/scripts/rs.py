"""Relative Strength de Levy (1968) / O'Neil CANSLIM — RS ponderado multi-período."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class RSResult:
    symbol: str
    rs_scores: dict[int, float]  # {periodo_dias: rs_ratio}
    composite_rs: float  # RS ponderado
    percentile_rank: float  # 0-100 dentro del universo
    action: str  # "long" | "hold"
    signal_strength: float
    reason: str


def compute_return(prices: list[float], period: int) -> float | None:
    """Retorno total (no anualizado) en N barras."""
    if len(prices) < period + 1:
        return None
    start = prices[-(period + 1)]
    end = prices[-1]
    if start == 0:
        return None
    return (end - start) / start


def compute_composite_rs(
    prices: list[float],
    benchmark_prices: list[float],
    periods: list[int],
    weights: list[float],
) -> dict | None:
    """Calcula RS compuesto ponderado para múltiples períodos."""
    if len(weights) != len(periods):
        return None

    rs_scores: dict[int, float] = {}
    composite = 0.0
    valid_weight = 0.0

    for period, weight in zip(periods, weights, strict=False):
        asset_ret = compute_return(prices, period)
        bench_ret = compute_return(benchmark_prices, period)

        if asset_ret is None or bench_ret is None:
            continue

        # RS ratio: retorno relativo al benchmark
        # RS > 1 = outperforma, RS < 1 = underperforma
        bench_adj = bench_ret if bench_ret != -1 else -0.999
        rs = (1 + asset_ret) / (1 + bench_adj)
        rs_scores[period] = rs
        composite += rs * weight
        valid_weight += weight

    if valid_weight == 0:
        return None

    composite_rs = composite / valid_weight
    return {"rs_scores": rs_scores, "composite_rs": composite_rs}


def percentile_rank(value: float, all_values: list[float]) -> float:
    """Percentil de value dentro de all_values (0-100)."""
    if not all_values:
        return 50.0
    below = sum(1 for v in all_values if v < value)
    return (below / len(all_values)) * 100.0


def analyze_relative_strength(
    symbol: str,
    prices: list[float],
    benchmark_prices: list[float],
    universe_rs_values: list[float],
    periods: list[int] | None = None,
    weights: list[float] | None = None,
    rs_threshold: float = 1.05,
    top_percentile: float = 80.0,
) -> RSResult | None:
    if periods is None:
        periods = [63, 126, 189, 252]
    if weights is None:
        weights = [0.4, 0.2, 0.2, 0.2]

    result = compute_composite_rs(prices, benchmark_prices, periods, weights)
    if result is None:
        return None

    composite_rs = result["composite_rs"]
    rs_scores = result["rs_scores"]

    # Añadir el RS compuesto al universo para calcular percentil
    all_rs = universe_rs_values + [composite_rs]
    pct_rank = percentile_rank(composite_rs, all_rs)

    # Señal: RS > umbral Y en top percentile del universo
    action = "hold"
    reasons: list[str] = []

    if composite_rs >= rs_threshold:
        reasons.append(f"RS compuesto={composite_rs:.3f} (umbral={rs_threshold:.3f})")

    if pct_rank >= top_percentile:
        reasons.append(f"percentil={pct_rank:.0f}% (mínimo={top_percentile:.0f}%)")

    if composite_rs >= rs_threshold and pct_rank >= top_percentile:
        action = "long"

    strength = min(1.0, max(0.0, (composite_rs - 1.0) * 5.0)) if composite_rs > 1 else 0.0

    period_str = " | ".join(f"{p}d={v:.3f}" for p, v in rs_scores.items())
    reason = f"{symbol}: RS={composite_rs:.3f} pct={pct_rank:.0f}% | {period_str}"

    return RSResult(
        symbol=symbol,
        rs_scores=rs_scores,
        composite_rs=composite_rs,
        percentile_rank=pct_rank,
        action=action,
        signal_strength=strength,
        reason=reason,
    )
