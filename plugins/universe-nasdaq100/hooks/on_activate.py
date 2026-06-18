"""
on_activate — Nasdaq-100 Universe.
Devuelve la lista de símbolos del índice como universo activo.
"""

from __future__ import annotations

import json
import sys

# Composición del Nasdaq-100 (actualizado a junio 2026, por capitalización bursátil)
NASDAQ100 = [
    "AAPL",
    "MSFT",
    "NVDA",
    "AMZN",
    "META",
    "GOOGL",
    "GOOG",
    "TSLA",
    "AVGO",
    "COST",
    "NFLX",
    "TMUS",
    "AMD",
    "PEP",
    "LIN",
    "ADBE",
    "QCOM",
    "TXN",
    "INTU",
    "AMAT",
    "ISRG",
    "BKNG",
    "CSCO",
    "CMCSA",
    "HON",
    "VRTX",
    "ADP",
    "MU",
    "PANW",
    "LRCX",
    "SBUX",
    "KLAC",
    "MELI",
    "SNPS",
    "CDNS",
    "GILD",
    "MDLZ",
    "REGN",
    "ADI",
    "PYPL",
    "CTAS",
    "MAR",
    "ORLY",
    "FTNT",
    "ASML",
    "MNST",
    "CEG",
    "MRVL",
    "ROP",
    "PCAR",
    "ROST",
    "AZN",
    "CPRT",
    "TTD",
    "NXPI",
    "ODFL",
    "DXCM",
    "CHTR",
    "WDAY",
    "IDXX",
    "FAST",
    "GEHC",
    "EXC",
    "KDP",
    "CCEP",
    "VRSK",
    "BKR",
    "EA",
    "ZS",
    "XEL",
    "FANG",
    "TEAM",
    "ANSS",
    "ON",
    "CDW",
    "GFS",
    "DDOG",
    "BIIB",
    "SMCI",
    "PDD",
    "PAYX",
    "CRWD",
    "ILMN",
    "MDB",
    "MCHP",
    "DLTR",
    "WBD",
    "LCID",
    "RIVN",
    "ALGN",
    "SGEN",
    "ENPH",
    "ZM",
    "DOCU",
    "OKTA",
    "COUP",
    "MTCH",
    "LULU",
    "TSCO",
    "EBAY",
]


def on_activate(ctx: dict) -> dict:
    config = ctx.get("config", {})
    exclude_raw = config.get("exclude_symbols", "")
    subset_size = int(config.get("subset_size", 100))
    include_etf = config.get("include_etf", True)

    exclude = {s.strip().upper() for s in exclude_raw.split(",") if s.strip()}

    symbols = [s for s in NASDAQ100 if s not in exclude][:subset_size]

    if include_etf and "QQQ" not in symbols:
        symbols.insert(0, "QQQ")

    return {
        "ok": True,
        "universe": symbols,
        "count": len(symbols),
        "message": f"Nasdaq-100 Universe activado: {len(symbols)} símbolos",
    }


if __name__ == "__main__":
    ctx = json.load(sys.stdin)
    print(json.dumps(on_activate(ctx)))
