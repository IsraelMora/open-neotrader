"""
on_cycle hook — Bollinger Band Squeeze.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from squeeze import analyze  # noqa: E402


def on_cycle(ctx: dict) -> dict:
    universe: list[str] = ctx.get("universe", [])
    config: dict = ctx.get("config", {})
    provider_tools: dict = ctx.get("provider_tools", {})

    bb_period = config.get("bb_period", 20)
    bb_std = config.get("bb_std", 2.0)
    kc_period = config.get("kc_period", 20)
    kc_multiplier = config.get("kc_multiplier", 1.5)
    min_squeeze_bars = config.get("min_squeeze_bars", 5)
    bars_needed = max(bb_period, kc_period) * 3

    signals = []
    logs = []
    get_ohlcv = provider_tools.get("get_ohlcv")

    for symbol in universe:
        if not callable(get_ohlcv):
            logs.append({"level": "debug", "msg": f"{symbol}: sin provider"})
            continue
        try:
            bars = get_ohlcv(symbol=symbol, timeframe="1d", limit=bars_needed)
            if not bars or len(bars) < bars_needed // 2:
                logs.append({"level": "warning", "msg": f"{symbol}: datos insuficientes"})
                continue
            closes = [b["close"] for b in bars]
            highs = [b.get("high", b["close"]) for b in bars]
            lows = [b.get("low", b["close"]) for b in bars]
        except Exception as exc:
            logs.append({"level": "error", "msg": f"{symbol}: error OHLCV — {exc}"})
            continue

        result = analyze(
            symbol=symbol,
            closes=closes,
            highs=highs,
            lows=lows,
            bb_period=bb_period,
            bb_std=bb_std,
            kc_period=kc_period,
            kc_multiplier=kc_multiplier,
            min_squeeze_bars=min_squeeze_bars,
        )

        if result.signal in ("long_breakout", "short_breakout"):
            action = "long" if result.signal == "long_breakout" else "short"
            signals.append(
                {
                    "type": "squeeze_signal",
                    "symbol": symbol,
                    "action": action,
                    "squeeze_bars": result.squeeze_bars,
                    "momentum": result.momentum,
                    "momentum_direction": result.momentum_direction,
                    "bb_upper": result.bb_upper,
                    "bb_lower": result.bb_lower,
                    "bb_width_pct": result.bb_width_pct,
                    "price": result.price,
                    "confidence": result.confidence,
                }
            )
        elif result.signal == "squeeze_forming":
            logs.append(
                {
                    "level": "debug",
                    "msg": (
                        f"{symbol}: squeeze en formación ({result.squeeze_bars} barras, "
                        f"BB width {result.bb_width_pct:.2f}%)"
                    ),
                }
            )

    long_count = sum(1 for s in signals if s["action"] == "long")
    logs.append(
        {
            "level": "info",
            "msg": (
                f"Bollinger Squeeze | señales={len(signals)} long={long_count}"
                f" | universo={len(universe)}"
            ),
        }
    )

    return {"signals": signals, "logs": logs}


if __name__ == "__main__":
    ctx = json.load(sys.stdin)
    print(json.dumps(on_cycle(ctx)))
