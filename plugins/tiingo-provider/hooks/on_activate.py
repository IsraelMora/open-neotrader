"""on_activate — Tiingo Provider. Valida credenciales en sandbox (sin red)."""

from __future__ import annotations

import json
import sys


def on_activate(ctx: dict) -> dict:
    credentials = ctx.get("credentials", {})
    if not credentials.get("TIINGO_API_TOKEN"):
        return {
            "ok": False,
            "error": "TIINGO_API_TOKEN no configurado. Añádelo en Settings → Credentials.",
        }
    return {
        "ok": True,
        "message": "Tiingo Provider activado. Test de conexión via /providers/tiingo-provider/test",
    }


if __name__ == "__main__":
    ctx = json.load(sys.stdin)
    print(json.dumps(on_activate(ctx)))
