"""
on_activate hook — Alpaca Provider.

Se ejecuta en el sandbox (sin red) cuando el plugin se activa.
Solo valida que las credenciales están disponibles en el contexto.
La verificación real de conectividad la hace el servicio NestJS.
"""

from __future__ import annotations

import json
import sys


def on_activate(ctx: dict) -> dict:
    credentials = ctx.get("credentials", {})
    missing = []
    for key in ("ALPACA_API_KEY_ID", "ALPACA_API_SECRET_KEY"):
        if not credentials.get(key):
            missing.append(key)

    if missing:
        return {
            "ok": False,
            "error": (
                f"Credenciales faltantes: {', '.join(missing)}. "
                "Configúralas en Settings → Plugins → Alpaca Provider."
            ),
        }

    return {
        "ok": True,
        "message": (
            "Alpaca Provider activado. "
            "Verificación de conectividad pendiente (requiere red)."
        ),
    }


if __name__ == "__main__":
    ctx = json.load(sys.stdin)
    print(json.dumps(on_activate(ctx)))
