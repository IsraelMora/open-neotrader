"""
on_cycle hook — Signal Aggregator.

Recibe todas las señales del ciclo (de otros plugins ya ejecutados),
aplica votación ponderada por símbolo, y devuelve señales consenso.
Reemplaza la lista original con las señales consenso.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from aggregator import aggregate_signals  # noqa: E402


def on_cycle(ctx: dict) -> dict:
    pending_signals: list[dict] = ctx.get("pending_signals", [])
    config: dict = ctx.get("config", {})

    min_conf = config.get("min_confidence", 0.6)
    min_agreement = config.get("min_agreement_pct", 60.0)
    weight_by_conf = config.get("weight_by_confidence", True)
    require_min = config.get("require_min_signals", 2)
    max_per_sym = config.get("max_signals_per_symbol", 10)
    conflict_res = config.get("conflict_resolution", "skip")

    signals = []
    logs = []

    if not pending_signals:
        logs.append({"level": "debug", "msg": "Signal Aggregator: sin señales pendientes"})
        return {"signals": [], "logs": logs}

    consensus = aggregate_signals(
        signals=pending_signals,
        min_confidence=min_conf,
        min_agreement_pct=min_agreement,
        weight_by_confidence=weight_by_conf,
        require_min_signals=require_min,
        max_signals_per_symbol=max_per_sym,
        conflict_resolution=conflict_res,
    )

    # Conservar señales de tipos especiales (pairs, pead, etc.) que no agregar
    special_types = {"pairs_signal", "pead_signal", "pyramid_add"}
    pass_through = [s for s in pending_signals if s.get("type") in special_types]

    for c in consensus:
        signals.append(
            {
                "type": "consensus_signal",
                "symbol": c.symbol,
                "action": c.action,
                "confidence": c.confidence,
                "agreement_pct": c.agreement_pct,
                "vote_long": c.vote_long,
                "vote_short": c.vote_short,
                "contributing_signals": c.contributing_signals,
                "sources": c.sources,
            }
        )
        logs.append(
            {
                "level": "info",
                "msg": f"Consenso {c.symbol}: {c.action} ({c.agreement_pct:.0f}% acuerdo, "
                f"{c.contributing_signals} señales, conf={c.confidence:.0%})"
                + (f" — fuentes: {', '.join(c.sources)}" if c.sources else ""),
            }
        )

    signals += pass_through

    logs.append(
        {
            "level": "info",
            "msg": (
                f"Signal Aggregator: {len(pending_signals)} señales"
                f" → {len(consensus)} consensos + {len(pass_through)} pass-through"
            ),
        }
    )

    return {"signals": signals, "logs": logs}


if __name__ == "__main__":
    ctx = json.load(sys.stdin)
    print(json.dumps(on_cycle(ctx)))
