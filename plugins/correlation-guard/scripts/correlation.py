"""
Correlation Guard — implementación de referencia.

Calcula la matriz de correlación entre activos y cancela señales
de entrada en activos muy correlacionados con posiciones ya abiertas.

La correlación de Pearson entre retornos logarítmicos es el estándar
en gestión de carteras (base de Modern Portfolio Theory).
"""

from __future__ import annotations

import json
import math
import sys
from dataclasses import asdict, dataclass


@dataclass
class CorrelationResult:
    symbol_a: str
    symbol_b: str
    correlation: float
    correlated: bool  # True si supera el umbral configurado


def pearson_correlation(returns_a: list[float], returns_b: list[float]) -> float:
    """
    Correlación de Pearson entre dos series de retornos.
    Retorna valor en [-1, 1]. NaN → 0.0 (si no hay varianza).
    """
    n = min(len(returns_a), len(returns_b))
    if n < 5:
        return 0.0

    a = returns_a[-n:]
    b = returns_b[-n:]

    mean_a = sum(a) / n
    mean_b = sum(b) / n

    cov = sum((a[i] - mean_a) * (b[i] - mean_b) for i in range(n)) / n
    var_a = sum((x - mean_a) ** 2 for x in a) / n
    var_b = sum((x - mean_b) ** 2 for x in b) / n

    std_a = math.sqrt(var_a)
    std_b = math.sqrt(var_b)

    if std_a == 0 or std_b == 0:
        return 0.0

    return round(cov / (std_a * std_b), 4)


def compute_log_returns(prices: list[float]) -> list[float]:
    """Retornos logarítmicos: ln(P_t / P_{t-1})."""
    if len(prices) < 2:
        return []
    return [math.log(prices[i] / prices[i - 1]) for i in range(1, len(prices)) if prices[i - 1] > 0]


def build_correlation_matrix(
    price_series: dict[str, list[float]],
) -> dict[tuple[str, str], float]:
    """
    Construye la matriz de correlación para todos los pares de activos.

    Args:
        price_series: { symbol: [precios_cronológicos] }

    Returns:
        dict { (symbol_a, symbol_b): correlación } para todos los pares
    """
    returns: dict[str, list[float]] = {}
    for symbol, prices in price_series.items():
        r = compute_log_returns(prices)
        if r:
            returns[symbol] = r

    matrix: dict[tuple[str, str], float] = {}
    symbols = list(returns.keys())

    for i in range(len(symbols)):
        for j in range(i + 1, len(symbols)):
            sa, sb = symbols[i], symbols[j]
            corr = pearson_correlation(returns[sa], returns[sb])
            matrix[(sa, sb)] = corr
            matrix[(sb, sa)] = corr

    return matrix


def filter_signals_by_correlation(
    pending_signals: list[dict],
    open_positions: list[str],  # símbolos actualmente en cartera
    price_series: dict[str, list[float]],
    max_correlation: float = 0.7,
    max_sector_exposure_pct: float = 30.0,
    sector_map: dict[str, str] | None = None,  # { symbol: sector }
) -> tuple[list[dict], list[CorrelationResult]]:
    """
    Filtra señales de entrada que superan el umbral de correlación
    con posiciones ya abiertas.

    Args:
        pending_signals:         señales con action="long"
        open_positions:          símbolos en cartera actual
        price_series:            precios para calcular correlación
        max_correlation:         umbral máximo de correlación (default 0.7)
        max_sector_exposure_pct: exposición máxima por sector
        sector_map:              mapa de símbolo a sector (opcional)

    Returns:
        (señales_filtradas, lista_de_correlaciones_detectadas)
    """
    if not open_positions or not pending_signals:
        return pending_signals, []

    # Calcular correlaciones entre candidatos y posiciones abiertas
    matrix = build_correlation_matrix(price_series)

    blocked: set[str] = set()
    correlations_found: list[CorrelationResult] = []

    for sig in pending_signals:
        if sig.get("action") != "long":
            continue
        candidate = sig["symbol"]

        for held in open_positions:
            corr = matrix.get((candidate, held), 0.0)
            if abs(corr) >= max_correlation:
                blocked.add(candidate)
                correlations_found.append(
                    CorrelationResult(
                        symbol_a=candidate,
                        symbol_b=held,
                        correlation=corr,
                        correlated=True,
                    )
                )

    # Aplicar filtro a las señales
    filtered: list[dict] = []
    for sig in pending_signals:
        if sig.get("action") != "long":
            filtered.append(sig)
            continue

        if sig["symbol"] in blocked:
            filtered.append(
                {
                    **sig,
                    "action": "cancelled",
                    "cancel_reason": "correlación alta con posición abierta",
                }
            )
        else:
            filtered.append(sig)

    return filtered, correlations_found


if __name__ == "__main__":
    data = json.load(sys.stdin)
    signals, corrs = filter_signals_by_correlation(
        pending_signals=data.get("pending_signals", []),
        open_positions=data.get("open_positions", []),
        price_series=data.get("price_series", {}),
        max_correlation=data.get("max_correlation", 0.7),
    )
    print(
        json.dumps(
            {
                "ok": True,
                "result": {
                    "signals": signals,
                    "correlations_found": [asdict(c) for c in corrs],
                },
            }
        )
    )
