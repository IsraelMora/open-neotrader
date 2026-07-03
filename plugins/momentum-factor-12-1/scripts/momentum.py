"""
Momentum Factor 12-1 — implementación de referencia.

Referencia: Jegadeesh & Titman (1993), Asness et al. (2013).
"""

from __future__ import annotations

import json
import math
import sys
from dataclasses import asdict, dataclass


@dataclass
class MomentumRank:
    symbol: str
    return_12_1: float  # retorno 12-1 meses
    volatility_12m: float  # volatilidad anualizada 12 meses
    vol_adjusted_score: float  # retorno / volatilidad (para vol-scaling)
    rank: int  # 1 = mejor momentum
    percentile: float  # 0.0 = peor, 1.0 = mejor
    in_top_pct: bool  # True si está en el top_pct configurado
    signal: str  # "long" | "neutral" | "exit"


def compute_momentum_ranks(
    universe_data: dict[str, list[float]],
    top_pct: float = 0.20,
    current_positions: set[str] | None = None,
) -> list[MomentumRank]:
    """
    Calcula rankings de momentum para un universo de activos.

    Args:
        universe_data: { symbol: [precio_mes_0, ..., precio_mes_13] }
                      ORDEN CRONOLÓGICO — índice 0 = MÁS ANTIGUO (hace 13 meses),
                      índice -1 = MÁS RECIENTE (mes actual). Esta es la misma
                      convención que usa el resto del repo (ver
                      plugins/trend-following/scripts/trend_following.py y
                      provider_tools.get_ohlcv, que devuelve las últimas N barras
                      con la más reciente al final).
                      Se necesitan al menos 14 precios mensuales (13 meses + inicial).
        top_pct:      fracción superior del universo a seleccionar (0.20 = 20%)
        current_positions: set de símbolos actualmente en cartera

    Returns:
        lista de MomentumRank ordenada por rank (mejor primero)
    """
    if current_positions is None:
        current_positions = set()

    scores: list[tuple[str, float, float]] = []  # (symbol, return_12_1, vol_12m)

    for symbol, prices in universe_data.items():
        if len(prices) < 14:
            continue  # datos insuficientes

        # índice 0 = hace 13 meses (más antiguo), índice -1 = mes actual (más reciente)
        price_now = prices[-1]
        price_13m_ago = prices[0]

        if price_13m_ago <= 0 or price_now <= 0:
            continue

        # Retorno 12-1 (Jegadeesh & Titman): retorno de 12 meses terminando 1 mes
        # atrás, omitiendo el mes más reciente para evitar reversal de corto plazo.
        # price_skip_1m = precio hace 1 mes (índice -2, el mes que se omite)
        # price_window_start = precio hace 13 meses (índice 0) — 12 meses antes del skip
        price_skip_1m = prices[-2]
        price_window_start = prices[0]
        return_12_1 = price_skip_1m / price_window_start - 1.0

        # Volatilidad anualizada (desviación estándar de retornos mensuales × √12)
        monthly_returns = [prices[i + 1] / prices[i] - 1.0 for i in range(len(prices) - 1)]
        if len(monthly_returns) < 2:
            vol_12m = 0.0
        else:
            mean_r = sum(monthly_returns) / len(monthly_returns)
            variance = sum((r - mean_r) ** 2 for r in monthly_returns) / (len(monthly_returns) - 1)
            vol_12m = math.sqrt(variance * 12)  # anualizamos

        scores.append((symbol, return_12_1, vol_12m))

    if not scores:
        return []

    # Ordenar por retorno 12-1 (mayor = mejor momentum)
    scores.sort(key=lambda x: x[1], reverse=True)
    n = len(scores)

    top_n = max(1, int(n * top_pct))
    top_symbols = {s[0] for s in scores[:top_n]}

    results: list[MomentumRank] = []
    for rank_idx, (symbol, ret, vol) in enumerate(scores, start=1):
        in_top = symbol in top_symbols
        percentile = 1.0 - (rank_idx - 1) / n

        # Vol-adjusted score: mejor measure para weighting dentro del portfolio
        vol_adj = ret / max(vol, 0.01)  # evitar div/0

        # Señal — filtro de momentum absoluto (Antonacci, dual momentum):
        # solo se emite "long" si además de estar en el top relativo, el
        # retorno 12-1 propio del activo es positivo. Sin este filtro un
        # activo podría rankear #1 en un universo en caída generalizada y
        # aun así recibir una señal de compra.
        if in_top and ret > 0:
            signal = "long"
        elif symbol in current_positions:
            signal = "exit"  # estaba en cartera pero salió del top o del filtro absoluto
        else:
            signal = "neutral"

        results.append(
            MomentumRank(
                symbol=symbol,
                return_12_1=round(ret, 4),
                volatility_12m=round(vol, 4),
                vol_adjusted_score=round(vol_adj, 4),
                rank=rank_idx,
                percentile=round(percentile, 4),
                in_top_pct=in_top,
                signal=signal,
            )
        )

    return results


def apply_trend_filter(
    ranks: list[MomentumRank],
    market_trend_up: bool,
) -> list[MomentumRank]:
    """
    Aplica filtro de tendencia de mercado para mitigar momentum crashes.
    Si el mercado está en downtrend (precio < MA200), cancela todas las señales long.

    Daniel & Moskowitz (2016): reduce drawdown de momentum crashes ~40%.
    """
    if market_trend_up:
        return ranks

    for r in ranks:
        if r.signal == "long":
            r.signal = "neutral"  # no entrar en downtrend
    return ranks


if __name__ == "__main__":
    data = json.load(sys.stdin)

    universe_data = data.get("universe_data", {})
    top_pct = data.get("top_pct", 0.20)
    current_positions = set(data.get("current_positions", []))
    market_trend_up = data.get("market_trend_up", True)

    ranks = compute_momentum_ranks(universe_data, top_pct, current_positions)
    ranks = apply_trend_filter(ranks, market_trend_up)

    print(
        json.dumps(
            {
                "ok": True,
                "result": {
                    "rankings": [asdict(r) for r in ranks],
                    "long_signals": [r.symbol for r in ranks if r.signal == "long"],
                    "exit_signals": [r.symbol for r in ranks if r.signal == "exit"],
                    "market_trend_up": market_trend_up,
                    "n_universe": len(ranks),
                },
            }
        )
    )
