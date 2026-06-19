"""
Hook on_cycle del Doctor.
Ejecuta diagnósticos al inicio del ciclo e inyecta
el resumen en el contexto para que el LLM lo tenga en cuenta.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from doctor import run_diagnostics  # type: ignore[import]


class _HookContext:
    """Minimal context object compatible with _SdkContext expected by inner scripts."""

    def __init__(self, metadata: dict) -> None:
        self.metadata = metadata


def on_cycle(ctx: dict) -> dict:
    config = ctx.get("plugin_config", {})
    active_ids = ctx.get("active_plugin_ids", [])
    required_creds: list[str] = []

    # Recopilar credenciales requeridas de los plugins activos (pasadas por la plataforma)
    for cred in ctx.get("required_credentials", []):
        required_creds.append(str(cred))

    result = run_diagnostics(
        {
            "active_plugin_ids": active_ids,
            "required_credentials": required_creds,
            "context": ctx,
        },
        _context=_HookContext(metadata=ctx),
    )

    ctx["doctor_report"] = result

    if not result["ok"]:
        ctx.setdefault("log", []).append(
            f"[doctor] ADVERTENCIAS ({result['summary']['failed']} checks fallidos): "
            + "; ".join(result["errors"])
        )
        # Si hay fallo crítico y la config lo requiere, señalizar al ciclo
        if config.get("fail_on_missing_credentials") and any(
            "Credenciales faltantes" in e for e in result["errors"]
        ):
            ctx["cycle_abort"] = True
            ctx["cycle_abort_reason"] = "Credenciales requeridas faltantes (doctor check)"
    else:
        ctx.setdefault("log", []).append(
            f"[doctor] Sistema OK — "
            f"{result['summary']['passed']}/{result['summary']['total']} checks"
        )

    return ctx


if __name__ == "__main__":
    raw = sys.stdin.read()
    ctx = json.loads(raw)
    out = on_cycle(ctx)
    print(json.dumps(out))
