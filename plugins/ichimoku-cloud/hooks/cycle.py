"""Hook de ciclo Ichimoku — genera señales con confirmación de nube + chikou."""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from ichimoku import analyze_ichimoku


def on_cycle(ctx: dict) -> dict:
    config = ctx.get("config", {})
    universe = ctx.get("universe", [])
    ohlcv = ctx.get("ohlcv", {})

    tenkan = int(config.get("tenkan_period", 9))
    kijun = int(config.get("kijun_period", 26))
    senkou_b = int(config.get("senkou_b_period", 52))
    cloud_confirm = bool(config.get("require_cloud_confirmation", True))
    chikou_confirm = bool(config.get("require_chikou_confirmation", True))

    signals = []
    skipped = []

    for symbol in universe:
        data = ohlcv.get(symbol, {})
        highs = data.get("highs", [])
        lows = data.get("lows", [])
        closes = data.get("closes", [])

        if len(closes) < senkou_b + kijun + 5:
            skipped.append(symbol)
            continue

        result = analyze_ichimoku(
            symbol=symbol,
            highs=highs,
            lows=lows,
            closes=closes,
            tenkan_period=tenkan,
            kijun_period=kijun,
            senkou_b_period=senkou_b,
            require_cloud_confirmation=cloud_confirm,
            require_chikou_confirmation=chikou_confirm,
        )

        if result is None or result.action == "hold":
            continue

        signals.append(
            {
                "symbol": symbol,
                "action": result.action,
                "strength": result.signal_strength,
                "plugin": "ichimoku-cloud",
                "reason": result.reason,
                "meta": {
                    "tenkan": result.tenkan,
                    "kijun": result.kijun,
                    "cloud_top": result.cloud_top,
                    "cloud_bottom": result.cloud_bottom,
                    "cloud_color": result.cloud_color,
                    "above_cloud": result.above_cloud,
                    "below_cloud": result.below_cloud,
                    "chikou_confirmed": result.chikou_confirmed,
                    "tk_cross": result.tenkan_kijun_cross,
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
