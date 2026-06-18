"""
market_breadth.py — Indicadores de amplitud del mercado.

La amplitud del mercado mide cuántos activos del índice participan
en la dirección del índice. Un mercado que sube pero donde solo 10%
de los activos suben (breadth divergencia) es señal de fragilidad.

Indicadores implementados:
  1. Advance/Decline Ratio: activos que suben vs bajan
  2. % sobre MA200: activos por encima de su media de 200 días
  3. McClellan Oscillator: EMA rápida - EMA lenta del A/D Ratio
  4. New Highs / New Lows Ratio: activos en máximos vs mínimos de 52 semanas
  5. Breadth Thrust (Zweig): si en 10 días el AD pasa de <40% a >61.5% → rally potente
  6. Breadth Score compuesto: promedio ponderado de los anteriores (0-100)

Referencias:
  McClellan, S. & McClellan, T. (1970) — McClellan Oscillator original
  Zweig, M. (1986) "Winning on Wall Street" — Breadth Thrust
  Murphy, J.J. (1999) "Technical Analysis of Financial Markets" — Breadth indicators
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class BreadthResult:
    score: float  # 0-100 compuesto
    regime: str  # "bullish" | "neutral" | "bearish" | "extreme_bullish" | "extreme_bearish"
    ad_ratio: float  # Advance/Decline ratio
    pct_above_ma: float | None  # % activos sobre MA200 (requiere historial)
    mcclellan_osc: float | None  # Oscillator McClellan
    nh_nl_ratio: float | None  # New Highs / (New Highs + New Lows)
    breadth_thrust: bool  # Zweig Breadth Thrust detectado
    divergence: str | None  # "bearish_divergence" | "bullish_divergence" | None
    details: dict[str, float] = field(default_factory=dict)


def _ema(data: list[float], period: int) -> list[float]:
    """EMA simple."""
    if not data:
        return []
    k = 2.0 / (period + 1)
    result = [data[0]]
    for x in data[1:]:
        result.append(x * k + result[-1] * (1 - k))
    return result


def compute_breadth(
    advances: list[int],  # activos que subieron cada día
    declines: list[int],  # activos que bajaron cada día
    price_history: dict[str, list[float]] | None = None,  # histórico precios por símbolo
    index_prices: list[float] | None = None,  # precio del índice de referencia
    new_highs: list[int] | None = None,  # activos en max 52 semanas
    new_lows: list[int] | None = None,  # activos en min 52 semanas
    config: dict[str, Any] | None = None,
) -> BreadthResult:
    cfg = config or {}
    bull_thr = float(cfg.get("breadth_bullish_threshold", 70))
    bear_thr = float(cfg.get("breadth_bearish_threshold", 30))
    ma_period = int(cfg.get("ma_period", 200))
    mcl_fast = int(cfg.get("mcclellan_fast", 19))
    mcl_slow = int(cfg.get("mcclellan_slow", 39))
    thrust_period = int(cfg.get("thrust_period", 10))

    n = len(advances)
    if n == 0 or n != len(declines):
        return BreadthResult(50, "neutral", 1.0, None, None, None, False, None)

    # ── 1. Advance/Decline Ratio ──────────────────────────────────────────────
    adv_today = advances[-1]
    dec_today = declines[-1]
    total = adv_today + dec_today
    ad_ratio = adv_today / dec_today if dec_today > 0 else float("inf")
    ad_pct = adv_today / total * 100 if total > 0 else 50.0

    # ── 2. McClellan Oscillator ────────────────────────────────────────────────
    mcclellan_osc: float | None = None
    net_advances = [a - d for a, d in zip(advances, declines, strict=False)]
    if n >= mcl_slow:
        ema_fast = _ema(net_advances, mcl_fast)
        ema_slow = _ema(net_advances, mcl_slow)
        mcclellan_osc = ema_fast[-1] - ema_slow[-1]

    # ── 3. % activos sobre MA200 ───────────────────────────────────────────────
    pct_above_ma: float | None = None
    if price_history and len(price_history) > 0:
        above = 0
        total_checked = 0
        for hist in price_history.values():
            if len(hist) >= ma_period:
                ma = sum(hist[-ma_period:]) / ma_period
                if hist[-1] > ma:
                    above += 1
                total_checked += 1
        if total_checked > 0:
            pct_above_ma = above / total_checked * 100

    # ── 4. New Highs / New Lows ────────────────────────────────────────────────
    nh_nl_ratio: float | None = None
    if new_highs and new_lows and len(new_highs) > 0:
        nh, nl = new_highs[-1], new_lows[-1]
        total_hnl = nh + nl
        nh_nl_ratio = nh / total_hnl * 100 if total_hnl > 0 else 50.0

    # ── 5. Breadth Thrust de Zweig ────────────────────────────────────────────
    breadth_thrust = False
    if n >= thrust_period + 2:
        window_start = [
            advances[i] / (advances[i] + declines[i]) * 100
            if (advances[i] + declines[i]) > 0
            else 50
            for i in range(-thrust_period - 1, -1)
        ]
        window_end = [
            advances[i] / (advances[i] + declines[i]) * 100
            if (advances[i] + declines[i]) > 0
            else 50
            for i in range(-thrust_period, 0)
        ]
        if window_start and window_end and min(window_start) < 40 and max(window_end) > 61.5:
            breadth_thrust = True

    # ── 6. Divergencia precio/breadth ─────────────────────────────────────────
    divergence: str | None = None
    if index_prices and len(index_prices) >= 20 and n >= 20:
        idx_return = (index_prices[-1] - index_prices[-20]) / index_prices[-20]
        ad_sums_now = (
            sum(advances[-10:]) / sum(declines[-10:] or [1]) if sum(declines[-10:]) > 0 else 1
        )
        ad_sums_prev = (
            sum(advances[-20:-10]) / sum(declines[-20:-10] or [1])
            if sum(declines[-20:-10]) > 0
            else 1
        )
        ad_change = ad_sums_now - ad_sums_prev

        if idx_return > 0.03 and ad_change < -0.2:
            divergence = "bearish_divergence"  # índice sube pero breadth cae
        elif idx_return < -0.03 and ad_change > 0.2:
            divergence = "bullish_divergence"  # índice cae pero breadth sube (capitulación)

    # ── 7. Score compuesto ────────────────────────────────────────────────────
    components: list[float] = []

    # A/D Ratio normalizado: 0-100
    ad_score = min(ad_pct, 100)
    components.append(ad_score)

    # McClellan: normalizar -500/+500 → 0-100
    if mcclellan_osc is not None:
        mcl_score = max(0, min(100, (mcclellan_osc + 500) / 10))
        components.append(mcl_score)

    # % sobre MA200
    if pct_above_ma is not None:
        components.append(pct_above_ma)

    # NH/NL Ratio
    if nh_nl_ratio is not None:
        components.append(nh_nl_ratio)

    score = sum(components) / len(components) if components else 50.0

    # Thrust boost (Zweig: señal muy alcista)
    if breadth_thrust:
        score = min(100, score + 15)

    # Divergencia penalty
    if divergence == "bearish_divergence":
        score = max(0, score - 15)

    # ── 8. Régimen ────────────────────────────────────────────────────────────
    if score >= 80:
        regime = "extreme_bullish"
    elif score >= bull_thr:
        regime = "bullish"
    elif score <= 20:
        regime = "extreme_bearish"
    elif score <= bear_thr:
        regime = "bearish"
    else:
        regime = "neutral"

    return BreadthResult(
        score=round(score, 1),
        regime=regime,
        ad_ratio=round(ad_ratio, 3),
        pct_above_ma=round(pct_above_ma, 1) if pct_above_ma is not None else None,
        mcclellan_osc=round(mcclellan_osc, 2) if mcclellan_osc is not None else None,
        nh_nl_ratio=round(nh_nl_ratio, 1) if nh_nl_ratio is not None else None,
        breadth_thrust=breadth_thrust,
        divergence=divergence,
        details={
            "ad_pct": round(ad_pct, 1),
            "score_components": len(components),
        },
    )
