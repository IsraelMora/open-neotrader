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


def run(ctx: dict) -> dict:
    config = ctx.get("plugin_config", {})
    journal = ctx.get("param_journal", [])
    active_ids = ctx.get("active_plugin_ids", [])

    # Avanzar contadores de ciclos
    updated_journal = advance_cycle_counters(journal)
    ctx["param_journal"] = updated_journal

    # Generar estado de lock para plugins activos
    lock_status: dict[str, dict] = {}
    for pid in active_ids:
        lock_status[pid] = check_lock(updated_journal, pid, config)

    ctx["param_lock_status"] = lock_status

    locked_plugins = [pid for pid, status in lock_status.items() if status.get("locked")]
    if locked_plugins:
        ctx.setdefault("log", []).append(
            f"[param-discipline] {len(locked_plugins)} plugin(s)"
            f" con parámetros bloqueados: {', '.join(locked_plugins)}"
        )

    return ctx


if __name__ == "__main__":
    raw = sys.stdin.read()
    ctx = json.loads(raw)
    out = run(ctx)
    print(json.dumps(out))
