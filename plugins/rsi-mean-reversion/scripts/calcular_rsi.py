"""
Cálculo de RSI con suavizado correcto de Wilder.

El suavizado de Wilder usa α = 1/n, que es equivalente a una EMA con
com = n-1 (no el factor estándar 2/(n+1)). Muchas implementaciones usan
EMA estándar y el resultado difiere significativamente.

Referencia: Wilder, J.W. (1978). New Concepts in Technical Trading Systems.
"""

from __future__ import annotations

import json
import sys
from typing import TypedDict


class RSIResult(TypedDict):
    rsi: list[float | None]
    signal: str  # "oversold" | "overbought" | "neutral" | "divergence_bull" | "divergence_bear"
    last_rsi: float | None
    bars_in_zone: int  # cuántas barras consecutivas en zona extrema


def wilder_rsi(closes: list[float], period: int = 14) -> list[float | None]:
    """
    RSI con suavizado exponencial de Wilder (Wilder Smoothing Method).

    α = 1/period  →  equivalente a EMA con com = period - 1

    Args:
        closes: lista de precios de cierre (orden cronológico)
        period: período del RSI (default 14, estándar Wilder)

    Returns:
        lista de RSI values, None para los primeros `period` elementos
    """
    n = len(closes)
    if n < period + 1:
        return [None] * n

    rsi_values: list[float | None] = [None] * period

    # Cálculo inicial: promedio simple de las primeras `period` deltas
    deltas = [closes[i] - closes[i - 1] for i in range(1, n)]
    gains = [max(d, 0.0) for d in deltas]
    losses = [abs(min(d, 0.0)) for d in deltas]

    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period

    def to_rsi(ag: float, al: float) -> float:
        if al == 0:
            return 100.0
        rs = ag / al
        return 100.0 - (100.0 / (1.0 + rs))

    rsi_values.append(to_rsi(avg_gain, avg_loss))

    # Suavizado de Wilder: EMA con α = 1/period
    alpha = 1.0 / period
    for i in range(period, len(deltas)):
        avg_gain = alpha * gains[i] + (1 - alpha) * avg_gain
        avg_loss = alpha * losses[i] + (1 - alpha) * avg_loss
        rsi_values.append(to_rsi(avg_gain, avg_loss))

    return rsi_values


def detect_divergence(
    closes: list[float],
    rsi: list[float | None],
    lookback: int = 10,
) -> str:
    """
    Detecta divergencias alcistas/bajistas entre precio y RSI.

    Divergencia alcista: precio hace mínimo más bajo, RSI hace mínimo más alto.
    Divergencia bajista: precio hace máximo más alto, RSI hace máximo más bajo.
    """
    valid_rsi = [(i, r) for i, r in enumerate(rsi) if r is not None]
    if len(valid_rsi) < lookback:
        return "neutral"

    recent = valid_rsi[-lookback:]
    prices_recent = [closes[i] for i, _ in recent]
    rsi_recent = [r for _, r in recent]

    # Ventana anterior para comparar
    prev_start = max(0, len(valid_rsi) - 2 * lookback)
    prev = valid_rsi[prev_start : len(valid_rsi) - lookback]
    if not prev:
        return "neutral"

    prices_prev = [closes[i] for i, _ in prev]
    rsi_prev = [r for _, r in prev]

    price_min_now = min(prices_recent)
    price_max_now = max(prices_recent)
    rsi_min_now = min(rsi_recent)
    rsi_max_now = max(rsi_recent)

    price_min_prev = min(prices_prev)
    price_max_prev = max(prices_prev)
    rsi_min_prev = min(rsi_prev)
    rsi_max_prev = max(rsi_prev)

    if price_min_now < price_min_prev and rsi_min_now > rsi_min_prev:
        return "divergence_bull"
    if price_max_now > price_max_prev and rsi_max_now < rsi_max_prev:
        return "divergence_bear"
    return "neutral"


def analyze(
    closes: list[float],
    period: int = 14,
    oversold: float = 30.0,
    overbought: float = 70.0,
    confirmation_bars: int = 2,
) -> RSIResult:
    rsi = wilder_rsi(closes, period)
    valid = [r for r in rsi if r is not None]

    if not valid:
        return RSIResult(rsi=rsi, signal="neutral", last_rsi=None, bars_in_zone=0)

    last_rsi = valid[-1]

    # Contar barras consecutivas en zona extrema
    bars_in_zone = 0
    for r in reversed(valid):
        if r < oversold or r > overbought:
            bars_in_zone += 1
        else:
            break

    # Determinar señal
    divergence = detect_divergence(closes, rsi)
    if divergence in ("divergence_bull", "divergence_bear"):
        signal = divergence
    elif last_rsi < oversold and bars_in_zone >= confirmation_bars:
        signal = "oversold"
    elif last_rsi > overbought and bars_in_zone >= confirmation_bars:
        signal = "overbought"
    else:
        signal = "neutral"

    return RSIResult(rsi=rsi, signal=signal, last_rsi=last_rsi, bars_in_zone=bars_in_zone)


if __name__ == "__main__":
    # El sandbox pasa los datos vía stdin como JSON
    data = json.load(sys.stdin)
    closes: list[float] = data["closes"]
    period: int = data.get("period", 14)
    oversold: float = data.get("oversold", 30.0)
    overbought: float = data.get("overbought", 70.0)
    confirmation_bars: int = data.get("confirmation_bars", 2)

    result = analyze(closes, period, oversold, overbought, confirmation_bars)
    print(json.dumps({"ok": True, "result": result}))
