"""
Sector Rotation — implementación de referencia.

Basado en Meb Faber (2007) "A Quantitative Approach to Tactical Asset Allocation".
Combina momentum de 12 meses con filtro de media móvil de 10 meses.
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict, dataclass

# Los 11 ETFs SPDR del S&P 500
SPDR_SECTORS = {
    "XLK": "Tecnología",
    "XLV": "Salud",
    "XLF": "Financiero",
    "XLY": "Consumo Discrecional",
    "XLP": "Consumo Básico",
    "XLE": "Energía",
    "XLI": "Industriales",
    "XLB": "Materiales",
    "XLRE": "Inmobiliario",
    "XLU": "Utilities",
    "XLC": "Comunicaciones",
}


@dataclass
class SectorScore:
    symbol: str
    sector_name: str
    momentum_12m: float
    current_price: float
    ma_value: float
    above_ma: bool
    rank: int  # 1 = mejor (entre todos los que pasan el filtro)
    signal: str  # "long" | "exit" | "hold" | "filtered_out"
    weight_pct: float  # peso recomendado en portfolio


def compute_ma(prices: list[float], period: int) -> float:
    """Media simple de los últimos N precios."""
    window = prices[-period:] if len(prices) >= period else prices
    return sum(window) / len(window) if window else 0.0


def rank_sectors(
    sector_data: dict[str, list[float]],  # { symbol: [precio_mes_0...precio_mes_-12] }
    current_positions: set[str],
    top_n: int = 3,
    ma_period: int = 10,
    momentum_period: int = 12,
) -> list[SectorScore]:
    """
    Rankea sectores por momentum y aplica filtro de tendencia.

    Args:
        sector_data:       { ETF_symbol: [precios_mensuales] } (más antiguo primero)
        current_positions: ETFs actualmente en cartera
        top_n:             cuántos sectores mantener
        ma_period:         período de la media móvil (en meses)
        momentum_period:   período del momentum (en meses)

    Returns:
        lista de SectorScore con señales de rotación
    """
    scores: list[tuple[str, float, float, float, bool]] = []
    # (symbol, momentum, current_price, ma_value, above_ma)

    for symbol, prices in sector_data.items():
        if len(prices) < momentum_period + 1:
            continue

        current = prices[-1]
        price_n_ago = prices[-(momentum_period + 1)]

        if price_n_ago <= 0 or current <= 0:
            continue

        momentum = current / price_n_ago - 1.0
        ma = compute_ma(prices, ma_period)
        above_ma = current > ma

        scores.append((symbol, momentum, current, ma, above_ma))

    # Filtrar los que pasan la MA y rankear por momentum
    passing = [(s, m, c, ma, a) for s, m, c, ma, a in scores if a]
    passing.sort(key=lambda x: x[1], reverse=True)

    top_symbols = {s[0] for s in passing[:top_n]}
    weight_pct = 100.0 / top_n if top_n > 0 else 0.0

    results: list[SectorScore] = []
    rank_counter = 0

    for symbol, momentum, current, ma, above_ma in scores:
        in_top = symbol in top_symbols
        in_position = symbol in current_positions

        if in_top:
            rank_counter += 1
            signal = "long"
            rank = rank_counter
        elif in_position:
            signal = "exit"
            rank = 999
        elif not above_ma:
            signal = "filtered_out"
            rank = 999
        else:
            signal = "hold"
            rank = 999

        sector_name = SPDR_SECTORS.get(symbol, symbol)
        results.append(
            SectorScore(
                symbol=symbol,
                sector_name=sector_name,
                momentum_12m=round(momentum, 4),
                current_price=round(current, 4),
                ma_value=round(ma, 4),
                above_ma=above_ma,
                rank=rank,
                signal=signal,
                weight_pct=round(weight_pct if in_top else 0.0, 2),
            )
        )

    # Añadir sectores que no tenían datos suficientes como "hold"
    known_symbols = {s[0] for s in scores}
    for symbol in sector_data:
        if symbol not in known_symbols:
            results.append(
                SectorScore(
                    symbol=symbol,
                    sector_name=SPDR_SECTORS.get(symbol, symbol),
                    momentum_12m=0.0,
                    current_price=0.0,
                    ma_value=0.0,
                    above_ma=False,
                    rank=999,
                    signal="hold",
                    weight_pct=0.0,
                )
            )

    results.sort(key=lambda r: r.rank)
    return results


if __name__ == "__main__":
    data = json.load(sys.stdin)
    results = rank_sectors(
        sector_data=data["sector_data"],
        current_positions=set(data.get("current_positions", [])),
        top_n=data.get("top_sectors", 3),
        ma_period=data.get("ma_period_months", 10),
        momentum_period=data.get("momentum_period_months", 12),
    )
    print(json.dumps({"ok": True, "results": [asdict(r) for r in results]}))
