"""
Plugin: skills-base
Skills de análisis de riesgo y señales para el LLM orquestador.
El LLM llama estas funciones; nunca ve los datos directamente.
"""

from __future__ import annotations

from neurotrader_sdk import Context, skill


@skill(name="analyze_diversification", description="Evalúa diversificación de cartera")
def analyze_diversification(
    positions: list[dict],
    *,
    _context: Context | None = None,
) -> dict:
    """
    Recibe posiciones [{ticker, weight}] y devuelve métricas de concentración.
    No accede a precios — trabaja con los pesos ya calculados por el plugin de datos.
    """
    if not positions:
        return {"herfindahl": 0.0, "verdict": "sin_posiciones"}

    hhi = sum(p["weight"] ** 2 for p in positions)
    verdict = "concentrado" if hhi > 0.25 else "diversificado"
    return {
        "herfindahl": round(hhi, 4),
        "n_positions": len(positions),
        "verdict": verdict,
    }


@skill(name="signal_momentum", description="Señal de momentum basada en banderas históricas")
def signal_momentum(
    flags: list[str],
    ticker: str,
    *,
    _context: Context | None = None,
) -> dict:
    """
    Recibe banderas históricas textuales (no precios) y devuelve señal.
    Banderas ejemplo: ["uptrend_confirmed", "volume_spike", "overbought"]
    El LLM solo puede mantener/recortar/vetar — no puede abrir posiciones nuevas.
    """
    veto_flags = {"overbought", "high_volatility_regime", "earnings_risk"}
    active_vetos = [f for f in flags if f in veto_flags]

    if active_vetos:
        return {"signal": "veto", "ticker": ticker, "reasons": active_vetos}

    positive = sum(1 for f in flags if "uptrend" in f or "momentum" in f)
    if positive >= 2:
        return {"signal": "mantener", "ticker": ticker, "confidence": "alta"}

    return {"signal": "recortar", "ticker": ticker, "confidence": "baja"}


@skill(name="evaluate_risk", description="Evalúa riesgo de una posición")
def evaluate_risk(
    ticker: str,
    weight: float,
    flags: list[str],
    *,
    _context: Context | None = None,
) -> dict:
    """
    Combina diversificación y señales para dar un dictamen de riesgo.
    """
    oversized = weight > 0.20
    danger_flags = {"liquidity_risk", "regulatory_risk", "high_beta"}
    risks = [f for f in flags if f in danger_flags]

    if oversized or len(risks) >= 2:
        return {
            "ticker": ticker,
            "risk_level": "alto",
            "action": "veto",
            "reasons": risks + (["sobreponderado"] if oversized else []),
        }

    return {"ticker": ticker, "risk_level": "normal", "action": "mantener"}
