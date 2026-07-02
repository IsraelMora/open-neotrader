"""
on_activate — Consolidated Multi-Market Universe.

Reads config.markets (list of strings) and returns the de-duplicated union
of the selected curated symbol lists.

Supported markets: nasdaq100, crypto-defi, etf-thematic, forex-majors.
Unknown market keys are silently ignored.

Return contract (matches all existing universe_* plugins):
  {"ok": True, "universe": [...], "count": N, "message": "..."}
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# Allow importing curated.py from the scripts/ directory adjacent to hooks/
_SCRIPTS_DIR = Path(__file__).parent.parent / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

from curated import UNIVERSE_SNAPSHOT_DATE, get_universe  # noqa: E402  (dynamic path insert above)

DEFAULT_MARKETS = ["nasdaq100"]


def on_activate(ctx: dict) -> dict:
    config = ctx.get("config", {})
    markets: list[str] = config.get("markets", DEFAULT_MARKETS)

    symbols = get_universe(markets, config)

    active = [
        m for m in markets if m in ("nasdaq100", "crypto-defi", "etf-thematic", "forex-majors")
    ]
    markets_label = ", ".join(active) if active else ", ".join(markets)

    return {
        "ok": True,
        "universe": symbols,
        "count": len(symbols),
        "message": (
            f"Universe activado: {len(symbols)} símbolos"
            f" [{markets_label}]"
        ),
        # Present-day snapshot date — disclosed so historical backtests over
        # this list can flag survivorship bias (see curated.py).
        "as_of": UNIVERSE_SNAPSHOT_DATE,
    }


if __name__ == "__main__":
    ctx = json.load(sys.stdin)
    print(json.dumps(on_activate(ctx)))
