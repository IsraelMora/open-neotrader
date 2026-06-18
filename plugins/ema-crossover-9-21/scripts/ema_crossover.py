"""
EMA Crossover 9/21 — implementación de referencia.

Calcula EMA rápida y lenta, detecta cruces y genera señales de trading
con stop dinámico ATR.
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict, dataclass


@dataclass
class EmaResult:
    symbol: str
    ema_fast: float
    ema_slow: float
    atr14: float
    signal: str  # "long" | "short" | "exit_long" | "exit_short" | "none"
    stop_loss: float | None
    take_profit_trail: float | None
    cross_type: str  # "golden" | "death" | "none"
    confirmed: bool  # confirmación de barras
    spread_pct: float  # (ema_fast - ema_slow) / ema_slow × 100


def compute_ema(prices: list[float], period: int) -> list[float]:
    """Calcula EMA para una serie de precios."""
    if len(prices) < period:
        return []

    alpha = 2.0 / (period + 1)
    emas: list[float] = []

    # Inicializar con SMA del primer período
    sma_init = sum(prices[:period]) / period
    emas.append(sma_init)

    for price in prices[period:]:
        ema = price * alpha + emas[-1] * (1 - alpha)
        emas.append(ema)

    return emas


def compute_atr(
    highs: list[float], lows: list[float], closes: list[float], period: int = 14
) -> float:
    """Calcula ATR usando Wilder's smoothing."""
    if len(highs) < period + 1:
        return 0.0

    true_ranges: list[float] = []
    for i in range(1, len(highs)):
        tr = max(
            highs[i] - lows[i],
            abs(highs[i] - closes[i - 1]),
            abs(lows[i] - closes[i - 1]),
        )
        true_ranges.append(tr)

    if len(true_ranges) < period:
        return 0.0

    # ATR inicial = SMA de primeros N true ranges
    atr = sum(true_ranges[:period]) / period

    # Wilder smoothing para el resto
    for tr in true_ranges[period:]:
        atr = (atr * (period - 1) + tr) / period

    return atr


def analyze(
    symbol: str,
    closes: list[float],
    highs: list[float],
    lows: list[float],
    fast_period: int = 9,
    slow_period: int = 21,
    confirmation_bars: int = 1,
    atr_stop_multiplier: float = 2.0,
) -> EmaResult:
    """
    Analiza una serie de precios y detecta señales de cruce EMA.

    Args:
        symbol:               ticker del activo
        closes:               precios de cierre (orden cronológico, más reciente al final)
        highs/lows:           OHLC para ATR
        fast_period:          período EMA rápida (default 9)
        slow_period:          período EMA lenta (default 21)
        confirmation_bars:    barras consecutivas de confirmación
        atr_stop_multiplier:  multiplicador ATR para stop loss

    Returns:
        EmaResult con señal y niveles
    """
    min_bars = slow_period * 2 + confirmation_bars + 5

    if len(closes) < min_bars:
        return EmaResult(
            symbol=symbol,
            ema_fast=0.0,
            ema_slow=0.0,
            atr14=0.0,
            signal="none",
            stop_loss=None,
            take_profit_trail=None,
            cross_type="none",
            confirmed=False,
            spread_pct=0.0,
        )

    ema_fast_series = compute_ema(closes, fast_period)
    ema_slow_series = compute_ema(closes, slow_period)

    # Alinear las dos series (ema_slow es más corta)
    diff = len(ema_fast_series) - len(ema_slow_series)
    if diff > 0:
        ema_fast_series = ema_fast_series[diff:]

    if len(ema_fast_series) < confirmation_bars + 2:
        return EmaResult(
            symbol=symbol,
            ema_fast=0.0,
            ema_slow=0.0,
            atr14=0.0,
            signal="none",
            stop_loss=None,
            take_profit_trail=None,
            cross_type="none",
            confirmed=False,
            spread_pct=0.0,
        )

    ef_now = ema_fast_series[-1]
    es_now = ema_slow_series[-1]
    ef_prev = ema_fast_series[-2]
    es_prev = ema_slow_series[-2]

    # Detectar cruce
    golden_cross = ef_now > es_now and ef_prev <= es_prev
    death_cross = ef_now < es_now and ef_prev >= es_prev

    cross_type = "none"
    if golden_cross:
        cross_type = "golden"
    elif death_cross:
        cross_type = "death"

    # Confirmación: las últimas N barras mantienen la posición relativa
    confirmed = True
    if confirmation_bars > 0 and cross_type != "none":
        for i in range(1, confirmation_bars + 1):
            if i >= len(ema_fast_series):
                confirmed = False
                break
            ef_i = ema_fast_series[-i]
            es_i = ema_slow_series[-i]
            if cross_type == "golden" and ef_i <= es_i:
                confirmed = False
                break
            if cross_type == "death" and ef_i >= es_i:
                confirmed = False
                break

    # ATR para stops
    atr14 = compute_atr(highs, lows, closes, 14)

    # Determinar señal
    signal = "none"
    stop_loss: float | None = None
    take_profit_trail: float | None = None
    current_price = closes[-1]

    if cross_type == "golden" and confirmed:
        signal = "long"
        if atr14 > 0:
            stop_loss = round(current_price - atr14 * atr_stop_multiplier, 4)
            take_profit_trail = round(current_price + atr14 * atr_stop_multiplier * 1.5, 4)
    elif cross_type == "death" and confirmed:
        signal = "exit_long"  # salida si estamos long; también short si estrategia lo permite
        if atr14 > 0:
            stop_loss = round(current_price + atr14 * atr_stop_multiplier, 4)

    spread_pct = (ef_now - es_now) / es_now * 100 if es_now != 0 else 0.0

    return EmaResult(
        symbol=symbol,
        ema_fast=round(ef_now, 4),
        ema_slow=round(es_now, 4),
        atr14=round(atr14, 4),
        signal=signal,
        stop_loss=stop_loss,
        take_profit_trail=take_profit_trail,
        cross_type=cross_type,
        confirmed=confirmed,
        spread_pct=round(spread_pct, 4),
    )


if __name__ == "__main__":
    data = json.load(sys.stdin)

    results = []
    for item in data.get("symbols", []):
        result = analyze(
            symbol=item["symbol"],
            closes=item["closes"],
            highs=item.get("highs", item["closes"]),
            lows=item.get("lows", item["closes"]),
            fast_period=data.get("fast_period", 9),
            slow_period=data.get("slow_period", 21),
            confirmation_bars=data.get("confirmation_bars", 1),
            atr_stop_multiplier=data.get("atr_stop_multiplier", 2.0),
        )
        results.append(asdict(result))

    print(json.dumps({"ok": True, "results": results}))
