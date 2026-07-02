"""
Hook on_cycle del Funding Rate Arbitrage.
Lee los datos de funding del contexto y emite señales de arbitraje.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from funding_arb import scan_funding_opportunities  # type: ignore[import]


def on_cycle(ctx: dict) -> dict:
    config = ctx.get("config", {})
    funding_data = ctx.get("funding_rates", [])  # [{symbol, funding_rate_8h, open_interest_usd}]

    if not funding_data:
        return {
            "signals": [],
            "logs": [
                {"level": "debug", "msg": "[funding-arb] Sin datos de funding en el contexto"}
            ],
        }

    result = scan_funding_opportunities(funding_data, config)

    # Emitir señales para oportunidades excelentes/buenas
    signals: list[dict] = []
    for opp in result.get("opportunities", []):
        if opp["signal"] == 1 and opp["quality"] in ("excellent", "good"):
            signals.append(
                {
                    "symbol": opp["symbol"],
                    "action": "arb_entry",
                    "strategy": "funding_rate_arb",
                    "direction": opp["direction"],
                    "funding_apr": opp["funding_apr"],
                    "quality": opp["quality"],
                    "reason": opp["reason"],
                }
            )

    logs = [{
        "level": "info",
        "msg": (
            f"[funding-arb] {result['opportunities_found']} oportunidades, "
            f"mejor APR: {result['best_apr']:.1%}"
        ),
    }]

    return {"signals": signals, "logs": logs}


if __name__ == "__main__":
    raw = sys.stdin.read()
    ctx = json.loads(raw)
    out = on_cycle(ctx)
    print(json.dumps(out))
