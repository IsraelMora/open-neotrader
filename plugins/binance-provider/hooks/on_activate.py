"""on_activate — Binance Provider. Valida credenciales en sandbox (sin red)."""

from __future__ import annotations

import json
import sys


def on_activate(ctx: dict) -> dict:
    credentials = ctx.get("credentials", {})
    config = ctx.get("config", {})
    missing = [k for k in ("BINANCE_API_KEY", "BINANCE_API_SECRET") if not credentials.get(k)]
    if missing:
        return {
            "ok": False,
            "error": (
                f"Credenciales faltantes: {', '.join(missing)}. "
                "Configúralas en Settings → Credentials."
            ),
        }
    testnet = config.get("testnet", True)
    mode = "TESTNET" if testnet else "MAINNET"
    return {
        "ok": True,
        "message": (
            f"Binance Provider activado en modo {mode}. "
            "Test de conexión via /providers/binance-provider/test"
        ),
    }


if __name__ == "__main__":
    ctx = json.load(sys.stdin)
    print(json.dumps(on_activate(ctx)))
