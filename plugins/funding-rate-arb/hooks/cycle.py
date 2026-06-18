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


def run(ctx: dict) -> dict:
    config = ctx.get("plugin_config", {})
    funding_data = ctx.get("funding_rates", [])  # [{symbol, funding_rate_8h, open_interest_usd}]

    if not funding_data:
        ctx.setdefault("log", []).append("[funding-arb] Sin datos de funding en el contexto")
        return ctx

    result = scan_funding_opportunities(funding_data, config)
    ctx["funding_arb_scan"] = result

    # Emitir señales para oportunidades excelentes/buenas
    pending: list[dict] = ctx.get("pending_signals", [])
    for opp in result.get("opportunities", []):
        if opp["signal"] == 1 and opp["quality"] in ("excellent", "good"):
            pending.append(
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

    ctx["pending_signals"] = pending
    ctx.setdefault("log", []).append(
        f"[funding-arb] {result['opportunities_found']} oportunidades, "
        f"mejor APR: {result['best_apr']:.1%}"
    )

    return ctx


if __name__ == "__main__":
    raw = sys.stdin.read()
    ctx = json.loads(raw)
    out = run(ctx)
    print(json.dumps(out))
