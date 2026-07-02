"""
on_cycle hook — Trend Following multi-confirmation strategy.

Fetches OHLCV bars for each symbol via provider_tools, runs the three-indicator
consensus analysis, and emits long/short/exit signals.

Modeled on the standard on_cycle hook contract:
  - reads ctx["universe"], ctx["config"], ctx["portfolio"], ctx["provider_tools"]
  - calls provider_tools["get_ohlcv"] — the ONLY data source (no network)
  - respects in_position guard: skips long signal when already long,
    skips exit when not in position
"""

from __future__ import annotations

import json
import os.path as _osp
import sys

sys.path.insert(0, _osp.join(_osp.dirname(__file__), "..", "scripts"))
from trend_following import analyze  # noqa: E402


def on_cycle(ctx: dict) -> dict:
    universe: list[str] = ctx.get("universe", [])
    config: dict = ctx.get("config", {})
    portfolio: dict = ctx.get("portfolio", {})
    provider_tools: dict = ctx.get("provider_tools", {})

    timeframe: str = config.get("timeframe", "1d")
    senkou_b: int = int(config.get("senkou_b", 52))
    kijun: int = int(config.get("kijun", 26))

    # Minimum bars needed: Ichimoku dominates (senkou_b + kijun) plus a buffer
    bars_needed = senkou_b + kijun + 10

    signals: list[dict] = []
    logs: list[dict] = []
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

        if not bars or len(bars) < bars_needed:
            logs.append({
                "level": "warning",
                "msg": f"{symbol}: insufficient bars ({len(bars) if bars else 0}/{bars_needed})",
            })
            continue

        result = analyze(bars, config)

        sig = result["signal"]
        in_position = symbol in portfolio

        if sig == "long":
            if in_position:
                continue  # already long — don't re-enter
            signals.append({
                "type": "trend_following_signal",
                "symbol": symbol,
                "action": "long",
                "confidence": result["confidence"],
                "confirmed": result["confirmed"],
                "reason": result["reason"],
                "meta": {
                    "ema_vote": result["ema_vote"],
                    "macd_vote": result["macd_vote"],
                    "ichimoku_vote": result["ichimoku_vote"],
                    "bull_votes": result["bull_votes"],
                    "bear_votes": result["bear_votes"],
                },
            })

        elif sig in ("short", "exit"):
            if not in_position:
                continue  # not in position — no long to exit
            signals.append({
                "type": "trend_following_signal",
                "symbol": symbol,
                "action": "exit",
                "confidence": result["confidence"],
                "confirmed": result["confirmed"],
                "reason": result["reason"],
                "meta": {
                    "ema_vote": result["ema_vote"],
                    "macd_vote": result["macd_vote"],
                    "ichimoku_vote": result["ichimoku_vote"],
                    "bull_votes": result["bull_votes"],
                    "bear_votes": result["bear_votes"],
                },
            })

    long_count = sum(1 for s in signals if s["action"] == "long")
    exit_count = sum(1 for s in signals if s["action"] == "exit")
    logs.append({
        "level": "info",
        "msg": (
            f"trend-following | {timeframe}"
            f" | long={long_count} | exit={exit_count}"
            f" | universe={len(universe)}"
        ),
    })

    return {"signals": signals, "logs": logs}


if __name__ == "__main__":
    ctx = json.load(sys.stdin)
    result = on_cycle(ctx)
    print(json.dumps(result))
