"""
on_cycle hook — Opening Range Breakout.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from orb import analyze  # noqa: E402


def on_cycle(ctx: dict) -> dict:
    universe: list[str] = ctx.get("universe", [])
    config: dict = ctx.get("config", {})
    provider_tools: dict = ctx.get("provider_tools", {})

    range_minutes = config.get("range_minutes", 15)
    breakout_pct = config.get("breakout_confirmation_pct", 0.1)
    vol_mult = config.get("volume_multiplier", 1.2)
    max_entries = config.get("max_entries_per_day", 2)

    # Timeframe 5m → range_minutes / 5 = range_bars
    timeframe = "5m"
    bar_minutes = 5
    range_bars = max(1, range_minutes // bar_minutes)
    bars_needed = range_bars + 78  # ~6.5h de sesión en 5m

    signals = []
    logs = []
    get_ohlcv = provider_tools.get("get_ohlcv")

    # Tracking de entradas por sesión (se reinicia cada ciclo de sesión nueva)
    entries_per_symbol: dict[str, int] = ctx.get("orb_entries_today", {})

    for symbol in universe:
        if not callable(get_ohlcv):
            logs.append({"level": "debug", "msg": f"{symbol}: sin provider"})
            continue
        try:
            bars = get_ohlcv(symbol=symbol, timeframe=timeframe, limit=bars_needed)
            if not bars or len(bars) <= range_bars:
                continue
            closes = [b["close"] for b in bars]
            highs = [b.get("high", b["close"]) for b in bars]
            lows = [b.get("low", b["close"]) for b in bars]
            volumes = [b.get("volume", 1.0) for b in bars]
        except Exception as exc:
            logs.append({"level": "error", "msg": f"{symbol}: error OHLCV — {exc}"})
            continue

        entries_today = entries_per_symbol.get(symbol, 0)
        result = analyze(
            symbol=symbol,
            closes=closes,
            highs=highs,
            lows=lows,
            volumes=volumes,
            range_bars=range_bars,
            breakout_pct=breakout_pct,
            volume_multiplier=vol_mult,
            max_entries=max_entries,
            entries_today=entries_today,
        )

        if result.signal in ("long_breakout", "short_breakout"):
            action = "long" if result.signal == "long_breakout" else "short"
            signals.append(
                {
                    "type": "orb_signal",
                    "symbol": symbol,
                    "action": action,
                    "orb_high": result.orb_high,
                    "orb_low": result.orb_low,
                    "orb_width_pct": result.orb_width_pct,
                    "price": result.current_price,
                    "stop_loss": result.stop_loss,
                    "stop_loss_pct": result.risk_pct,
                    "target_price": result.target_price,
                    "volume_confirmed": result.volume_confirmed,
                    "confidence": result.confidence,
                }
            )

    logs.append(
        {
            "level": "info",
            "msg": (
                f"ORB {range_minutes}m | {timeframe}"
                f" | señales={len(signals)} | universo={len(universe)}"
            ),
        }
    )

    return {"signals": signals, "logs": logs}


if __name__ == "__main__":
    ctx = json.load(sys.stdin)
    print(json.dumps(on_cycle(ctx)))
