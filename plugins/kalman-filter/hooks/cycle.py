"""Hook on_cycle: analiza todos los símbolos con el filtro de Kalman."""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from kalman import analyze_kalman  # type: ignore[import]


def on_cycle(ctx: dict) -> dict:
    config = ctx.get("config", {})
    price_data = ctx.get("price_data", {})

    if not price_data:
        return {"signals": [], "logs": [{"level": "debug", "msg": "[kalman] Sin datos de precios"}]}

    kalman_signals: dict[str, dict] = {}
    signals: list[dict] = []

    for symbol, prices in price_data.items():
        if not isinstance(prices, list) or len(prices) < 10:
            continue
        result = analyze_kalman(symbol, [float(p) for p in prices], config)
        kalman_signals[symbol] = {
            "signal": result.signal,
            "kalman_estimate": result.kalman_estimate,
            "deviation_pct": result.deviation_pct,
            "trend": result.trend,
            "kalman_gain": result.kalman_gain,
            "reason": result.reason,
        }

        if result.signal != 0:
            signals.append(
                {
                    "symbol": symbol,
                    "action": "buy" if result.signal == 1 else "sell",
                    "source": "kalman-filter",
                    "trend": result.trend,
                    "deviation": result.deviation_pct,
                    "reason": result.reason,
                }
            )

    active = sum(1 for s in kalman_signals.values() if s["signal"] != 0)
    logs = [{
        "level": "info",
        "msg": f"[kalman] {len(kalman_signals)} símbolos, {active} señales activas",
    }]
    return {"signals": signals, "logs": logs}


if __name__ == "__main__":
    ctx = json.loads(sys.stdin.read())
    print(json.dumps(on_cycle(ctx)))
