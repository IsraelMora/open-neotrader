"""
Hook on_cycle de Claude Subscription.
Anota en el contexto que el backend del LLM es la suscripción de Claude, para
que el resto del pipeline (y el propio LLM) lo tenga presente. No accede a la
red ni invoca el CLI: el cambio de backend real lo hace NestJS al detectar que
el plugin está activo.
"""

from __future__ import annotations

import json
import sys


def run(ctx: dict) -> dict:
    ctx["llm_backend"] = "claude-subscription"
    ctx.setdefault("log", []).append(
        "[claude-subscription] Backend del LLM: suscripción de Claude (claude -p)"
    )
    return ctx


if __name__ == "__main__":
    raw = sys.stdin.read()
    ctx = json.loads(raw)
    out = run(ctx)
    print(json.dumps(out))
