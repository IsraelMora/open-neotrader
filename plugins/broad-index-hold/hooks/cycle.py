"""
on_cycle hook — Broad Index Hold.

Deliberately trivial: emits a single "long" signal per symbol in
config["symbols"] (default ["SPY"]) the first cycle that symbol is not
already held, and nothing else — no ranking, no periodic rebalance, no exits.

This is the base "book" for the vol-managed-exposure strategy (batch-6
research: vol-managed SPY reaches Sharpe 0.96 vs SPY buy-hold's 0.78, see
plugins/risk-manager's exposure_mode="vol_target"). The actual exposure
discipline lives entirely in risk-manager's exposure_scalar output; this
plugin's only job is to keep the configured symbol(s) held so the pipeline
has a position whose size the vol-target scalar can scale.

Security contract: NO network calls here (all data, if ever needed, would
come through provider_tools.get_ohlcv — this hook does not currently need
market data at all, only ctx["portfolio"] to avoid re-signaling).
"""

from __future__ import annotations

import json
import sys


def on_cycle(ctx: dict) -> dict:
    portfolio: dict = ctx.get("portfolio", {}) or {}
    config: dict = ctx.get("config", {}) or {}

    raw_symbols = config.get("symbols") or ["SPY"]
    if isinstance(raw_symbols, str):
        symbols = [s.strip().upper() for s in raw_symbols.split(",") if s.strip()]
    elif isinstance(raw_symbols, list):
        symbols = [str(s).strip().upper() for s in raw_symbols if str(s).strip()]
    else:
        symbols = []
    if not symbols:
        symbols = ["SPY"]

    signals: list[dict] = []
    for symbol in symbols:
        if not symbol or symbol in portfolio:
            continue
        signals.append({
            "type": "broad_index_hold_signal",
            "symbol": symbol,
            "action": "long",
            "reason": "broad-index-hold: unconditional buy-and-hold, no ranking",
        })

    logs = [{
        "level": "info",
        "msg": f"broad-index-hold | symbols={symbols} | new_signals={len(signals)}",
    }]

    return {"signals": signals, "logs": logs}


if __name__ == "__main__":
    ctx = json.load(sys.stdin)
    result = on_cycle(ctx)
    print(json.dumps(result))
