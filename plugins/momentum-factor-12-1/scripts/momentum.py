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
    signal: str  # "long" | "neutral" | "exit" | "short"


def compute_momentum_ranks(
    universe_data: dict[str, list[float]],
    top_pct: float = 0.20,
    lookback_months: int = 12,
    current_positions: set[str] | None = None,
    enable_short: bool = False,
    short_bottom_pct: float = 0.10,
) -> list[MomentumRank]:
    """
    Calcula rankings de momentum para un universo de activos.

    Args:
        universe_data: { symbol: [precio_mes_0, ..., precio_mes_N] }
                      ORDEN CRONOLÓGICO — índice 0 = MÁS ANTIGUO, índice -1 =
                      MÁS RECIENTE (mes actual). Esta es la misma convención que
                      usa el resto del repo (ver
                      plugins/trend-following/scripts/trend_following.py y
                      provider_tools.get_ohlcv, que devuelve las últimas N barras
                      con la más reciente al final).
                      Se necesitan al menos `lookback_months + 2` precios mensuales
                      (el mes que se omite + el período de lookback + el precio
                      inicial de la ventana).
        top_pct:      fracción superior del universo a seleccionar (0.20 = 20%)
        lookback_months: longitud de la ventana de momentum en meses (configurable
                      por portfolio, ver plugins/momentum-factor-12-1/manifest.toml
                      [config.lookback_months]). Con lookback_months=12 este cálculo
                      reproduce exactamente el 12-1 canónico (Jegadeesh & Titman).
        current_positions: set de símbolos actualmente en cartera
        enable_short: OPT-IN (default False). Cuando está en False el
                      comportamiento es idéntico al long/exit-only original —
                      nunca se emite signal="short". Cuando está en True, se
                      emite "short" para el peor `short_bottom_pct` del
                      universo, PERO solo para símbolos con momentum absoluto
                      NEGATIVO (return_12_1 < 0) — evita shortear un activo
                      que simplemente es el "2do mejor" de un universo alcista.
        short_bottom_pct: fracción inferior del universo candidata a short
                      (ej. 0.10 = peor 10%). Ignorado si enable_short=False.

    Returns:
        lista de MomentumRank ordenada por rank (mejor primero)
    """
    if current_positions is None:
        current_positions = set()

    min_len = lookback_months + 2

    scores: list[tuple[str, float, float]] = []  # (symbol, return_12_1, vol_12m)

    for symbol, prices in universe_data.items():
        if len(prices) < min_len:
            continue  # datos insuficientes para la ventana configurada

        price_now = prices[-1]
        price_window_start = prices[-min_len]

        if price_window_start <= 0 or price_now <= 0:
            continue

        # Retorno N-1 (skip-1-month momentum, Jegadeesh & Titman generalizado a
        # lookback_months): retorno de `lookback_months` meses terminando 1 mes
        # atrás, omitiendo el mes más reciente para evitar reversal de corto plazo.
        # price_skip_1m = precio hace 1 mes (índice -2, el mes que se omite)
        # price_window_start = precio hace (lookback_months + 1) meses — inicio de
        # la ventana de `lookback_months` meses que termina en el skip.
        price_skip_1m = prices[-2]
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

    # Candidatos a short: el peor `short_bottom_pct` del universo (cola de la
    # lista ordenada desc por retorno). Solo se calcula/usa si enable_short.
    bottom_symbols: set[str] = set()
    if enable_short:
        bottom_n = max(1, int(n * short_bottom_pct))
        bottom_symbols = {s[0] for s in scores[-bottom_n:]}

    results: list[MomentumRank] = []
    for rank_idx, (symbol, ret, vol) in enumerate(scores, start=1):
        in_top = symbol in top_symbols
        in_bottom = symbol in bottom_symbols
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
        elif enable_short and in_bottom and ret < 0:
            # Mismo filtro de momentum absoluto pero espejado: solo shortear
            # si el activo tiene momentum absoluto NEGATIVO, no solo el peor
            # relativo del universo (evita shortear el "2do mejor" en un
            # mercado alcista).
            signal = "short"
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
    lookback_months = data.get("lookback_months", 12)
    current_positions = set(data.get("current_positions", []))
    market_trend_up = data.get("market_trend_up", True)
    enable_short = data.get("enable_short", False)
    short_bottom_pct = data.get("short_bottom_pct", 0.10)

    ranks = compute_momentum_ranks(
        universe_data,
        top_pct,
        lookback_months,
        current_positions=current_positions,
        enable_short=enable_short,
        short_bottom_pct=short_bottom_pct,
    )
    ranks = apply_trend_filter(ranks, market_trend_up)

    print(
        json.dumps(
            {
                "ok": True,
                "result": {
                    "rankings": [asdict(r) for r in ranks],
                    "long_signals": [r.symbol for r in ranks if r.signal == "long"],
                    "exit_signals": [r.symbol for r in ranks if r.signal == "exit"],
                    "short_signals": [r.symbol for r in ranks if r.signal == "short"],
                    "market_trend_up": market_trend_up,
                    "n_universe": len(ranks),
                },
            }
        )
    )
