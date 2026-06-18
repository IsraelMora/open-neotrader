"""
on_cycle hook — EMA Crossover 9/21.

Obtiene OHLCV de cada símbolo del universo, calcula cruces EMA
y emite señales de entrada/salida con stop dinámico ATR.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from ema_crossover import analyze  # noqa: E402


def on_cycle(ctx: dict) -> dict:
    universe: list[str] = ctx.get("universe", [])
    config: dict = ctx.get("config", {})
    portfolio: dict = ctx.get("portfolio", {})
    provider_tools: dict = ctx.get("provider_tools", {})

    fast_period = config.get("fast_period", 9)
    slow_period = config.get("slow_period", 21)
    timeframe = config.get("timeframe", "1d")
    confirmation_bars = config.get("confirmation_bars", 1)
    atr_stop_multiplier = config.get("atr_stop_multiplier", 2.0)

    # Necesitamos slow_period × 2 + 10 barras mínimo
    bars_needed = slow_period * 2 + confirmation_bars + 10

    signals = []
    logs = []
    get_ohlcv = provider_tools.get("get_ohlcv")

    for symbol in universe:
        if callable(get_ohlcv):
            try:
                bars = get_ohlcv(symbol=symbol, timeframe=timeframe, limit=bars_needed)
                if not bars or len(bars) < bars_needed:
                    logs.append({"level": "warning", "msg": f"{symbol}: datos insuficientes"})
                    continue

                closes = [b["close"] for b in bars]
                highs = [b.get("high", b["close"]) for b in bars]
                lows = [b.get("low", b["close"]) for b in bars]
            except Exception as exc:
                logs.append({"level": "error", "msg": f"{symbol}: error OHLCV — {exc}"})
                continue
        else:
            logs.append({"level": "debug", "msg": f"{symbol}: sin provider, saltando"})
            continue

        result = analyze(
            symbol=symbol,
            closes=closes,
            highs=highs,
            lows=lows,
            fast_period=fast_period,
            slow_period=slow_period,
            confirmation_bars=confirmation_bars,
            atr_stop_multiplier=atr_stop_multiplier,
        )

        if result.signal in ("long", "exit_long"):
            in_position = symbol in portfolio
            # No emitir long si ya estamos en posición, ni exit si no estamos
            if result.signal == "long" and in_position:
                continue
            if result.signal == "exit_long" and not in_position:
                continue

            signals.append(
                {
                    "type": "ema_signal",
                    "symbol": symbol,
                    "action": "long" if result.signal == "long" else "exit",
                    "cross_type": result.cross_type,
                    "ema_fast": result.ema_fast,
                    "ema_slow": result.ema_slow,
                    "atr14": result.atr14,
                    "stop_loss": result.stop_loss,
                    "stop_loss_pct": abs(closes[-1] - (result.stop_loss or closes[-1]))
                    / closes[-1]
                    * 100,
                    "take_profit_trail": result.take_profit_trail,
                    "price": closes[-1],
                    "confidence": 0.65 if result.confirmed else 0.45,
                }
            )

    long_count = sum(1 for s in signals if s["action"] == "long")
    exit_count = sum(1 for s in signals if s["action"] == "exit")
    logs.append(
        {
            "level": "info",
            "msg": (
                f"EMA {fast_period}/{slow_period} | {timeframe}"
                f" | long={long_count} | exit={exit_count} | universo={len(universe)}"
            ),
        }
    )

    return {"signals": signals, "logs": logs}


if __name__ == "__main__":
    ctx = json.load(sys.stdin)
    result = on_cycle(ctx)
    print(json.dumps(result))
