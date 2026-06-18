"""
on_cycle hook — Position Sizing Pyramid.

Para cada señal "long" entrante, genera un plan de pirámide (tranches).
Para posiciones ya abiertas, evalúa si se debe añadir la siguiente tranche.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from pyramid import calculate_tranches, evaluate_add  # noqa: E402


def on_cycle(ctx: dict) -> dict:
    pending_signals: list[dict] = ctx.get("pending_signals", [])
    portfolio: dict = ctx.get("portfolio", {})
    config: dict = ctx.get("config", {})

    entry_pct = config.get("entry_pct", 40.0)
    add_pct = config.get("add_pct", 30.0)
    max_tranches = config.get("max_tranches", 3)
    add_trigger_r = config.get("add_trigger_r", 1.0)
    trail_stop = config.get("trail_stop_after_add", True)

    signals = []
    logs = []

    # Procesar señales entrantes de otros skills
    for sig in pending_signals:
        if sig.get("action") != "long":
            signals.append(sig)
            continue

        symbol = sig["symbol"]
        entry_price = sig.get("entry_price") or sig.get("price", 0.0)
        stop_loss = sig.get("stop_loss", 0.0)
        target = sig.get("target_price", entry_price * 1.1 if entry_price else 0.0)
        total_size = sig.get("size_pct", 10.0)

        if not entry_price or not stop_loss:
            signals.append(sig)
            continue

        plan = calculate_tranches(
            symbol=symbol,
            entry_price=entry_price,
            stop_loss=stop_loss,
            target_price=target,
            total_size_pct=total_size,
            entry_pct=entry_pct,
            add_pct=add_pct,
            max_tranches=max_tranches,
            add_trigger_r=add_trigger_r,
        )

        # Ajustar la señal original con sólo la primera tranche
        first_tranche = plan.tranches[0]
        enriched_sig = {
            **sig,
            "size_pct": first_tranche.size_pct,
            "pyramid_plan": {
                "total_tranches": len(plan.tranches),
                "executed_tranches": 1,
                "remaining_tranches": [
                    {"number": t.number, "size_pct": t.size_pct, "trigger_price": t.trigger_price}
                    for t in plan.tranches[1:]
                ],
            },
        }
        signals.append(enriched_sig)
        logs.append(
            {
                "level": "info",
                "msg": (
                    f"Pirámide {symbol}: entrada {first_tranche.size_pct:.1f}%"
                    f" @ {entry_price} | {len(plan.tranches) - 1} add(s) pendiente(s)"
                ),
            }
        )

    # Evaluar posiciones abiertas para adds
    for symbol, position in portfolio.items():
        meta = position.get("meta", {})
        pyramid = meta.get("pyramid_plan")
        if not pyramid:
            continue

        executed = pyramid.get("executed_tranches", 1)
        if executed >= max_tranches:
            continue

        current_price = position.get("current_price", 0.0)
        entry_price = position.get("entry_price", 0.0)
        stop_loss = position.get("stop_loss", 0.0)
        total_size = position.get("target_size_pct", 10.0)

        if not current_price or not entry_price:
            continue

        add_sig = evaluate_add(
            symbol=symbol,
            current_price=current_price,
            entry_price=entry_price,
            stop_loss=stop_loss,
            tranches_executed=executed,
            max_tranches=max_tranches,
            add_trigger_r=add_trigger_r,
            add_pct=add_pct,
            total_size_pct=total_size,
            trail_stop_after_add=trail_stop,
        )

        if add_sig.add_now:
            signals.append(
                {
                    "type": "pyramid_add",
                    "symbol": symbol,
                    "action": "long",
                    "size_pct": add_sig.size_pct,
                    "tranche_number": add_sig.tranche_number,
                    "new_stop": add_sig.new_stop,
                    "reason": add_sig.reason,
                    "confidence": 0.80,
                }
            )
            logs.append(
                {
                    "level": "info",
                    "msg": (
                        f"Pirámide {symbol}: add #{add_sig.tranche_number - 1}"
                        f" @ {current_price} (+{add_sig.size_pct:.1f}%)"
                    ),
                }
            )
        else:
            logs.append(
                {
                    "level": "debug",
                    "msg": (
                        f"Pirámide {symbol}: {add_sig.reason}"
                        f" ({add_sig.progress_pct:.0f}% del camino)"
                    ),
                }
            )

    return {"signals": signals, "logs": logs}


if __name__ == "__main__":
    ctx = json.load(sys.stdin)
    print(json.dumps(on_cycle(ctx)))
