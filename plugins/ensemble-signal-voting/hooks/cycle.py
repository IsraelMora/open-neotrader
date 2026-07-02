"""
Hook: cycle — Ensemble Signal Voting + Vol-Targeting
Ejecutado al inicio de cada ciclo del agente.

Lee los precios de los símbolos activos desde el contexto,
calcula señales ensemble para cada símbolo y escribe los resultados
en el contexto para que el agente y el risk-manager los procesen.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from ensemble import analyze_ensemble  # type: ignore[import]


def on_cycle(ctx: dict) -> dict:
    """
    Entrada del hook de ciclo. `ctx` es el contexto de ciclo del agente
    (ver runner.py cmd_run_cycle: config viene en ctx["config"]).

    Devuelve el contrato estándar de skill hooks: {"signals": [...], "logs": [...]}.
    """
    config = ctx.get("config", {})
    price_data = ctx.get("price_data", {})  # {symbol: [float, ...]}
    logs: list[dict] = []

    if not price_data:
        logs.append({"level": "debug", "msg": "[ensemble] No hay datos de precios en el contexto"})
        return {"signals": [], "logs": logs}

    ensemble_signals: dict[str, dict] = {}

    for symbol, prices in price_data.items():
        if not isinstance(prices, list) or len(prices) < 2:
            ensemble_signals[symbol] = {"signal": 0, "error": "datos insuficientes"}
            continue

        result = analyze_ensemble(symbol, [float(p) for p in prices], config)
        ensemble_signals[symbol] = result

    # Nuevas señales generadas por este plugin (el runner las tagea con _plugin)
    signals: list[dict] = []
    for symbol, sig in ensemble_signals.items():
        if sig.get("signal", 0) != 0:
            signals.append(
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

    active = sum(1 for s in ensemble_signals.values() if s.get("signal", 0) != 0)
    logs.append({
        "level": "info",
        "msg": f"[ensemble] {len(ensemble_signals)} símbolos analizados, {active} señales activas",
    })

    return {"signals": signals, "logs": logs}


if __name__ == "__main__":
    raw = sys.stdin.read()
    ctx = json.loads(raw)
    out = on_cycle(ctx)
    print(json.dumps(out))
