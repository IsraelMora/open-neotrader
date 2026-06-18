"""
on_cycle hook — VWAP Reversion.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from vwap import analyze  # noqa: E402


def on_cycle(ctx: dict) -> dict:
    universe: list[str] = ctx.get("universe", [])
    config: dict = ctx.get("config", {})
    provider_tools: dict = ctx.get("provider_tools", {})

    deviation_bands = config.get("deviation_bands", 2.0)
    min_volume_ratio = config.get("min_volume_ratio", 0.8)
    target_vwap_pct = config.get("target_vwap_pct", 50.0)
    timeframe = config.get("timeframe", "5m")
    bars_today = 80  # ~6.5h × 12 barras de 5m, con margen

    signals = []
    logs = []
    get_ohlcv = provider_tools.get("get_ohlcv")

    for symbol in universe:
        if not callable(get_ohlcv):
            logs.append({"level": "debug", "msg": f"{symbol}: sin provider"})
            continue
        try:
            bars = get_ohlcv(symbol=symbol, timeframe=timeframe, limit=bars_today)
            if not bars or len(bars) < 5:
                continue
            closes = [b["close"] for b in bars]
            highs = [b.get("high", b["close"]) for b in bars]
            lows = [b.get("low", b["close"]) for b in bars]
            volumes = [b.get("volume", 1.0) for b in bars]
        except Exception as exc:
            logs.append({"level": "error", "msg": f"{symbol}: error OHLCV — {exc}"})
            continue

        result = analyze(
            symbol=symbol,
            closes=closes,
            highs=highs,
            lows=lows,
            volumes=volumes,
            deviation_bands=deviation_bands,
            target_vwap_pct=target_vwap_pct,
            min_volume_ratio=min_volume_ratio,
        )

        if result.signal in ("long_reversion", "short_reversion"):
            action = "long" if result.signal == "long_reversion" else "short"
            signals.append(
                {
                    "type": "vwap_signal",
                    "symbol": symbol,
                    "action": action,
                    "price": result.current_price,
                    "vwap": result.vwap,
                    "sigma": result.sigma,
                    "deviation_sigma": result.deviation_sigma,
                    "stop_loss": result.stop_loss,
                    "target_price": result.target_price,
                    "confidence": result.confidence,
                }
            )

    logs.append(
        {
            "level": "info",
            "msg": (
                f"VWAP Reversion | {timeframe}"
                f" | señales={len(signals)} | universo={len(universe)}"
            ),
        }
    )

    return {"signals": signals, "logs": logs}


if __name__ == "__main__":
    ctx = json.load(sys.stdin)
    print(json.dumps(on_cycle(ctx)))
