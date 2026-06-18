"""
Bollinger Band Squeeze — implementación de referencia.

Método: TTM Squeeze (Carter 2002) con indicador de momentum basado en
regresión lineal del precio sobre las bandas.

Squeeze = BB dentro de Keltner Channel (volatilidad comprimida)
Ruptura = cuando BB sale de KC (liberación de energía)
Dirección = indicada por el momentum (precio relativo a BB media)
"""

from __future__ import annotations

import json
import math
import sys
from dataclasses import asdict, dataclass


@dataclass
class SqueezeResult:
    symbol: str
    in_squeeze: bool  # True si BB está dentro de Keltner
    squeeze_bars: int  # cuántas barras consecutivas en squeeze
    momentum: float  # valor de momentum (positivo = alcista)
    momentum_direction: str  # "up" | "down" | "flat"
    signal: str  # "long_breakout" | "short_breakout" | "squeeze_forming" | "none"
    bb_upper: float
    bb_lower: float
    bb_width_pct: float  # ancho de BB como % del precio
    kc_upper: float
    kc_lower: float
    price: float
    confidence: float  # 0.0 - 1.0 basado en duración del squeeze


def _sma(values: list[float], period: int) -> list[float]:
    result = []
    for i in range(len(values)):
        if i < period - 1:
            result.append(float("nan"))
        else:
            result.append(sum(values[i - period + 1 : i + 1]) / period)
    return result


def _std(values: list[float], period: int) -> list[float]:
    result = []
    for i in range(len(values)):
        if i < period - 1:
            result.append(float("nan"))
        else:
            window = values[i - period + 1 : i + 1]
            mean = sum(window) / period
            variance = sum((v - mean) ** 2 for v in window) / (period - 1)
            result.append(math.sqrt(variance))
    return result


def _atr(highs: list[float], lows: list[float], closes: list[float], period: int) -> list[float]:
    trs: list[float] = [highs[0] - lows[0]]
    for i in range(1, len(highs)):
        tr = max(highs[i] - lows[i], abs(highs[i] - closes[i - 1]), abs(lows[i] - closes[i - 1]))
        trs.append(tr)

    # Wilder smoothing
    atrs: list[float] = [float("nan")] * (period - 1)
    if len(trs) >= period:
        atr_val = sum(trs[:period]) / period
        atrs.append(atr_val)
        for tr in trs[period:]:
            atr_val = (atr_val * (period - 1) + tr) / period
            atrs.append(atr_val)
    return atrs


