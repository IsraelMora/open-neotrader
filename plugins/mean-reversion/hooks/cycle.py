"""
on_cycle hook — Mean Reversion.

Fetches OHLCV for each symbol in the universe, runs the mean-reversion
analyze() function, and emits long/short/exit signals.

Security contract: NO network calls here. All data comes through
provider_tools.get_ohlcv (injected by the NestJS runtime).
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from mean_reversion import analyze  # noqa: E402


def on_cycle(ctx: dict) -> dict:
    universe: list[str] = ctx.get("universe", [])
    config: dict = ctx.get("config", {})
    portfolio: dict = ctx.get("portfolio", {})
    provider_tools: dict = ctx.get("provider_tools", {})

    lookback: int = int(config.get("lookback", 20))
    rsi_period: int = int(config.get("rsi_period", 14))
    timeframe: str = config.get("timeframe", "1d")

    # Request enough bars for both z-score window and RSI
    # Full history is used for OU estimation, but we need at least lookback + rsi_period bars
    bars_needed = max(lookback + rsi_period + 10, lookback * 3 + 20)

    signals = []
    logs = []
    get_ohlcv = provider_tools.get("get_ohlcv")

    for symbol in universe:
        if not callable(get_ohlcv):
            logs.append({"level": "debug", "msg": f"{symbol}: no provider, skipping"})
            continue

        try:
            bars = get_ohlcv(symbol=symbol, timeframe=timeframe, limit=bars_needed)
        except Exception as exc:
            logs.append({"level": "error", "msg": f"{symbol}: OHLCV error — {exc}"})
            continue

        if not bars or len(bars) < lookback:
            logs.append({"level": "warning", "msg": f"{symbol}: insufficient data ({len(bars) if bars else 0} bars)"})
            continue

        result = analyze(bars, config)
        signal = result["signal"]
        in_position = symbol in portfolio

        if signal == "long" and in_position:
            # Already long — skip re-entry
            continue
        if signal == "exit" and not in_position:
            # Nothing to exit
            continue
        if signal in ("long", "short", "exit"):
            signals.append(
                {
                    "type": "mean_reversion_signal",
                    "symbol": symbol,
                    "action": signal,
                    "zscore": result["zscore"],
                    "half_life": result["half_life"],
                    "confidence": result["confidence"],
                    "confirmed": result["confirmed"],
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
                f"mean-reversion | {timeframe}"
                f" | long={long_count} | short={short_count} | exit={exit_count}"
                f" | universe={len(universe)}"
            ),
        }
    )

    return {"signals": signals, "logs": logs}


if __name__ == "__main__":
    ctx = json.load(sys.stdin)
    result = on_cycle(ctx)
    print(json.dumps(result))
