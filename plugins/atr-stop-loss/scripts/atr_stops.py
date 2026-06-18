"""
ATR Dynamic Stop Loss — implementación de referencia.

Calcula stops dinámicos adaptativos basados en ATR (Average True Range).
Compatible con cualquier señal de entrada: EMA, Bollinger, RSI, etc.
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict, dataclass


@dataclass
class StopResult:
    symbol: str
    entry_price: float
    stop_loss: float
    trailing_stop: float | None  # None si no hay posición abierta
    take_profit_1r: float  # 1× riesgo (break-even objetivo)
    take_profit_2r: float  # 2× riesgo (objetivo conservador)
    take_profit_3r: float  # 3× riesgo (objetivo ambicioso)
    atr14: float
    risk_per_share: float  # en moneda
    risk_pct: float  # como % del precio de entrada
    stop_type: str  # "initial" | "trailing"


def wilder_atr(
    highs: list[float], lows: list[float], closes: list[float], period: int = 14
) -> float:
    """ATR con suavizado de Wilder (el original, más estable que SMA)."""
    if len(highs) < period + 1:
        return 0.0

    true_ranges: list[float] = []
    for i in range(1, len(highs)):
        tr = max(
            highs[i] - lows[i],
            abs(highs[i] - closes[i - 1]),
            abs(lows[i] - closes[i - 1]),
        )
        true_ranges.append(tr)

    if len(true_ranges) < period:
        return 0.0

    atr = sum(true_ranges[:period]) / period
    for tr in true_ranges[period:]:
        atr = (atr * (period - 1) + tr) / period
    return atr


def calculate_stop(
    symbol: str,
    entry_price: float,
    closes: list[float],
    highs: list[float],
    lows: list[float],
    direction: str = "long",  # "long" | "short"
    atr_period: int = 14,
    stop_multiplier: float = 2.0,
    trailing_multiplier: float = 1.5,
    highest_price: float | None = None,  # para trailing stop en posición abierta
) -> StopResult:
    """
    Calcula stop loss inicial y trailing stop dinámico.

    Args:
        entry_price:      precio de entrada (o precio actual para trailing)
        closes/highs/lows: datos OHLCV
        direction:        "long" (default) o "short"
        atr_period:       período ATR (default 14)
        stop_multiplier:  ATR × mult para stop inicial (default 2.0)
        trailing_multiplier: ATR × mult para trailing (default 1.5)
        highest_price:    máximo alcanzado desde entrada (para trailing)
    """
    atr14 = wilder_atr(highs, lows, closes, atr_period)

    if atr14 == 0.0 or entry_price <= 0:
        return StopResult(
            symbol=symbol,
            entry_price=entry_price,
            stop_loss=0.0,
            trailing_stop=None,
            take_profit_1r=entry_price,
            take_profit_2r=entry_price,
            take_profit_3r=entry_price,
            atr14=0.0,
            risk_per_share=0.0,
            risk_pct=0.0,
            stop_type="initial",
        )

    if direction == "long":
        stop_loss = entry_price - atr14 * stop_multiplier
        trailing_stop = None
        if highest_price and highest_price > entry_price:
            trailing_stop = round(highest_price - atr14 * trailing_multiplier, 4)
            # No mover trailing hacia abajo
            trailing_stop = max(trailing_stop, stop_loss)

        risk_per_share = entry_price - stop_loss
        take_profit_1r = entry_price + risk_per_share
        take_profit_2r = entry_price + risk_per_share * 2
        take_profit_3r = entry_price + risk_per_share * 3

    else:  # short
        stop_loss = entry_price + atr14 * stop_multiplier
        trailing_stop = None
        if highest_price and highest_price < entry_price:
            trailing_stop = round(highest_price + atr14 * trailing_multiplier, 4)
            trailing_stop = min(trailing_stop, stop_loss)

        risk_per_share = stop_loss - entry_price
        take_profit_1r = entry_price - risk_per_share
        take_profit_2r = entry_price - risk_per_share * 2
        take_profit_3r = entry_price - risk_per_share * 3

    risk_pct = risk_per_share / entry_price * 100

    return StopResult(
        symbol=symbol,
        entry_price=round(entry_price, 4),
        stop_loss=round(stop_loss, 4),
        trailing_stop=round(trailing_stop, 4) if trailing_stop else None,
        take_profit_1r=round(take_profit_1r, 4),
        take_profit_2r=round(take_profit_2r, 4),
        take_profit_3r=round(take_profit_3r, 4),
        atr14=round(atr14, 4),
        risk_per_share=round(risk_per_share, 4),
        risk_pct=round(risk_pct, 4),
        stop_type="trailing" if trailing_stop else "initial",
    )


if __name__ == "__main__":
    data = json.load(sys.stdin)
    cmd = data.get("cmd", "calculate_atr_stop")

    if cmd == "calculate_atr_stop":
        result = calculate_stop(
            symbol=data["symbol"],
            entry_price=data["entry_price"],
            closes=data["closes"],
            highs=data.get("highs", data["closes"]),
            lows=data.get("lows", data["closes"]),
            direction=data.get("direction", "long"),
            atr_period=data.get("atr_period", 14),
            stop_multiplier=data.get("stop_multiplier", 2.0),
            trailing_multiplier=data.get("trailing_multiplier", 1.5),
        )
        print(json.dumps({"ok": True, "result": asdict(result)}))

    elif cmd == "update_trailing_stop":
        result = calculate_stop(
            symbol=data["symbol"],
            entry_price=data["entry_price"],
            closes=data["closes"],
            highs=data.get("highs", data["closes"]),
            lows=data.get("lows", data["closes"]),
            direction=data.get("direction", "long"),
            atr_period=data.get("atr_period", 14),
            stop_multiplier=data.get("stop_multiplier", 2.0),
            trailing_multiplier=data.get("trailing_multiplier", 1.5),
            highest_price=data.get("highest_price"),
        )
        print(json.dumps({"ok": True, "result": asdict(result)}))
    else:
        print(json.dumps({"ok": False, "error": f"Comando desconocido: {cmd}"}))
