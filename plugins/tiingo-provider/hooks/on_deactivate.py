"""on_deactivate — Tiingo Provider."""

from __future__ import annotations

import json
import sys


def on_deactivate(ctx: dict) -> dict:
    return {"ok": True, "message": "Tiingo Provider desactivado."}


if __name__ == "__main__":
    ctx = json.load(sys.stdin)
    print(json.dumps(on_deactivate(ctx)))
