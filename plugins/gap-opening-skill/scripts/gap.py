"""
Gap Opening Strategy — análisis de gaps de apertura.

Dos tipos de gap trades:
1. Gap Fade (mean reversion): gaps > large_gap_pct tienden a rellenarse en el día
2. Gap and Go (momentum): gaps pequeños en dirección de tendencia tienden a continuar

Referencias:
- Toby Crabel, "Day Trading With Short Term Price Patterns" (1990)
- Larry Connors, "High Probability ETF Trading" (2009)
- Jeff Cooper, "Hit and Run Trading" (1996)
"""

from dataclasses import dataclass


@dataclass
class GapAnalysis:
    symbol: str
    gap_pct: float  # positivo = gap up, negativo = gap down
    gap_type: str  # "large_up" | "large_down" | "small_up" | "small_down" | "none"
    strategy: str  # "fade" | "continuation" | "none"
    direction: str  # "long" | "short" | "none"
    confidence: float  # 0.0 - 1.0
    volume_confirmed: bool
    trend: str  # "up" | "down" | "flat"
    prev_close: float
    open_price: float
    reason: str


def compute_ema(prices: list[float], period: int) -> float:
    """EMA de un serie de precios."""
    if len(prices) < period:
        return prices[-1] if prices else 0.0
    k = 2 / (period + 1)
    ema = sum(prices[:period]) / period
    for price in prices[period:]:
        ema = price * k + ema * (1 - k)
    return ema


def determine_trend(closes: list[float], ema_period: int) -> str:
    """Determina la tendencia comparando precio actual con EMA."""
    if len(closes) < ema_period:
        return "flat"
    ema = compute_ema(closes, ema_period)
    current = closes[-1]
    diff_pct = (current - ema) / ema * 100
    if diff_pct > 1.5:
        return "up"
    elif diff_pct < -1.5:
        return "down"
    return "flat"


def analyze_gap(
    symbol: str,
    bars: list[dict],  # lista de barras OHLCV, ordenadas ascendente
    cfg: dict,
) -> GapAnalysis | None:
    """
    Analiza si hay un gap de apertura significativo en la última barra.

    bars: [{date, open, high, low, close, volume}, ...]
    """
    if len(bars) < 3:
        return None

    gap_threshold = cfg.get("gap_threshold_pct", 0.5)
    large_gap_thresh = cfg.get("large_gap_pct", 2.0)
    vol_mult = cfg.get("volume_confirm_mult", 1.5)
    ema_period = cfg.get("trend_ema_period", 20)
    fade_large = cfg.get("fade_large_gaps", True)
    follow_small = cfg.get("follow_small_gaps", True)

    prev_bar = bars[-2]
    curr_bar = bars[-1]

    prev_close = prev_bar["close"]
    curr_open = curr_bar["open"]
    curr_volume = curr_bar.get("volume", 0)

    if prev_close <= 0:
        return None

    gap_pct = (curr_open - prev_close) / prev_close * 100

    if abs(gap_pct) < gap_threshold:
        return GapAnalysis(
            symbol=symbol,
            gap_pct=round(gap_pct, 3),
            gap_type="none",
            strategy="none",
            direction="none",
            confidence=0,
            volume_confirmed=False,
            trend="flat",
            prev_close=prev_close,
            open_price=curr_open,
            reason=f"Gap {gap_pct:.2f}% < umbral {gap_threshold}%",
        )

    # Calcular volumen promedio de los últimos N días
    recent_volumes = [b.get("volume", 0) for b in bars[-11:-1]]  # últimos 10 días
    avg_volume = sum(recent_volumes) / len(recent_volumes) if recent_volumes else 1
    volume_confirmed = curr_volume > avg_volume * vol_mult

    # Tendencia usando EMA sobre cierres
    closes = [b["close"] for b in bars[:-1]]
    trend = determine_trend(closes, ema_period)

    # Clasificar gap
    is_large = abs(gap_pct) >= large_gap_thresh

    if gap_pct > 0:
        gap_type = "large_up" if is_large else "small_up"
    else:
        gap_type = "large_down" if is_large else "small_down"

    # Estrategia
    if is_large and fade_large:
        # Gaps grandes: fade (mean reversion)
        strategy = "fade"
        direction = "short" if gap_pct > 0 else "long"

        # Confianza mayor si el gap es muy grande (más extremo = más probable reversión)
        confidence = min(0.4 + abs(gap_pct) * 0.05, 0.80)
        if volume_confirmed:
            confidence = min(confidence + 0.10, 0.85)

        vol_str = "confirmado" if volume_confirmed else "sin confirmar"
        reason = (
            f"Gap {'up' if gap_pct > 0 else 'down'} grande ({gap_pct:+.2f}%) → "
            f"fade (mean reversion). Volumen {vol_str}."
        )

    elif not is_large and follow_small:
        # Gaps pequeños en dirección de tendencia: continuar
        gap_aligned_with_trend = (gap_pct > 0 and trend == "up") or (
            gap_pct < 0 and trend == "down"
        )

        if gap_aligned_with_trend:
            strategy = "continuation"
            direction = "long" if gap_pct > 0 else "short"
            confidence = 0.45
            if volume_confirmed:
                confidence += 0.15
            if abs(gap_pct) > 1.0:
                confidence += 0.10
            confidence = min(confidence, 0.75)

            reason = (
                f"Gap {'up' if gap_pct > 0 else 'down'} pequeño ({gap_pct:+.2f}%) "
                f"alineado con tendencia {trend.upper()} → continuación. "
                f"Volumen {'confirmado' if volume_confirmed else 'sin confirmar'}."
            )
        else:
            strategy = "none"
            direction = "none"
            confidence = 0
            reason = f"Gap {gap_pct:+.2f}% en contra de tendencia {trend.upper()} → sin señal"
    else:
        strategy = "none"
        direction = "none"
        confidence = 0
        reason = f"Gap {gap_pct:+.2f}% no cumple criterios"

    return GapAnalysis(
        symbol=symbol,
        gap_pct=round(gap_pct, 3),
        gap_type=gap_type,
        strategy=strategy,
        direction=direction,
        confidence=round(confidence, 3),
        volume_confirmed=volume_confirmed,
        trend=trend,
        prev_close=round(prev_close, 4),
        open_price=round(curr_open, 4),
        reason=reason,
    )
