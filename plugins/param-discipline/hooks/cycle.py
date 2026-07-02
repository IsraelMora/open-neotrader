"""
Hook on_cycle del Param Discipline.
- Avanza los contadores de ciclos en el journal
- Inyecta en el contexto el estado de lock de cada plugin activo
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from param_discipline import advance_cycle_counters, check_lock  # type: ignore[import]


def on_cycle(ctx: dict) -> dict:
    """
    Discipline hook — matches the {"signals": [...], "logs": [...]} contract
    used by _runVetoLayer (apps/api/src/agents/agents.service.ts) for every
    active discipline plugin. param-discipline does not filter/rescale trade
    signals — it only governs plugin-parameter changes — so pending_signals
    pass through unchanged; lock status is reported via logs.
    """
    config = ctx.get("config", {})
    journal = ctx.get("param_journal", [])
    active_ids = ctx.get("active_plugin_ids", [])
    pending_signals: list[dict] = ctx.get("pending_signals", [])

    # Avanzar contadores de ciclos
    updated_journal = advance_cycle_counters(journal)

    # Generar estado de lock para plugins activos
    lock_status: dict[str, dict] = {}
    for pid in active_ids:
        lock_status[pid] = check_lock(updated_journal, pid, config)

    logs: list[dict] = []
    locked_plugins = [pid for pid, status in lock_status.items() if status.get("locked")]
    if locked_plugins:
        logs.append({
            "level": "info",
            "msg": (
                f"[param-discipline] {len(locked_plugins)} plugin(s)"
                f" con parámetros bloqueados: {', '.join(locked_plugins)}"
            ),
        })

    return {"signals": pending_signals, "logs": logs}


if __name__ == "__main__":
    raw = sys.stdin.read()
    ctx = json.loads(raw)
    out = on_cycle(ctx)
    print(json.dumps(out))
