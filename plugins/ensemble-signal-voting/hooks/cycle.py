"""
Hook: cycle — Ensemble Signal Voting + Vol-Targeting
Ejecutado al inicio de cada ciclo del agente.

Lee los precios de los símbolos activos desde el contexto,
calcula señales ensemble para cada símbolo y escribe los resultados
en el contexto para que el agente y el risk-envelope los procesen.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from ensemble import analyze_ensemble  # type: ignore[import]


def run(ctx: dict) -> dict:
    """
    Entrada del hook. `ctx` es el contexto de ciclo del agente.
    Devuelve el contexto actualizado con las señales ensemble.
    """
    config = ctx.get("plugin_config", {})
    price_data = ctx.get("price_data", {})  # {symbol: [float, ...]}

    if not price_data:
        ctx.setdefault("ensemble_signals", {})
        ctx.setdefault("log", []).append("[ensemble] No hay datos de precios en el contexto")
        return ctx

    ensemble_signals: dict[str, dict] = {}

    for symbol, prices in price_data.items():
        if not isinstance(prices, list) or len(prices) < 2:
            ensemble_signals[symbol] = {"signal": 0, "error": "datos insuficientes"}
            continue

        result = analyze_ensemble(symbol, [float(p) for p in prices], config)
        ensemble_signals[symbol] = result

    ctx["ensemble_signals"] = ensemble_signals

    # Inyectar señales como pending_signals para que el risk-envelope las procese
    pending: list[dict] = ctx.get("pending_signals", [])
    for symbol, sig in ensemble_signals.items():
        if sig.get("signal", 0) != 0:
            pending.append(
                {
                    "symbol": symbol,
                    "action": "buy" if sig["signal"] == 1 else "sell",
                    "source": "ensemble-signal-voting",
                    "conviction": sig.get("conviction", 0.0),
                    "position_scale": sig.get("position_scale", 1.0),
                    "votes_long": sig.get("votes_long", 0),
                    "votes_short": sig.get("votes_short", 0),
                    "vol_annual": sig.get("vol_annual", 0.0),
                }
            )

    ctx["pending_signals"] = pending

    active = sum(1 for s in ensemble_signals.values() if s.get("signal", 0) != 0)
    ctx.setdefault("log", []).append(
        f"[ensemble] {len(ensemble_signals)} símbolos analizados, {active} señales activas"
    )

    return ctx


if __name__ == "__main__":
    raw = sys.stdin.read()
    ctx = json.loads(raw)
    out = run(ctx)
    print(json.dumps(out))
