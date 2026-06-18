"""
on_cycle hook — ATR Dynamic Stop Loss (Discipline).

En cada ciclo:
1. Para señales de nueva entrada: calcula el stop loss inicial ATR
2. Para posiciones abiertas: actualiza el trailing stop
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from atr_stops import calculate_stop  # noqa: E402


def on_cycle(ctx: dict) -> dict:
    pending_signals: list[dict] = ctx.get("pending_signals", [])
    open_positions: list[dict] = ctx.get(
        "open_positions", []
    )  # { symbol, entry_price, highest_price, direction }
    config: dict = ctx.get("config", {})
    provider_tools: dict = ctx.get("provider_tools", {})

    atr_period = config.get("atr_period", 14)
    stop_multiplier = config.get("stop_multiplier", 2.0)
    trailing_multiplier = config.get("trailing_multiplier", 1.5)
    timeframe = config.get("timeframe", "1d")
    bars_needed = atr_period * 3

    signals = []
    logs = []
    get_ohlcv = provider_tools.get("get_ohlcv")

    def fetch_bars(symbol: str) -> tuple[list, list, list] | None:
        if not callable(get_ohlcv):
            return None
        try:
            bars = get_ohlcv(symbol=symbol, timeframe=timeframe, limit=bars_needed)
            if not bars or len(bars) < atr_period + 1:
                return None
            return (
                [b["close"] for b in bars],
                [b.get("high", b["close"]) for b in bars],
                [b.get("low", b["close"]) for b in bars],
            )
        except Exception:
            return None

    # 1. Enriquecer señales de entrada con stop loss inicial
    for sig in pending_signals:
        if sig.get("action") not in ("long", "short"):
            signals.append(sig)
            continue

        symbol = sig["symbol"]
        price = sig.get("price", 0.0)
        direction = "long" if sig["action"] == "long" else "short"

        bar_data = fetch_bars(symbol)
        if not bar_data or price <= 0:
            signals.append(sig)  # pasar sin modificar si no hay datos
            continue

        closes, highs, lows = bar_data
        stop_result = calculate_stop(
            symbol=symbol,
            entry_price=price,
            closes=closes,
            highs=highs,
            lows=lows,
            direction=direction,
            atr_period=atr_period,
            stop_multiplier=stop_multiplier,
            trailing_multiplier=trailing_multiplier,
        )

        enriched = {
            **sig,
            "stop_loss": stop_result.stop_loss,
            "stop_loss_pct": stop_result.risk_pct,
            "take_profit_1r": stop_result.take_profit_1r,
            "take_profit_2r": stop_result.take_profit_2r,
            "take_profit_3r": stop_result.take_profit_3r,
            "atr14": stop_result.atr14,
            "risk_per_share": stop_result.risk_per_share,
        }
        signals.append(enriched)

    # 2. Actualizar trailing stops para posiciones abiertas
    trailing_updates = []
    for pos in open_positions:
        symbol = pos.get("symbol")
        if not symbol:
            continue
        bar_data = fetch_bars(symbol)
        if not bar_data:
            continue

        closes, highs, lows = bar_data
        stop_result = calculate_stop(
            symbol=symbol,
            entry_price=pos.get("entry_price", closes[-1]),
            closes=closes,
            highs=highs,
            lows=lows,
            direction=pos.get("direction", "long"),
            atr_period=atr_period,
            stop_multiplier=stop_multiplier,
            trailing_multiplier=trailing_multiplier,
            highest_price=pos.get("highest_price"),
        )

        if stop_result.trailing_stop:
            trailing_updates.append(
                {
                    "symbol": symbol,
                    "trailing_stop": stop_result.trailing_stop,
                    "atr14": stop_result.atr14,
                }
            )

    logs.append(
        {
            "level": "info",
            "msg": (
                f"ATR Stop Loss | señales enriched={len([s for s in signals if 'stop_loss' in s])}"
                f" | trailing updates={len(trailing_updates)}"
            ),
        }
    )

    return {"signals": signals, "logs": logs, "trailing_updates": trailing_updates}


if __name__ == "__main__":
    ctx = json.load(sys.stdin)
    print(json.dumps(on_cycle(ctx)))
