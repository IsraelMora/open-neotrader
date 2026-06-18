"""
Volatility Regime Detection — implementación de referencia.

Combina VIX nivel y volatilidad realizada para clasificar el régimen de mercado
y recomendar ajustes de estrategia.
"""

from __future__ import annotations

import json
import math
import sys
from dataclasses import asdict, dataclass


@dataclass
class RegimeResult:
    regime: str  # "low" | "normal" | "high" | "crisis"
    vix: float | None
    rv_21d: float  # volatilidad realizada anualizada 21d
    rv_percentile: float  # percentil histórico [0, 1]
    size_multiplier: float  # multiplicador de tamaño recomendado
    preferred_strategies: list[str]
    avoid_strategies: list[str]
    market_trend_up: bool  # precio índice > MA200
    vix_term_structure: float | None  # VIX_3m / VIX_1m si disponible
    description: str


def compute_rv(log_returns: list[float], days: int = 21) -> float:
    """Volatilidad realizada anualizada de los últimos N días."""
    window = log_returns if len(log_returns) < days else log_returns[-days:]
    if len(window) < 2:
        return 0.0
    mean = sum(window) / len(window)
    variance = sum((r - mean) ** 2 for r in window) / (len(window) - 1)
    return math.sqrt(variance * 252)


def compute_rv_percentile(
    log_returns: list[float], current_rv: float, lookback: int = 252
) -> float:
    """Percentil de la volatilidad actual vs histórico."""
    if len(log_returns) < 22:
        return 0.5

    historical_rvs: list[float] = []
    for i in range(21, min(len(log_returns), lookback + 21)):
        rv_i = compute_rv(log_returns[:i], 21)
        if rv_i > 0:
            historical_rvs.append(rv_i)

    if not historical_rvs:
        return 0.5

    below = sum(1 for rv in historical_rvs if rv <= current_rv)
    return round(below / len(historical_rvs), 4)


def detect_regime(
    index_closes: list[float],  # precios de cierre del índice (ej. SPY)
    vix_value: float | None = None,  # VIX actual (opcional)
    vix_3m: float | None = None,  # VIX 3 meses (para term structure)
    vix_low: float = 15.0,
    vix_high: float = 25.0,
    vix_crisis: float = 40.0,
    lookback_days: int = 252,
) -> RegimeResult:
    """
    Detecta el régimen de volatilidad actual.

    Args:
        index_closes: precios de cierre del índice de referencia (SPY, SPX, etc.)
        vix_value:    nivel actual del VIX (si el provider lo tiene)
        vix_3m:       VIX a 3 meses (para term structure, opcional)
        vix_low/high/crisis: umbrales de clasificación
        lookback_days: días para calcular el percentil histórico

    Returns:
        RegimeResult con clasificación y recomendaciones
    """
    if len(index_closes) < 22:
        return RegimeResult(
            regime="unknown",
            vix=vix_value,
            rv_21d=0.0,
            rv_percentile=0.5,
            size_multiplier=0.5,
            preferred_strategies=[],
            avoid_strategies=[],
            market_trend_up=True,
            vix_term_structure=None,
            description="Datos insuficientes para detectar régimen",
        )

    # Calcular log returns
    log_returns = [
        math.log(index_closes[i] / index_closes[i - 1]) for i in range(1, len(index_closes))
    ]

    rv_21d = compute_rv(log_returns, 21)
    rv_percentile = compute_rv_percentile(log_returns, rv_21d, lookback_days)

    # Tendencia del mercado: precio vs MA200
    ma200 = (
        sum(index_closes[-200:]) / min(len(index_closes), 200)
        if len(index_closes) >= 20
        else index_closes[-1]
    )
    market_trend_up = index_closes[-1] > ma200

    # VIX term structure
    vix_term = None
    if vix_value and vix_3m and vix_value > 0:
        vix_term = round(vix_3m / vix_value, 4)

    # Clasificar régimen usando VIX (si disponible) o RV percentile
    if vix_value is not None:
        if vix_value > vix_crisis:
            regime = "crisis"
        elif vix_value > vix_high:
            regime = "high"
        elif vix_value > vix_low:
            regime = "normal"
        else:
            regime = "low"
    else:
        # Sin VIX: usar percentil de RV
        if rv_percentile > 0.90:
            regime = "crisis"
        elif rv_percentile > 0.70:
            regime = "high"
        elif rv_percentile > 0.30:
            regime = "normal"
        else:
            regime = "low"

    # Recomendaciones por régimen
    if regime == "low":
        size_multiplier = 1.0
        preferred = ["momentum_factor_12_1", "ema_crossover_9_21", "bollinger_squeeze"]
        avoid = []
        desc = (
            f"Volatilidad baja (VIX={vix_value}, RV={rv_21d:.1%}). "
            "Momentum funciona bien. Exposición completa."
        )
    elif regime == "normal":
        size_multiplier = 1.0
        preferred = ["ema_crossover_9_21", "bollinger_squeeze", "rsi_mean_reversion"]
        avoid = []
        desc = (
            f"Volatilidad normal (VIX={vix_value}, RV={rv_21d:.1%}). "
            "Todas las estrategias operativas."
        )
    elif regime == "high":
        size_multiplier = 0.50
        preferred = ["rsi_mean_reversion"]
        avoid = ["momentum_factor_12_1"]
        desc = (
            f"Volatilidad elevada (VIX={vix_value}, RV={rv_21d:.1%}). "
            "Reducir exposición 50%. Preferir mean reversion."
        )
    else:  # crisis
        size_multiplier = 0.10
        preferred = []
        avoid = ["momentum_factor_12_1", "ema_crossover_9_21", "bollinger_squeeze"]
        desc = (
            f"CRISIS (VIX={vix_value}, RV={rv_21d:.1%}). Máxima cautela. Activar circuit breaker."
        )

    # Si el mercado está en downtrend, ser más conservador
    if not market_trend_up and regime == "low":
        regime = "normal"
        size_multiplier = 0.75
        desc += " (ajustado: mercado bajo MA200)"

    return RegimeResult(
        regime=regime,
        vix=round(vix_value, 2) if vix_value else None,
        rv_21d=round(rv_21d, 4),
        rv_percentile=rv_percentile,
        size_multiplier=size_multiplier,
        preferred_strategies=preferred,
        avoid_strategies=avoid,
        market_trend_up=market_trend_up,
        vix_term_structure=vix_term,
        description=desc,
    )


if __name__ == "__main__":
    data = json.load(sys.stdin)
    result = detect_regime(
        index_closes=data["index_closes"],
        vix_value=data.get("vix_value"),
        vix_3m=data.get("vix_3m"),
        vix_low=data.get("vix_low", 15.0),
        vix_high=data.get("vix_high", 25.0),
        vix_crisis=data.get("vix_crisis", 40.0),
        lookback_days=data.get("lookback_days", 252),
    )
    print(json.dumps({"ok": True, "result": asdict(result)}))
