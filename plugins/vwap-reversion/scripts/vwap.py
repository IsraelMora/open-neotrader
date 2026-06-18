"""
VWAP Reversion — implementación de referencia.

El VWAP (Volume Weighted Average Price) es el precio promedio ponderado
por volumen desde la apertura del día. Las desviaciones extremas del VWAP
tienden a revertir dentro del mismo día.

Fórmula:
  VWAP = Σ(precio_típico_i × volumen_i) / Σ(volumen_i)
  precio_típico = (high + low + close) / 3

  Banda superior: VWAP + k × σ_vwap
  Banda inferior: VWAP - k × σ_vwap

  σ_vwap = sqrt(Σ(volumen_i × (precio_típico_i - VWAP)²) / Σ(volumen_i))
"""

from __future__ import annotations

import json
import math
import sys
from dataclasses import asdict, dataclass


@dataclass
class VwapBar:
    typical: float
    volume: float
    cumvol: float
    cumtp_vol: float
    cumtp2_vol: float
    vwap: float
    sigma: float
    band_upper: float
    band_lower: float


@dataclass
class VwapSignal:
    symbol: str
    current_price: float
    vwap: float
    sigma: float
    band_upper: float
    band_lower: float
    deviation_sigma: float  # distancia al VWAP en sigmas
    signal: str  # "long_reversion" | "short_reversion" | "near_vwap" | "none"
    target_price: float  # precio objetivo (% de vuelta al VWAP)
    stop_loss: float
    confidence: float


def compute_vwap_session(
    closes: list[float],
    highs: list[float],
    lows: list[float],
    volumes: list[float],
    deviation_bands: float = 2.0,
) -> list[VwapBar]:
    """
    Calcula el VWAP acumulado para una sesión intradiaria.
    Asume que todos los datos son de la misma sesión (mismo día).
    """
    bars: list[VwapBar] = []
    cumvol = 0.0
    cumtp_vol = 0.0
    cumtp2_vol = 0.0

    for c, h, lo, v in zip(closes, highs, lows, volumes, strict=False):
        tp = (h + lo + c) / 3.0
        cumvol += v
        cumtp_vol += tp * v
        cumtp2_vol += tp * tp * v

        vwap = cumtp_vol / cumvol if cumvol > 0 else tp
        variance = (cumtp2_vol / cumvol) - vwap**2 if cumvol > 0 else 0.0
        sigma = math.sqrt(max(variance, 0.0))

        bars.append(
            VwapBar(
                typical=tp,
                volume=v,
                cumvol=cumvol,
                cumtp_vol=cumtp_vol,
                cumtp2_vol=cumtp2_vol,
                vwap=round(vwap, 4),
                sigma=round(sigma, 4),
                band_upper=round(vwap + deviation_bands * sigma, 4),
                band_lower=round(vwap - deviation_bands * sigma, 4),
            )
        )

    return bars


def analyze(
    symbol: str,
    closes: list[float],
    highs: list[float],
    lows: list[float],
    volumes: list[float],
    deviation_bands: float = 2.0,
    target_vwap_pct: float = 50.0,
    min_volume_ratio: float = 0.8,
) -> VwapSignal:
    """
    Analiza la posición del precio respecto al VWAP y genera señal de reversión.

    Args:
        closes/highs/lows/volumes: datos intradiarios de la sesión actual
        deviation_bands:           umbral de entrada en sigmas
        target_vwap_pct:           % de recorrido al VWAP para take profit
        min_volume_ratio:          volumen mínimo vs promedio

    Returns:
        VwapSignal con señal y niveles
    """
    empty = VwapSignal(
        symbol=symbol,
        current_price=0.0,
        vwap=0.0,
        sigma=0.0,
        band_upper=0.0,
        band_lower=0.0,
        deviation_sigma=0.0,
        signal="none",
        target_price=0.0,
        stop_loss=0.0,
        confidence=0.0,
    )

    if len(closes) < 5 or not volumes:
        return empty

    bars = compute_vwap_session(closes, highs, lows, volumes, deviation_bands)
    if not bars:
        return empty

    last = bars[-1]
    current = closes[-1]

    # Verificar volumen relativo
    avg_vol = sum(b.volume for b in bars) / len(bars)
    current_vol = volumes[-1]
    if avg_vol > 0 and current_vol < avg_vol * min_volume_ratio:
        return VwapSignal(
            symbol=symbol,
            current_price=current,
            vwap=last.vwap,
            sigma=last.sigma,
            band_upper=last.band_upper,
            band_lower=last.band_lower,
            deviation_sigma=0.0,
            signal="none",
            target_price=last.vwap,
            stop_loss=0.0,
            confidence=0.0,
        )

    # Calcular desviación en sigmas
    deviation = (current - last.vwap) / last.sigma if last.sigma > 0 else 0.0

    signal = "none"
    target = last.vwap
    stop = 0.0
    confidence = 0.0

    # Señal long: precio bajo banda inferior → reversión al alza
    if deviation <= -deviation_bands:
        signal = "long_reversion"
        # Target: % del camino de vuelta al VWAP
        target = round(current + (last.vwap - current) * target_vwap_pct / 100, 4)
        # Stop: otro 1σ por debajo del punto de entrada
        stop = round(current - last.sigma, 4)
        confidence = min(0.40 + abs(deviation - deviation_bands) * 0.1, 0.85)

    # Señal short: precio sobre banda superior → reversión a la baja
    elif deviation >= deviation_bands:
        signal = "short_reversion"
        target = round(current - (current - last.vwap) * target_vwap_pct / 100, 4)
        stop = round(current + last.sigma, 4)
        confidence = min(0.40 + abs(deviation - deviation_bands) * 0.1, 0.85)

    elif abs(deviation) < 0.5:
        signal = "near_vwap"

    return VwapSignal(
        symbol=symbol,
        current_price=round(current, 4),
        vwap=last.vwap,
        sigma=last.sigma,
        band_upper=last.band_upper,
        band_lower=last.band_lower,
        deviation_sigma=round(deviation, 4),
        signal=signal,
        target_price=target,
        stop_loss=stop,
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
            volumes=item.get("volumes", [1.0] * len(item["closes"])),
            deviation_bands=data.get("deviation_bands", 2.0),
            target_vwap_pct=data.get("target_vwap_pct", 50.0),
            min_volume_ratio=data.get("min_volume_ratio", 0.8),
        )
        results.append(asdict(r))
    print(json.dumps({"ok": True, "results": results}))
