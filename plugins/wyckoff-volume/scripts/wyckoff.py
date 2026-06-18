"""
wyckoff.py — Método Wyckoff de Análisis Precio/Volumen

Richard Wyckoff (1910-1934) desarrolló un método para detectar la actividad de
"smart money" (instituciones) mediante la relación precio/volumen. La premisa
es que el volumen es la huella que dejan los grandes operadores.

Fases detectadas:
  ACCUMULATION: Proceso por el cual el smart money compra a precios bajos.
    - Phase A: Selling Climax (SC) + Automatic Rally (AR) — establece rango
    - Phase B: Consolidación con decreasing volume
    - Phase C: Spring — false breakdown con bajo volumen (trampa bajista)
    - Phase D: Sign of Strength (SOS) — precio sale del rango con alto volumen
    - Phase E: Markup — tendencia alcista

  DISTRIBUTION: Proceso inverso — smart money vende a precios altos.
    - Phase A: Buying Climax (BC) + Automatic Reaction (ARea)
    - Phase B: Consolidación
    - Phase C: Upthrust After Distribution (UTAD)
    - Phase D: Sign of Weakness (SOW)
    - Phase E: Markdown — tendencia bajista

Referencia:
  Wyckoff, R.D. (1910-1934) — Método original (dominio público)
  Schroeder, D. (2013) "Technical Analysis: The Complete Resource" — Capítulo 12
  Hutson, J. (1986) "Charting the Stock Market: The Wyckoff Method" — Dow Jones-Irwin
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class WyckoffEvent:
    bar: int
    event_type: str  # SC | AR | BC | SPRING | UPTHRUST | SOS | SOW | TEST
    price: float
    volume: float
    volume_vs_avg: float
    description: str
    is_bullish: bool


@dataclass
class WyckoffAnalysis:
    phase: str  # ACCUMULATION | DISTRIBUTION | MARKUP | MARKDOWN | NEUTRAL
    sub_phase: str  # A | B | C | D | E
    confidence: float  # 0-1
    events: list[WyckoffEvent]
    support: float | None
    resistance: float | None
    trend_bias: str  # bullish | bearish | neutral
    signal: str  # buy | sell | hold
    spring_detected: bool
    upthrust_detected: bool


def _rolling_avg(data: list[float], period: int, i: int) -> float:
    """Media simple de los últimos `period` valores hasta índice i."""
    start = max(0, i - period + 1)
    window = data[start : i + 1]
    return sum(window) / len(window) if window else 0.0


def analyze(
    highs: list[float],
    lows: list[float],
    closes: list[float],
    volumes: list[float],
    config: dict[str, Any] | None = None,
) -> WyckoffAnalysis:
    cfg = config or {}
    lookback = int(cfg.get("lookback_bars", 50))
    vol_spike = float(cfg.get("volume_spike_ratio", 1.5))
    spring_thr = float(cfg.get("spring_threshold", 0.02))
    upthrust_thr = float(cfg.get("upthrust_threshold", 0.02))

    n = len(closes)
    if n < lookback:
        lookback = n
    if n < 10:
        return WyckoffAnalysis("NEUTRAL", "A", 0.0, [], None, None, "neutral", "hold", False, False)

    # Ventana de análisis (últimas lookback barras)
    start_i = n - lookback
    w_closes = closes[start_i:]
    w_highs = highs[start_i:]
    w_lows = lows[start_i:]
    w_volumes = volumes[start_i:]
    w_n = len(w_closes)

    # ── Soporte y resistencia del rango ──────────────────────────────────────
    support = min(w_lows)
    resistance = max(w_highs)

    # ── Volumen promedio (20 días) ────────────────────────────────────────────
    vol_avg_full = [_rolling_avg(volumes, 20, start_i + i) for i in range(w_n)]

    # ── Detectar eventos ─────────────────────────────────────────────────────
    events: list[WyckoffEvent] = []
    spring_detected = False
    upthrust_detected = False

    for i in range(5, w_n):
        price = w_closes[i]
        vol = w_volumes[i]
        vol_avg = vol_avg_full[i] if vol_avg_full[i] > 0 else 1
        vol_ratio = vol / vol_avg

        # Selling Climax (SC): fuerte caída con volumen masivo + reversión
        if (
            w_closes[i] < w_closes[i - 1]
            and vol_ratio >= vol_spike * 1.5
            and w_lows[i] <= support * 1.01
            and w_closes[i] > w_lows[i]
        ):
            events.append(
                WyckoffEvent(
                    bar=start_i + i,
                    event_type="SC",
                    price=price,
                    volume=vol,
                    volume_vs_avg=vol_ratio,
                    description=(
                        f"Selling Climax: caída masiva con volumen"
                        f" {vol_ratio:.1f}× media, soporte cerca"
                    ),
                    is_bullish=True,
                )
            )

        # Buying Climax (BC): fuerte subida con volumen masivo + reversión
        elif (
            w_closes[i] > w_closes[i - 1]
            and vol_ratio >= vol_spike * 1.5
            and w_highs[i] >= resistance * 0.99
            and w_closes[i] < w_highs[i]
        ):
            events.append(
                WyckoffEvent(
                    bar=start_i + i,
                    event_type="BC",
                    price=price,
                    volume=vol,
                    volume_vs_avg=vol_ratio,
                    description=(
                        f"Buying Climax: subida masiva con volumen"
                        f" {vol_ratio:.1f}× media, resistencia cerca"
                    ),
                    is_bullish=False,
                )
            )

        # Spring: low penetra soporte ligeramente con BAJO volumen + recuperación
        elif (
            w_lows[i] < support * (1 - spring_thr)
            and w_closes[i] > support
            and vol_ratio < vol_spike  # volumen bajo = no hay selling genuino
            and w_closes[i] > w_closes[i - 1]
        ):
            spring_detected = True
            events.append(
                WyckoffEvent(
                    bar=start_i + i,
                    event_type="SPRING",
                    price=price,
                    volume=vol,
                    volume_vs_avg=vol_ratio,
                    description=(
                        f"Spring: falsa ruptura soporte {support:.4f}"
                        f" con vol bajo {vol_ratio:.1f}× → señal alcista"
                    ),
                    is_bullish=True,
                )
            )

        # Upthrust After Distribution (UTAD): high penetra resistencia con ALTO volumen + rechazada
        elif (
            w_highs[i] > resistance * (1 + upthrust_thr)
            and w_closes[i] < resistance
            and vol_ratio >= vol_spike
        ):
            upthrust_detected = True
            events.append(
                WyckoffEvent(
                    bar=start_i + i,
                    event_type="UPTHRUST",
                    price=price,
                    volume=vol,
                    volume_vs_avg=vol_ratio,
                    description=(
                        f"Upthrust: falsa ruptura resistencia {resistance:.4f}"
                        f" con vol alto {vol_ratio:.1f}× → señal bajista"
                    ),
                    is_bullish=False,
                )
            )

        # Sign of Strength (SOS): precio sale del rango al alza con alto volumen
        elif w_closes[i] > resistance and vol_ratio >= vol_spike and w_closes[i] > w_closes[i - 1]:
            events.append(
                WyckoffEvent(
                    bar=start_i + i,
                    event_type="SOS",
                    price=price,
                    volume=vol,
                    volume_vs_avg=vol_ratio,
                    description=f"Sign of Strength: ruptura alcista con vol {vol_ratio:.1f}×",
                    is_bullish=True,
                )
            )

        # Sign of Weakness (SOW): precio cae del rango con alto volumen
        elif w_closes[i] < support and vol_ratio >= vol_spike and w_closes[i] < w_closes[i - 1]:
            events.append(
                WyckoffEvent(
                    bar=start_i + i,
                    event_type="SOW",
                    price=price,
                    volume=vol,
                    volume_vs_avg=vol_ratio,
                    description=f"Sign of Weakness: ruptura bajista con vol {vol_ratio:.1f}×",
                    is_bullish=False,
                )
            )

    # ── Inferir fase y señal ──────────────────────────────────────────────────
    bullish_events = sum(1 for e in events if e.is_bullish)
    bearish_events = sum(1 for e in events if not e.is_bullish)
    total_events = len(events)

    if total_events == 0:
        phase = "NEUTRAL"
        sub_phase = "B"
        trend_bias = "neutral"
        signal = "hold"
        confidence = 0.2
    elif spring_detected:
        phase = "ACCUMULATION"
        sub_phase = "C"
        trend_bias = "bullish"
        signal = "buy"
        confidence = 0.70
    elif upthrust_detected:
        phase = "DISTRIBUTION"
        sub_phase = "C"
        trend_bias = "bearish"
        signal = "sell"
        confidence = 0.70
    elif bullish_events > bearish_events:
        # SOS reciente → Markup
        recent_sos = [e for e in events[-5:] if e.event_type == "SOS"]
        phase = "MARKUP" if recent_sos else "ACCUMULATION"
        sub_phase = "E" if recent_sos else "D"
        trend_bias = "bullish"
        signal = "buy" if phase == "MARKUP" else "hold"
        confidence = 0.65 if recent_sos else 0.50
    elif bearish_events > bullish_events:
        recent_sow = [e for e in events[-5:] if e.event_type == "SOW"]
        phase = "MARKDOWN" if recent_sow else "DISTRIBUTION"
        sub_phase = "E" if recent_sow else "D"
        trend_bias = "bearish"
        signal = "sell" if phase == "MARKDOWN" else "hold"
        confidence = 0.65 if recent_sow else 0.50
    else:
        phase = "NEUTRAL"
        sub_phase = "B"
        trend_bias = "neutral"
        signal = "hold"
        confidence = 0.30

    return WyckoffAnalysis(
        phase=phase,
        sub_phase=sub_phase,
        confidence=confidence,
        events=events[-10:],  # últimos 10 eventos
        support=support,
        resistance=resistance,
        trend_bias=trend_bias,
        signal=signal,
        spring_detected=spring_detected,
        upthrust_detected=upthrust_detected,
    )
