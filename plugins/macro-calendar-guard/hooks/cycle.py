"""
Macro Calendar Guard — hook de ciclo.

Filtra señales pendientes según el calendario de eventos macro.
Se ejecuta ANTES de la ejecución de órdenes, DESPUÉS de Portfolio Risk Manager.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from calendar import filter_signals, get_active_blackouts
from datetime import UTC, datetime


def on_cycle(ctx):
    cfg = ctx.get("config", {})
    pending_signals = ctx.get("pending_signals", [])
    extra_events = ctx.get("macro_events", [])  # inyectados por el LLM

    if not pending_signals:
        return {"signals": [], "logs": ["Sin señales pendientes"]}

    now = datetime.now(tz=UTC)

    blackouts = get_active_blackouts(now, cfg, extra_events)

    if not blackouts:
        return {
            "signals": pending_signals,
            "logs": [f"Sin eventos macro activos en {now.strftime('%Y-%m-%d %H:%M')} UTC"],
        }

    approved, suppressed = filter_signals(pending_signals, blackouts, cfg)

    logs = []
    for b in blackouts:
        logs.append(f"{'🚫 BLACKOUT' if b.is_blackout else '⚠️  PRECAUCIÓN'}: {b.reason}")

    if suppressed:
        symbols = [s.get("symbol", "?") for s in suppressed]
        logs.append(f"Suprimidas {len(suppressed)} señales: {', '.join(symbols)}")

    size_reduced = [s for s in approved if "size_reduced_reason" in s]
    if size_reduced:
        symbols = [s.get("symbol", "?") for s in size_reduced]
        logs.append(f"Tamaño reducido en {len(size_reduced)} señales: {', '.join(symbols)}")

    return {
        "signals": approved,
        "suppressed": suppressed,
        "blackouts": [
            {
                "event": b.event.name,
                "is_blackout": b.is_blackout,
                "window_start": b.window_start.isoformat(),
                "window_end": b.window_end.isoformat(),
                "reason": b.reason,
            }
            for b in blackouts
        ],
        "logs": logs,
    }