def _momentum_regression(closes: list[float], period: int) -> list[float]:
    """
    Momentum = desviación del precio respecto a regresión lineal simple
    sobre N periodos. Positivo = precio por encima de tendencia → alcista.
    """
    results: list[float] = [float("nan")] * (period - 1)
    for i in range(period - 1, len(closes)):
        window = closes[i - period + 1 : i + 1]
        n = len(window)
        x = list(range(n))
        x_mean = (n - 1) / 2.0
        y_mean = sum(window) / n
        num = sum((x[j] - x_mean) * (window[j] - y_mean) for j in range(n))
        den = sum((x[j] - x_mean) ** 2 for j in range(n))
        slope = num / den if den != 0 else 0.0
        intercept = y_mean - slope * x_mean
        mid_point = slope * (n // 2) + intercept
        results.append(closes[i] - mid_point)
    return results


def analyze(
    symbol: str,
    closes: list[float],
    highs: list[float],
    lows: list[float],
    bb_period: int = 20,
    bb_std: float = 2.0,
    kc_period: int = 20,
    kc_multiplier: float = 1.5,
    min_squeeze_bars: int = 5,
) -> SqueezeResult:
    """
    Detecta squeeze de Bollinger y genera señal de ruptura.

    Args:
        closes/highs/lows:   OHLCV (orden cronológico)
        bb_period:           período BB (default 20)
        bb_std:              desviaciones estándar (default 2.0)
        kc_period:           período Keltner (default 20)
        kc_multiplier:       multiplicador ATR para Keltner (default 1.5)
        min_squeeze_bars:    barras mínimas en squeeze para señal válida (default 5)
    """
    min_bars = max(bb_period, kc_period) * 2
    empty = SqueezeResult(
        symbol=symbol,
        in_squeeze=False,
        squeeze_bars=0,
        momentum=0.0,
        momentum_direction="flat",
        signal="none",
        bb_upper=0.0,
        bb_lower=0.0,
        bb_width_pct=0.0,
        kc_upper=0.0,
        kc_lower=0.0,
        price=closes[-1] if closes else 0.0,
        confidence=0.0,
    )

    if len(closes) < min_bars:
        return empty

    # Bollinger Bands
    sma_series = _sma(closes, bb_period)
    std_series = _std(closes, bb_period)
    atr_series = _atr(highs, lows, closes, kc_period)
    momentum_series = _momentum_regression(closes, bb_period)

    # Detectar squeezes consecutivos (BB dentro de KC en cada barra)
    squeeze_bars = 0
    for i in range(len(closes) - 1, max(len(closes) - 50, -1), -1):
        if math.isnan(sma_series[i]) or math.isnan(std_series[i]) or math.isnan(atr_series[i]):
            break
        bb_u = sma_series[i] + bb_std * std_series[i]
        bb_l = sma_series[i] - bb_std * std_series[i]
        kc_u = sma_series[i] + kc_multiplier * atr_series[i]
        kc_l = sma_series[i] - kc_multiplier * atr_series[i]
        if bb_u <= kc_u and bb_l >= kc_l:
            squeeze_bars += 1
        else:
            break

    # Valores actuales
    i = -1
    bb_upper = sma_series[i] + bb_std * std_series[i]
    bb_lower = sma_series[i] - bb_std * std_series[i]
    kc_upper = sma_series[i] + kc_multiplier * atr_series[i]
    kc_lower = sma_series[i] - kc_multiplier * atr_series[i]
    momentum = momentum_series[i] if not math.isnan(momentum_series[i]) else 0.0
    price = closes[-1]

    in_squeeze = bb_upper <= kc_upper and bb_lower >= kc_lower
    bb_width_pct = (bb_upper - bb_lower) / sma_series[i] * 100 if sma_series[i] != 0 else 0.0

    # Dirección del momentum
    if len(momentum_series) >= 2 and not math.isnan(momentum_series[-2]):
        prev_mom = momentum_series[-2]
        if momentum > prev_mom and momentum > 0:
            momentum_direction = "up"
        elif momentum < prev_mom and momentum < 0:
            momentum_direction = "down"
        else:
            momentum_direction = "flat"
    else:
        momentum_direction = "flat"

    # Señal: ruptura del squeeze con dirección confirmada
    signal = "none"
    confidence = 0.0

    if squeeze_bars == 0 and not in_squeeze and len(closes) >= 2:
        # Acabamos de salir del squeeze (barra anterior en squeeze)
        # Verificar que la barra anterior SÍ estaba en squeeze
        i_prev = -2
        if not (
            math.isnan(sma_series[i_prev])
            or math.isnan(std_series[i_prev])
            or math.isnan(atr_series[i_prev])
        ):
            bb_u_prev = sma_series[i_prev] + bb_std * std_series[i_prev]
            bb_l_prev = sma_series[i_prev] - bb_std * std_series[i_prev]
            kc_u_prev = sma_series[i_prev] + kc_multiplier * atr_series[i_prev]
            kc_l_prev = sma_series[i_prev] - kc_multiplier * atr_series[i_prev]
            was_in_squeeze = bb_u_prev <= kc_u_prev and bb_l_prev >= kc_l_prev
            if was_in_squeeze:
                squeeze_bars = 1  # reconstruir: al menos 1 barra

    # Cuenta las barras de squeeze previas para la señal
    prior_squeeze = squeeze_bars
    if in_squeeze:
        signal = "squeeze_forming"
        confidence = min(squeeze_bars / (min_squeeze_bars * 2), 0.9)
    elif prior_squeeze >= min_squeeze_bars or not in_squeeze:
        if momentum_direction == "up" and momentum > 0:
            signal = "long_breakout"
            confidence = min(0.4 + prior_squeeze * 0.05, 0.9)
        elif momentum_direction == "down" and momentum < 0:
            signal = "short_breakout"
            confidence = min(0.4 + prior_squeeze * 0.05, 0.9)

    return SqueezeResult(
        symbol=symbol,
        in_squeeze=in_squeeze,
        squeeze_bars=squeeze_bars,
        momentum=round(momentum, 4),
        momentum_direction=momentum_direction,
        signal=signal,
        bb_upper=round(bb_upper, 4),
        bb_lower=round(bb_lower, 4),
        bb_width_pct=round(bb_width_pct, 4),
        kc_upper=round(kc_upper, 4),
        kc_lower=round(kc_lower, 4),
        price=round(price, 4),
        confidence=round(confidence, 4),
    )


if __name__ == "__main__":
    data = json.load(sys.stdin)
    results = []
    for item in data.get("symbols", []):
        r = analyze(
            symbol=item["symbol"],
            closes=item["closes"],
            highs=item.get("highs", item["closes"]),
            lows=item.get("lows", item["closes"]),
            bb_period=data.get("bb_period", 20),
            bb_std=data.get("bb_std", 2.0),
            kc_period=data.get("kc_period", 20),
            kc_multiplier=data.get("kc_multiplier", 1.5),
            min_squeeze_bars=data.get("min_squeeze_bars", 5),
        )
        results.append(asdict(r))
    print(json.dumps({"ok": True, "results": results}))
