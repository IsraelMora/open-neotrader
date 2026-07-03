"""
on_cycle hook — Session-Open Breakout.

Fetches daily OHLCV for each symbol in the universe, runs session_breakout.analyze(),
and maps "long"/"short"/"exit" signals to the standard signal dict format.

Network is NOT allowed here — all data access goes through provider_tools.get_ohlcv.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from session_breakout import analyze  # noqa: E402

# Minimum bars to fetch — need prev close + today + some history
_MIN_BARS = 30


def on_cycle(ctx: dict) -> dict:
    universe: list[str] = ctx.get("universe", [])
    config: dict = ctx.get("config", {})
    portfolio: dict = ctx.get("portfolio", {})
    provider_tools: dict = ctx.get("provider_tools", {})

    timeframe = config.get("timeframe", "1d")
    get_ohlcv = provider_tools.get("get_ohlcv")

    signals: list[dict] = []
    logs: list[dict] = []

    for symbol in universe:
        if not callable(get_ohlcv):
            logs.append({"level": "debug", "msg": f"{symbol}: no provider available, skipping"})
            continue

        try:
            bars = get_ohlcv(symbol=symbol, timeframe=timeframe, limit=_MIN_BARS)
            if not bars or len(bars) < 3:
                logs.append(
                    {
                        "level": "warning",
                        "msg": f"{symbol}: insufficient bars ({len(bars) if bars else 0})",
                    }
                )
                continue
        except Exception as exc:
            logs.append({"level": "error", "msg": f"{symbol}: OHLCV fetch failed — {exc}"})
            continue

        result = analyze(bars, config)
        signal = result["signal"]

        # Guard: don't emit "long" if already in position; don't emit "exit" if flat
        in_position = symbol in portfolio

        if signal == "long":
            if in_position:
                logs.append(
                    {
                        "level": "debug",
                        "msg": f"{symbol}: long signal skipped (already in position)",
                    }
                )
                continue
        elif signal in ("short", "exit"):
            if not in_position:
                logs.append(
                    {
                        "level": "debug",
                        "msg": f"{symbol}: {signal} signal skipped (not in position)",
                    }
                )
                continue
        elif signal == "none":
            continue

        signals.append(
            {
                "type": "session_breakout_signal",
                "symbol": symbol,
                "action": signal,   # "long" | "short" | "exit"
                "gap_pct": result["gap_pct"],
                "confirmed": result["confirmed"],
                "confidence": result["confidence"],
                "reason": result["reason"],
                "price": bars[-1]["close"],
            }
        )

    long_count = sum(1 for s in signals if s["action"] == "long")
    short_count = sum(1 for s in signals if s["action"] == "short")
    exit_count = sum(1 for s in signals if s["action"] == "exit")
    logs.append(
        {
            "level": "info",
            "msg": (
                f"SessionBreakout | {timeframe}"
                f" | long={long_count} short={short_count} exit={exit_count}"
                f" | universe={len(universe)}"
            ),
        }
    )

    return {"signals": signals, "logs": logs}


if __name__ == "__main__":
    ctx = json.load(sys.stdin)
    print(json.dumps(on_cycle(ctx)))
