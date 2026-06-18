"""
Earnings Drift (PEAD) — Post-Earnings Announcement Drift.

Base académica:
- Ball & Brown (1968): primer estudio que documenta la deriva post-earnings.
- Bernard & Thomas (1989): "Post-Earnings-Announcement Drift: Delayed Price Response
  or Risk Premium?" (Journal of Accounting Research).
  Documentan una anomalía que persiste décadas después de ser publicada.
- Jegadeesh & Livnat (2006): actualización con datos modernos — drift persiste ~60 días.

Por qué funciona:
1. Inversores subreaccionan inicialmente a la sorpresa
2. Analistas actualizan estimaciones gradualmente (anchoring bias)
3. El precio continúa en la dirección de la sorpresa durante 1-3 meses
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict, dataclass


@dataclass
class EarningsSurprise:
    symbol: str
    eps_actual: float
    eps_estimate: float
    surprise_pct: float  # (actual - estimate) / |estimate| * 100
    surprise_tier: str  # "large_beat" | "beat" | "miss" | "large_miss" | "inline"
    signal: str  # "long" | "short" | "neutral"
    confidence: float
    days_to_hold: int


@dataclass
class PriceReaction:
    symbol: str
    gap_pct: float  # % de gap en apertura respecto al cierre anterior
    gap_direction: str  # "up" | "down" | "flat"
    volume_ratio: float  # volumen del día vs media 20 días
    confirms_surprise: bool  # gap va en la misma dirección que la sorpresa


def compute_earnings_surprise(
    symbol: str,
    eps_actual: float,
    eps_estimate: float,
    min_surprise_pct: float = 5.0,
    hold_days: int = 30,
) -> EarningsSurprise:
    """
    Calcula la sorpresa de EPS y genera señal PEAD.

    Args:
        eps_actual:         EPS reportado
        eps_estimate:       EPS consenso analistas
        min_surprise_pct:   umbral para considerar "sorpresa significativa"
        hold_days:          días de mantenimiento de la posición

    Returns:
        EarningsSurprise con señal y confianza
    """
    if eps_estimate == 0:
        # Con estimado 0, usar diferencia absoluta
        surprise = eps_actual * 100
    else:
        surprise = (eps_actual - eps_estimate) / abs(eps_estimate) * 100

    surprise = round(surprise, 2)

    if surprise >= 10:
        tier = "large_beat"
        signal = "long"
        confidence = 0.80
    elif surprise >= min_surprise_pct:
        tier = "beat"
        signal = "long"
        confidence = 0.65
    elif surprise <= -10:
        tier = "large_miss"
        signal = "short"
        confidence = 0.80
    elif surprise <= -min_surprise_pct:
        tier = "miss"
        signal = "short"
        confidence = 0.65
    else:
        tier = "inline"
        signal = "neutral"
        confidence = 0.0

    # Mayor sorpresa → más confianza (cap en 0.90)
    excess = max(0, abs(surprise) - min_surprise_pct)
    confidence = min(0.90, confidence + excess * 0.01)

    return EarningsSurprise(
        symbol=symbol,
        eps_actual=eps_actual,
        eps_estimate=eps_estimate,
        surprise_pct=surprise,
        surprise_tier=tier,
        signal=signal,
        confidence=round(confidence, 3),
        days_to_hold=hold_days,
    )


def analyze_price_reaction(
    symbol: str,
    prev_close: float,
    open_price: float,
    volume_today: float,
    avg_volume_20d: float,
    surprise_direction: str,  # "positive" | "negative"
    use_gap: bool = True,
) -> PriceReaction:
    """
    Analiza la reacción del precio al earnings report.

    Confirmar PEAD cuando:
    1. Gap en apertura va en la dirección de la sorpresa
    2. Volumen anómalo (> 1.5× la media) confirma interés institucional

    Args:
        surprise_direction: "positive" si beat, "negative" si miss
    """
    if prev_close <= 0:
        return PriceReaction(
            symbol=symbol,
            gap_pct=0.0,
            gap_direction="flat",
            volume_ratio=1.0,
            confirms_surprise=False,
        )

    gap_pct = round((open_price - prev_close) / prev_close * 100, 2)

    if gap_pct > 0.5:
        gap_direction = "up"
    elif gap_pct < -0.5:
        gap_direction = "down"
    else:
        gap_direction = "flat"

    volume_ratio = round(volume_today / avg_volume_20d, 2) if avg_volume_20d > 0 else 1.0

    confirms = (surprise_direction == "positive" and gap_direction == "up") or (
        surprise_direction == "negative" and gap_direction == "down"
    )
    if not use_gap:
        confirms = True  # sin confirmación de precio, asumir que la sorpresa es suficiente

    return PriceReaction(
        symbol=symbol,
        gap_pct=gap_pct,
        gap_direction=gap_direction,
        volume_ratio=volume_ratio,
        confirms_surprise=confirms,
    )


def build_pead_signal(
    surprise: EarningsSurprise,
    reaction: PriceReaction | None,
    current_price: float,
) -> dict | None:
    """
    Combina sorpresa y reacción de precio en una señal PEAD final.

    El PEAD tiene mayor win rate cuando:
    1. Sorpresa es grande (> 10%)
    2. El precio confirma con gap en la misma dirección
    3. Volumen anómalo (instituciones reposicionándose)
    """
    if surprise.signal == "neutral":
        return None

    # Si tenemos datos de reacción, ajustar confianza
    final_confidence = surprise.confidence
    if reaction is not None:
        if reaction.confirms_surprise:
            final_confidence = min(0.90, final_confidence + 0.05)
        else:
            final_confidence = max(0.0, final_confidence - 0.15)
        if reaction.volume_ratio >= 2.0:
            final_confidence = min(0.90, final_confidence + 0.05)

    if final_confidence < 0.40:
        return None  # señal demasiado débil

    return {
        "type": "pead_signal",
        "symbol": surprise.symbol,
        "action": surprise.signal,
        "confidence": round(final_confidence, 3),
        "eps_surprise_pct": surprise.surprise_pct,
        "surprise_tier": surprise.surprise_tier,
        "hold_days": surprise.days_to_hold,
        "price": current_price,
        "gap_pct": reaction.gap_pct if reaction else None,
        "volume_ratio": reaction.volume_ratio if reaction else None,
    }


if __name__ == "__main__":
    data = json.load(sys.stdin)
    cmd = data.get("cmd", "compute_earnings_surprise")

    if cmd == "compute_earnings_surprise":
        result = compute_earnings_surprise(
            symbol=data.get("symbol", ""),
            eps_actual=data["eps_actual"],
            eps_estimate=data["eps_estimate"],
            min_surprise_pct=data.get("min_surprise_pct", 5.0),
            hold_days=data.get("hold_days", 30),
        )
        print(json.dumps({"ok": True, "result": asdict(result)}))
    elif cmd == "analyze_price_reaction":
        result = analyze_price_reaction(
            symbol=data.get("symbol", ""),
            prev_close=data["prev_close"],
            open_price=data["open_price"],
            volume_today=data["volume_today"],
            avg_volume_20d=data["avg_volume_20d"],
            surprise_direction=data.get("surprise_direction", "positive"),
        )
        print(json.dumps({"ok": True, "result": asdict(result)}))
