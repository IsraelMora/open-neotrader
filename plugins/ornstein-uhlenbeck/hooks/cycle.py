"""Hook on_cycle: analiza todos los símbolos activos con el modelo OU."""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from ou_reversion import analyze_ou  # type: ignore[import]


def run(ctx: dict) -> dict:
    config = ctx.get("plugin_config", {})
    price_data = ctx.get("price_data", {})

    if not price_data:
        ctx.setdefault("log", []).append("[ou] Sin datos de precios en el contexto")
        return ctx

    ou_signals: dict[str, dict] = {}
    pending: list[dict] = ctx.get("pending_signals", [])

    for symbol, prices in price_data.items():
        if not isinstance(prices, list) or len(prices) < 20:
            continue
        result = analyze_ou(symbol, [float(p) for p in prices], config)
        ou_signals[symbol] = {
            "signal": result.signal,
            "z_score": result.z_score,
            "half_life": result.half_life,
            "mu": result.mu,
            "valid": result.valid,
            "reason": result.reason,
        }

        if result.signal != 0 and result.valid:
            pending.append(
                {
                    "symbol": symbol,
                    "action": "buy" if result.signal == 1 else "sell",
                    "source": "ornstein-uhlenbeck",
                    "z_score": result.z_score,
                    "half_life": result.half_life,
                    "reason": result.reason,
                }
            )

    ctx["ou_signals"] = ou_signals
    ctx["pending_signals"] = pending
    active = sum(1 for s in ou_signals.values() if s["signal"] != 0)
    ctx.setdefault("log", []).append(
        f"[ou] {len(ou_signals)} símbolos analizados, {active} señales activas"
    )
    return ctx


if __name__ == "__main__":
    ctx = json.loads(sys.stdin.read())
    print(json.dumps(run(ctx)))
