"""Hook de ciclo MACD — genera señales long/short para el universo activo."""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from macd import analyze_macd


def on_cycle(ctx: dict) -> dict:
    config = ctx.get("config", {})
    universe = ctx.get("universe", [])
    ohlcv = ctx.get("ohlcv", {})  # {symbol: {closes: [...], highs: [...], lows: [...]}}

    fast = int(config.get("fast_period", 12))
    slow = int(config.get("slow_period", 26))
    signal_p = int(config.get("signal_period", 9))
    require_crossover = bool(config.get("require_crossover", True))
    divergence_bars = int(config.get("divergence_bars", 14))
    min_histogram = float(config.get("min_histogram", 0.0))

    signals = []
    skipped = []

    for symbol in universe:
        data = ohlcv.get(symbol, {})
        closes = data.get("closes", [])

        if len(closes) < slow + signal_p + 5:
            skipped.append(symbol)
            continue

        result = analyze_macd(
            symbol=symbol,
            closes=closes,
            fast=fast,
            slow=slow,
            signal_period=signal_p,
            require_crossover=require_crossover,
            divergence_bars=divergence_bars,
            min_histogram=min_histogram,
        )

        if result is None or result.action == "hold":
            continue

        signals.append(
            {
                "symbol": symbol,
                "action": result.action,
                "strength": result.signal_strength,
                "plugin": "macd-signal",
                "reason": result.reason,
                "meta": {
                    "crossover": result.crossover,
                    "divergence": result.divergence,
                    "last_histogram": result.last_histogram,
                },
            }
        )

    return {
        "signals": signals,
        "meta": {
            "analyzed": len(universe) - len(skipped),
            "skipped": skipped,
            "signals_count": len(signals),
        },
    }
