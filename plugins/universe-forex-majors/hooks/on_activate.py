"""
on_activate — Forex Majors Universe.
Devuelve los 7 pares principales (y cruces opcionales) con el formato configurado.
"""

from __future__ import annotations

import json
import sys

MAJORS = ["EUR/USD", "GBP/USD", "USD/JPY", "USD/CHF", "AUD/USD", "USD/CAD", "NZD/USD"]

CROSSES = [
    "EUR/GBP",
    "EUR/JPY",
    "EUR/CHF",
    "EUR/AUD",
    "EUR/CAD",
    "GBP/JPY",
    "GBP/CHF",
    "GBP/AUD",
    "GBP/CAD",
    "AUD/JPY",
    "AUD/CAD",
    "AUD/NZD",
    "CAD/JPY",
    "CHF/JPY",
]


def format_pair(pair: str, fmt: str) -> str:
    base, quote = pair.split("/")
    if fmt == "nodash":
        return base + quote
    elif fmt == "underscore":
        return f"{base}_{quote}"
    return pair  # "slash" es el default


def on_activate(ctx: dict) -> dict:
    config = ctx.get("config", {})
    include_crosses = config.get("include_crosses", False)
    fmt = config.get("quote_format", "slash")
    exclude_raw = config.get("exclude_pairs", "")

    exclude = {s.strip().upper() for s in exclude_raw.replace(",", " ").split() if s.strip()}

    pairs = list(MAJORS)
    if include_crosses:
        pairs += CROSSES

    formatted = [
        format_pair(p, fmt)
        for p in pairs
        if p.replace("/", "").upper() not in exclude and p.upper() not in exclude
    ]

    return {
        "ok": True,
        "universe": formatted,
        "count": len(formatted),
        "message": f"Forex Majors Universe: {len(formatted)} pares ({fmt} format)",
    }


if __name__ == "__main__":
    ctx = json.load(sys.stdin)
    print(json.dumps(on_activate(ctx)))
