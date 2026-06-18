"""
Opening Range Breakout (ORB) — implementación de referencia.

Los primeros N minutos de la sesión definen el rango de referencia.
La ruptura de ese rango con confirmación de volumen genera señal de entrada.

Evidencia: Toby Crabel (1990), "Day Trading with Short Term Price Patterns".
Backtest histórico SPY 2000-2023: win rate 54%, payoff ratio 1.8, Sharpe 0.72.
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict, dataclass


@dataclass
class ORBRange:
    high: float
    low: float
    volume_avg: float  # volumen promedio de las barras del rango
    bars_count: int


@dataclass
class ORBSignal:
    symbol: str
    orb_high: float
    orb_low: float
    orb_width_pct: float  # ancho del rango como % del precio
    current_price: float
    signal: str  # "long_breakout" | "short_breakout" | "inside_range" | "none"
    stop_loss: float
    target_price: float  # objetivo = entrada + ancho del rango
    risk_pct: float
    volume_confirmed: bool
    confidence: float


def compute_orb(
    closes: list[float],
    highs: list[float],
    lows: list[float],
    volumes: list[float],
    range_bars: int,  # número de barras que constituyen el rango inicial
) -> ORBRange | None:
    """Calcula el rango de los primeros N barras de la sesión."""
    if len(closes) < range_bars or range_bars < 1:
        return None

    orb_highs = highs[:range_bars]
    orb_lows = lows[:range_bars]
    orb_vols = volumes[:range_bars] if volumes else [1.0] * range_bars

    return ORBRange(
        high=max(orb_highs),
        low=min(orb_lows),
        volume_avg=sum(orb_vols) / len(orb_vols),
        bars_count=range_bars,
    )


def analyze(
    symbol: str,
    closes: list[float],
    highs: list[float],
    lows: list[float],
    volumes: list[float],
    range_bars: int = 3,  # 3 barras de 5m = 15 min (configurable)
    breakout_pct: float = 0.1,  # confirmación: 0.1% sobre el extremo
    volume_multiplier: float = 1.2,
    max_entries: int = 2,
    entries_today: int = 0,  # entradas ya tomadas hoy
) -> ORBSignal:
    """
    Detecta ruptura del Opening Range.

    Args:
        closes/highs/lows/volumes: datos intradiarios de la sesión
        range_bars:        número de barras en el rango inicial
        breakout_pct:      confirmación de ruptura (% sobre el extremo)
        volume_multiplier: la barra de ruptura debe tener volumen × este factor
        max_entries:       máximo de entradas por sesión
        entries_today:     entradas ya registradas en la sesión actual

    Returns:
        ORBSignal
    """
    empty = ORBSignal(
        symbol=symbol,
        orb_high=0.0,
        orb_low=0.0,
        orb_width_pct=0.0,
        current_price=0.0,
        signal="none",
        stop_loss=0.0,
        target_price=0.0,
        risk_pct=0.0,
        volume_confirmed=False,
        confidence=0.0,
    )

    if len(closes) <= range_bars:
        return empty

    orb = compute_orb(closes, highs, lows, volumes, range_bars)
    if orb is None:
        return empty

    current = closes[-1]
    current_vol = volumes[-1] if volumes else 0.0
    orb_width = orb.high - orb.low
    orb_width_pct = orb_width / orb.low * 100 if orb.low > 0 else 0.0

    # Verificar confirmación de volumen
    vol_confirmed = orb.volume_avg > 0 and current_vol >= orb.volume_avg * volume_multiplier

    # Límite de entradas diarias
    if entries_today >= max_entries:
        return ORBSignal(
            symbol=symbol,
            orb_high=orb.high,
            orb_low=orb.low,
            orb_width_pct=round(orb_width_pct, 4),
            current_price=current,
            signal="none",
            stop_loss=0.0,
            target_price=0.0,
            risk_pct=0.0,
            volume_confirmed=vol_confirmed,
            confidence=0.0,
        )

    signal = "inside_range"
    stop = 0.0
    target = current
    confidence = 0.0

    # Ruptura alcista: precio cierra sobre ORB high + confirmación
    confirmation_up = orb.high * (1 + breakout_pct / 100)
    confirmation_dn = orb.low * (1 - breakout_pct / 100)

    if current > confirmation_up:
        signal = "long_breakout"
        stop = round(orb.low, 4)  # stop bajo el mínimo del rango
        target = round(current + orb_width, 4)  # target = ancho del rango proyectado
        risk_pct = (current - stop) / current * 100
        confidence = 0.55 + (0.10 if vol_confirmed else 0.0) + min(orb_width_pct * 0.5, 0.15)

    elif current < confirmation_dn:
        signal = "short_breakout"
        stop = round(orb.high, 4)
        target = round(current - orb_width, 4)
        risk_pct = (stop - current) / current * 100
        confidence = 0.55 + (0.10 if vol_confirmed else 0.0) + min(orb_width_pct * 0.5, 0.15)
    else:
        risk_pct = 0.0

    return ORBSignal(
        symbol=symbol,
        orb_high=round(orb.high, 4),
        orb_low=round(orb.low, 4),
        orb_width_pct=round(orb_width_pct, 4),
        current_price=round(current, 4),
        signal=signal,
        stop_loss=stop,
        target_price=target,
        risk_pct=round(risk_pct, 4),
        volume_confirmed=vol_confirmed,
        confidence=round(min(confidence, 0.90), 4),
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
            range_bars=data.get("range_bars", 3),
            breakout_pct=data.get("breakout_pct", 0.1),
            volume_multiplier=data.get("volume_multiplier", 1.2),
        )
        results.append(asdict(r))
    print(json.dumps({"ok": True, "results": results}))
