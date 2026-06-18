"""
on_activate — Crypto DeFi Top 20.
"""

from __future__ import annotations

import json
import sys

# Top 20 DeFi por capitalización bursátil (junio 2026, excluyendo BTC y ETH)
DEFI_TOP20_BASE = [
    "UNI",  # Uniswap — DEX
    "LINK",  # Chainlink — Oracle
    "AAVE",  # Aave — Lending
    "MKR",  # Maker — CDP/Stablecoin
    "CRV",  # Curve — Stablecoin DEX
    "COMP",  # Compound — Lending
    "SNX",  # Synthetix — Derivados sintéticos
    "BAL",  # Balancer — AMM weighted pools
    "YFI",  # Yearn Finance — Yield aggregator
    "SUSHI",  # SushiSwap — DEX
    "1INCH",  # 1inch — DEX aggregator
    "LDO",  # Lido — Liquid staking
    "RPL",  # Rocket Pool — ETH staking
    "CVX",  # Convex Finance — Curve booster
    "FXS",  # Frax — Stablecoin
    "GMX",  # GMX — Perpetual DEX
    "DYDX",  # dYdX — Perps CEX/DEX
    "INJ",  # Injective — Derivatives chain
    "PENDLE",  # Pendle — Yield trading
    "ENA",  # Ethena — Synthetic dollar
]


def on_activate(ctx: dict) -> dict:
    config = ctx.get("config", {})
    include_eth = config.get("include_eth", False)
    fmt = config.get("format", "binance")
    quote = config.get("quote_asset", "USDT")
    exclude_raw = config.get("exclude_tokens", "")

    exclude = {t.strip().upper() for t in exclude_raw.split(",") if t.strip()}
    tokens = [t for t in DEFI_TOP20_BASE if t not in exclude]

    if include_eth:
        tokens.insert(0, "ETH")

    if fmt == "binance":
        symbols = [f"{t}{quote}" for t in tokens]
    elif fmt == "slash":
        symbols = [f"{t}/{quote}" for t in tokens]
    else:
        symbols = tokens

    return {
        "ok": True,
        "universe": symbols,
        "count": len(symbols),
        "message": f"Crypto DeFi Top 20: {len(symbols)} tokens ({fmt} format)",
    }


if __name__ == "__main__":
    ctx = json.load(sys.stdin)
    print(json.dumps(on_activate(ctx)))
