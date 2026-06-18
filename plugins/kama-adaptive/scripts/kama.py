"""
kama.py — Kaufman Adaptive Moving Average (1995)

El KAMA resuelve el problema fundamental de las EMAs fijas:
  - EMA rápida (período corto): captura tendencias pero genera muchos whipsaws en laterales
  - EMA lenta (período largo): filtra ruido pero llega tarde a tendencias

KAMA adapta su velocidad según la Efficiency Ratio (ER):
  ER = |Price[0] - Price[-n]| / Σ|Price[i] - Price[i-1]|  ∈ [0, 1]

  ER ≈ 1 → mercado muy tendencial → KAMA se mueve rápido (fast EMA)
  ER ≈ 0 → mercado muy caótico/lateral → KAMA se mueve lento (slow EMA)

Referencia:
  Kaufman, P.J. (1995) "Smarter Trading" — Capítulo 8.
  Perry Kaufman (2013) "Trading Systems and Methods" — 5th Ed., KAMA.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any


@dataclass
class KamaResult:
    kama: list[float]
    er: list[float]  # Efficiency Ratio en cada punto
    sc: list[float]  # Smoothing Constant en cada punto
    signals: list[dict]  # señales de cruce KAMA/precio
    regime: list[str]  # "trending" | "ranging" | "warming_up"


def compute_kama(
    prices: list[float],
    period: int = 10,
    fast_period: int = 2,
    slow_period: int = 30,
    signal_threshold: float = 0.001,
    warmup_bars: int = 30,
) -> KamaResult:
    """
    Calcula el KAMA completo sobre una serie de precios.

    Args:
        prices:          Series de cierres (orden cronológico).
        period:          Periodo de la Efficiency Ratio.
        fast_period:     Periodo EMA rápida (ER=1).
        slow_period:     Periodo EMA lenta (ER=0).
        signal_threshold: Cambio mínimo % en el precio vs KAMA para señal.
        warmup_bars:     Barras de calentamiento (sin señales).

    Returns:
        KamaResult con KAMA, ER, SC, señales y régimen por barra.
    """
    if len(prices) < period + 1:
        raise ValueError(f"Se necesitan al menos {period + 1} precios (tenemos {len(prices)})")

    # Constantes de smoothing
    fast_sc = 2.0 / (fast_period + 1)
    slow_sc = 2.0 / (slow_period + 1)

    kama_vals: list[float] = [float("nan")] * len(prices)
    er_vals: list[float] = [0.0] * len(prices)
    sc_vals: list[float] = [0.0] * len(prices)

    # Inicializar KAMA en la primera barra disponible
    kama_vals[period - 1] = prices[period - 1]

    for i in range(period, len(prices)):
        # Efficiency Ratio: movimiento neto / sum de movimientos absolutos
        direction = abs(prices[i] - prices[i - period])
        volatility = sum(abs(prices[j] - prices[j - 1]) for j in range(i - period + 1, i + 1))

        er = direction / volatility if volatility > 1e-10 else 0.0
        sc = (er * (fast_sc - slow_sc) + slow_sc) ** 2  # smoothing constant al cuadrado (Kaufman)

        prev_kama = kama_vals[i - 1] if not math.isnan(kama_vals[i - 1]) else prices[i - 1]
        kama_vals[i] = prev_kama + sc * (prices[i] - prev_kama)
        er_vals[i] = er
        sc_vals[i] = sc

    # Generar señales de cruce y régimen
    signals: list[dict] = []
    regime_vals: list[str] = ["warming_up"] * len(prices)

    for i in range(period, len(prices)):
        if i < warmup_bars:
            continue

        kama = kama_vals[i]
        prev_kama = kama_vals[i - 1]
        price = prices[i]
        er = er_vals[i]

        if math.isnan(kama) or math.isnan(prev_kama):
            continue

        # Clasificar régimen
        regime = "trending" if er > 0.6 else "ranging"
        regime_vals[i] = regime

        # Señal: precio cruza KAMA con suficiente distancia (signal_threshold)
        pct_from_kama = (price - kama) / kama if kama > 0 else 0.0
        prev_pct = (prices[i - 1] - prev_kama) / prev_kama if prev_kama > 0 else 0.0

        # Cruce alcista: precio pasa de bajo KAMA a sobre KAMA con umbral
        if prev_pct < 0 and pct_from_kama > signal_threshold and regime == "trending":
            signals.append(
                {
                    "bar": i,
                    "action": "buy",
                    "price": price,
                    "kama": kama,
                    "er": er,
                    "pct_from_kama": pct_from_kama,
                    "regime": regime,
                    "confidence": min(er * 1.5, 1.0),
                }
            )
        # Cruce bajista
        elif prev_pct > 0 and pct_from_kama < -signal_threshold and regime == "trending":
            signals.append(
                {
                    "bar": i,
                    "action": "sell",
                    "price": price,
                    "kama": kama,
                    "er": er,
                    "pct_from_kama": pct_from_kama,
                    "regime": regime,
                    "confidence": min(er * 1.5, 1.0),
                }
            )

    return KamaResult(
        kama=kama_vals,
        er=er_vals,
        sc=sc_vals,
        signals=signals,
        regime=regime_vals,
    )


def analyze_symbol(
    symbol: str,
    prices: list[float],
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """API de alto nivel — analiza un símbolo y devuelve señal actual + diagnóstico."""
    cfg = config or {}
    period = int(cfg.get("period", 10))
    fast = int(cfg.get("fast_period", 2))
    slow = int(cfg.get("slow_period", 30))
    threshold = float(cfg.get("signal_threshold", 0.001))
    warmup = int(cfg.get("warmup_bars", 30))

    if len(prices) < max(period + 1, warmup):
        return {"symbol": symbol, "signal": "insufficient_data", "bars": len(prices)}

    result = compute_kama(prices, period, fast, slow, threshold, warmup)
    last_i = len(prices) - 1

    # Señal más reciente (si la hay en las últimas 3 barras)
    recent = [s for s in result.signals if s["bar"] >= last_i - 2]
    signal = recent[-1] if recent else None

    kama_now = result.kama[last_i]
    er_now = result.er[last_i]
    price_now = prices[last_i]

    return {
        "symbol": symbol,
        "signal": signal["action"] if signal else "hold",
        "confidence": signal["confidence"] if signal else 0.0,
        "kama": round(kama_now, 6) if not math.isnan(kama_now) else None,
        "price": price_now,
        "er": round(er_now, 4),
        "regime": result.regime[last_i],
        "pct_from_kama": round((price_now - kama_now) / kama_now * 100, 3)
        if kama_now and not math.isnan(kama_now)
        else None,
        "bars_analyzed": len(prices),
        "last_signal": result.signals[-1] if result.signals else None,
    }
