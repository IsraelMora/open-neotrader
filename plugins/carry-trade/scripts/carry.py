"""
Carry Trade — implementación de referencia.

Base académica:
- Uncovered Interest Rate Parity (UIP): las diferencias de tipos de interés
  deberían compensarse con movimientos del tipo de cambio. En la práctica
  no lo hacen → "UIP puzzle" → el carry trade es rentable.
- Burnside et al. (2006): "The Returns to Currency Speculation"
  Carry trade genera Sharpe ~0.7 en el largo plazo.
- Lustig & Verdelhan (2007): factor de riesgo sistemático de carry.

Pares de carry trade clásicos (2024-2026 rates aproximados):
  AUD/JPY: AUD ~4.35% - JPY ~0.1% = 4.25% carry
  NZD/JPY: NZD ~5.5%  - JPY ~0.1% = 5.4% carry
  MXN/JPY: MXN ~11%   - JPY ~0.1% = 10.9% carry (alto riesgo)
  AUD/CHF: AUD ~4.35% - CHF ~1.5% = 2.85% carry
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict, dataclass

# Tasas de interés de referencia de los bancos centrales (actualizar periódicamente)
# El LLM actualiza estas tasas en sus ciclos de aprendizaje (write_skill)
DEFAULT_RATES = {
    "AUD": 4.35,  # RBA
    "NZD": 5.50,  # RBNZ
    "USD": 5.33,  # Fed funds
    "CAD": 5.00,  # BoC
    "GBP": 5.25,  # BoE
    "EUR": 4.50,  # ECB
    "CHF": 1.50,  # SNB
    "JPY": 0.10,  # BoJ
    "NOK": 4.50,  # Norges Bank
    "SEK": 4.00,  # Riksbank
    "MXN": 11.00,  # Banxico
    "BRL": 10.50,  # BCB
    "ZAR": 8.25,  # SARB
    "TRY": 40.00,  # TCMB
}


@dataclass
class CarryResult:
    base_currency: str
    quote_currency: str
    pair: str
    base_rate: float  # tasa de interés del activo base (%)
    quote_rate: float  # tasa de interés del activo cotización (%)
    carry_pct: float  # diferencial neto (%)
    signal: str  # "long" | "short" | "neutral"
    confidence: float
    annual_carry_pct: float  # carry anualizado como % del notional
    days_carry: int  # días estimados para recuperar el coste del swap


def compute_carry(
    pair: str,
    rates_override: dict[str, float] | None = None,
    min_carry_pct: float = 2.0,
) -> CarryResult:
    """
    Calcula el carry trade para un par de divisas.

    Args:
        pair:           par en formato "AUD/JPY" o "AUDJPY"
        rates_override: tasas de interés actualizadas (override de DEFAULT_RATES)
        min_carry_pct:  carry mínimo para activar señal

    Returns:
        CarryResult con señal y métricas
    """
    rates = {**DEFAULT_RATES, **(rates_override or {})}

    # Parsear par
    pair_clean = pair.replace("/", "").replace("_", "").replace("-", "").upper()
    if len(pair_clean) != 6:
        return _neutral_result(pair, 0.0, 0.0, min_carry_pct)

    base = pair_clean[:3]
    quote = pair_clean[3:]

    base_rate = rates.get(base, 0.0)
    quote_rate = rates.get(quote, 0.0)

    # En un par BASE/QUOTE, cuando compramos el par:
    # - Recibimos la tasa del base (interés del activo que tenemos)
    # - Pagamos la tasa del quote (costo de financiación)
    carry = base_rate - quote_rate

    if carry >= min_carry_pct:
        signal = "long"  # comprar el par → recibir carry positivo
        conf = min(0.85, 0.60 + (carry - min_carry_pct) * 0.04)
    elif carry <= -min_carry_pct:
        signal = "short"  # vender el par → recibir carry del quote
        conf = min(0.85, 0.60 + (abs(carry) - min_carry_pct) * 0.04)
    else:
        signal = "neutral"
        conf = 0.0

    annual_carry = abs(carry)
    # Días para recuperar un pip de spread con carry: no aplica directamente,
    # pero podemos estimar cuántos días de carry = coste de spread (asumiendo 1 pip = 0.01%)
    days_for_spread = int(365 / annual_carry * 0.01) if annual_carry > 0 else 999

    return CarryResult(
        base_currency=base,
        quote_currency=quote,
        pair=pair,
        base_rate=base_rate,
        quote_rate=quote_rate,
        carry_pct=round(carry, 2),
        signal=signal,
        confidence=round(conf, 3),
        annual_carry_pct=round(annual_carry, 2),
        days_carry=days_for_spread,
    )


def _neutral_result(
    pair: str, base_rate: float, quote_rate: float, min_carry: float
) -> CarryResult:
    return CarryResult(
        base_currency="???",
        quote_currency="???",
        pair=pair,
        base_rate=base_rate,
        quote_rate=quote_rate,
        carry_pct=0.0,
        signal="neutral",
        confidence=0.0,
        annual_carry_pct=0.0,
        days_carry=999,
    )


def rank_carry_pairs(
    pairs: list[str],
    rates_override: dict[str, float] | None = None,
    min_carry_pct: float = 2.0,
    top_n: int = 5,
) -> list[CarryResult]:
    """
    Evalúa varios pares y devuelve los mejores por carry positivo.
    """
    results = [compute_carry(p, rates_override, min_carry_pct) for p in pairs]
    # Ordenar por carry absoluto (mayor primero)
    results.sort(key=lambda r: abs(r.carry_pct), reverse=True)
    return results[:top_n]


def apply_momentum_filter(
    result: CarryResult,
    prices: list[float],
    ma_period: int = 200,
) -> CarryResult:
    """
    Aplica filtro de momentum: solo mantener señal long si precio > MA(200).
    Reduce pérdidas en entornos de risk-off donde el carry se revierte.
    """
    if len(prices) < ma_period or result.signal == "neutral":
        return result

    ma = sum(prices[-ma_period:]) / ma_period
    current = prices[-1]

    trend_aligned = (result.signal == "long" and current > ma) or (
        result.signal == "short" and current < ma
    )

    if not trend_aligned:
        return CarryResult(
            **{
                **result.__dict__,
                "signal": "neutral",
                "confidence": 0.0,
                "carry_pct": result.carry_pct,  # mantener carry info para display
            }
        )

    # Boost de confianza si el momentum confirma
    return CarryResult(
        **{
            **result.__dict__,
            "confidence": min(0.88, result.confidence + 0.05),
        }
    )


if __name__ == "__main__":
    data = json.load(sys.stdin)
    cmd = data.get("cmd", "compute_carry")

    if cmd == "compute_carry":
        result = compute_carry(
            pair=data["pair"],
            rates_override=data.get("rates"),
            min_carry_pct=data.get("min_carry_pct", 2.0),
        )
        print(json.dumps({"ok": True, "result": asdict(result)}))
    elif cmd == "rank_carry_pairs":
        results = rank_carry_pairs(
            pairs=data["pairs"],
            rates_override=data.get("rates"),
            min_carry_pct=data.get("min_carry_pct", 2.0),
            top_n=data.get("top_n", 5),
        )
        print(json.dumps({"ok": True, "results": [asdict(r) for r in results]}))
