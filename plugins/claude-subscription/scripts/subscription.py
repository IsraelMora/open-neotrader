"""
Claude Subscription (CLI)
=========================
Plugin de tipo `extra`. Su efecto real (cambiar el backend del LLM a la
suscripción de Claude) ocurre en la capa NestJS cuando el plugin está activo
(`isExtraActive('claude-subscription')`). Este script solo expone un reporte de
estado sandbox-safe: NO accede a la red ni invoca el CLI `claude`.
"""

from __future__ import annotations

import json
import sys
from typing import Any


def subscription_status(args: dict[str, Any]) -> dict[str, Any]:
    """Reporte informativo del backend de suscripción, sin tocar la red."""
    model = args.get("model") or "default"
    return {
        "backend": "claude-subscription",
        "model": model,
        "requires_api_key": False,
        "note": (
            "Backend de suscripción activo: la plataforma usa 'claude -p' con tu "
            "sesión de Claude Code. El modelo se elige en Configuración LLM."
        ),
    }


if __name__ == "__main__":
    data = json.loads(sys.stdin.read())
    fn = data.get("function", "subscription_status")
    payload = data.get("args", {})

    if fn == "subscription_status":
        out = subscription_status(payload)
    else:
        out = {"error": f"Función desconocida: {fn}"}

    print(json.dumps(out))
