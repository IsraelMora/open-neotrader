"""
Param Discipline — Journal y Lock de Parámetros
=================================================
Evita el overfitting accidental imponiendo un flujo estructurado
para cambios de parámetros:

  1. journal_entry(plugin_id, params, reason, hypothesis)
     → Registra el cambio con una justificación y una hipótesis testeable

  2. check_lock(plugin_id)
     → Verifica si el plugin está en período de lock (N ciclos sin cambios)

  3. get_journal(plugin_id?)
     → Historial de cambios (para el LLM y la auditoría)

Estado persistido en: ctx["param_journal"] (lista de entradas)
El lock se mantiene N ciclos desde el último cambio.
"""

from __future__ import annotations

import json
import sys
import time
from dataclasses import asdict, dataclass
from typing import Any


@dataclass
class JournalEntry:
    id: str
    plugin_id: str
    params_before: dict
    params_after: dict
    reason: str
    hypothesis: str
    cycle_id: str
    ts: str
    cycles_since: int = 0  # se incrementa en cada ciclo


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _short_id() -> str:
    import random
    import string

    return "".join(random.choices(string.ascii_lowercase + string.digits, k=8))


def journal_entry(
    journal: list[dict],
    plugin_id: str,
    params_before: dict,
    params_after: dict,
    reason: str,
    hypothesis: str,
    cycle_id: str,
    config: dict[str, Any],
) -> tuple[list[dict], dict]:
    """Registra un cambio de parámetros en el journal."""
    min_hyp_len = int(config.get("min_hypothesis_length", 50))
    require_hyp = bool(config.get("require_hypothesis", True))

    # Validaciones
    if require_hyp and len(hypothesis.strip()) < min_hyp_len:
        return journal, {
            "ok": False,
            "error": (
                f"La hipótesis debe tener al menos {min_hyp_len} caracteres"
                f" (tiene {len(hypothesis.strip())})"
            ),
        }

    # Verificar límite semanal de cambios
    max_per_week = int(config.get("max_changes_per_week", 5))
    week_ago_ts = time.time() - 7 * 24 * 3600
    recent = [
        e
        for e in journal
        if e.get("plugin_id") == plugin_id and _ts_to_unix(e.get("ts", "")) > week_ago_ts
    ]

    if len(recent) >= max_per_week:
        return journal, {
            "ok": False,
            "error": f"Límite de {max_per_week} cambios semanales alcanzado para {plugin_id}",
        }

    entry = JournalEntry(
        id=_short_id(),
        plugin_id=plugin_id,
        params_before=params_before,
        params_after=params_after,
        reason=reason,
        hypothesis=hypothesis,
        cycle_id=cycle_id,
        ts=_now_iso(),
        cycles_since=0,
    )
    updated_journal = [*journal, asdict(entry)]

    return updated_journal, {
        "ok": True,
        "entry_id": entry.id,
        "message": (
            f"Cambio registrado para {plugin_id}."
            f" Lock activo por {config.get('lock_after_change_cycles', 3)} ciclos."
        ),
    }


def check_lock(journal: list[dict], plugin_id: str, config: dict[str, Any]) -> dict:
    """Verifica si un plugin está en período de lock."""
    lock_cycles = int(config.get("lock_after_change_cycles", 3))

    # Buscar la entrada más reciente para este plugin
    plugin_entries = [e for e in journal if e.get("plugin_id") == plugin_id]
    if not plugin_entries:
        return {"locked": False, "plugin_id": plugin_id, "reason": "Sin cambios registrados"}

    latest = max(plugin_entries, key=lambda e: e.get("ts", ""))
    cycles_since = int(latest.get("cycles_since", 0))

    if cycles_since < lock_cycles:
        remaining = lock_cycles - cycles_since
        return {
            "locked": True,
            "plugin_id": plugin_id,
            "reason": (
                f"Cambio reciente ({cycles_since} ciclos atrás)."
                f" Lock por {remaining} ciclos más."
            ),
            "entry_id": latest.get("id"),
            "hypothesis": latest.get("hypothesis", ""),
        }

    return {
        "locked": False,
        "plugin_id": plugin_id,
        "cycles_since_last_change": cycles_since,
    }


def advance_cycle_counters(journal: list[dict]) -> list[dict]:
    """Incrementa cycles_since en todas las entradas. Llamado al inicio de cada ciclo."""
    return [{**e, "cycles_since": e.get("cycles_since", 0) + 1} for e in journal]


def get_journal(journal: list[dict], plugin_id: str | None = None) -> list[dict]:
    if plugin_id:
        return [e for e in journal if e.get("plugin_id") == plugin_id]
    return journal


def _ts_to_unix(ts: str) -> float:
    try:
        import datetime

        dt = datetime.datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return dt.timestamp()
    except Exception:
        return 0.0


# ── Entrypoint ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    data = json.loads(sys.stdin.read())
    fn = data.get("function", "")
    args = data.get("args", {})
    journal = args.get("journal", [])
    config = args.get("config", {})

    if fn == "journal_entry":
        updated, result = journal_entry(
            journal,
            args["plugin_id"],
            args.get("params_before", {}),
            args.get("params_after", {}),
            args.get("reason", ""),
            args.get("hypothesis", ""),
            args.get("cycle_id", ""),
            config,
        )
        out = {**result, "journal": updated}

    elif fn == "check_lock":
        out = check_lock(journal, args["plugin_id"], config)

    elif fn == "get_journal":
        out = {"journal": get_journal(journal, args.get("plugin_id"))}

    elif fn == "advance_cycle_counters":
        out = {"journal": advance_cycle_counters(journal)}

    else:
        out = {"error": f"Función desconocida: {fn}"}

    print(json.dumps(out))
