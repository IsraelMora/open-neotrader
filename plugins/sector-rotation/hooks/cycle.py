"""
on_cycle hook — Sector Rotation.
Obtiene precios mensuales de los 11 ETFs SPDR y calcula el ranking de rotación.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from sector_rotation import SPDR_SECTORS, rank_sectors  # noqa: E402


def on_cycle(ctx: dict) -> dict:
    config: dict = ctx.get("config", {})
    portfolio: dict = ctx.get("portfolio", {})
    provider_tools: dict = ctx.get("provider_tools", {})

    top_n = config.get("top_sectors", 3)
    ma_period = config.get("ma_period_months", 10)
    momentum_period = config.get("momentum_period_months", 12)
    bars_needed = max(ma_period, momentum_period) + 3

    signals = []
    logs = []
    get_ohlcv = provider_tools.get("get_ohlcv")

    if not callable(get_ohlcv):
        logs.append({"level": "warning", "msg": "Sector Rotation: sin provider activo"})
        return {"signals": signals, "logs": logs}

    sector_data: dict[str, list[float]] = {}
    for symbol in SPDR_SECTORS:
        try:
            bars = get_ohlcv(symbol=symbol, timeframe="1mo", limit=bars_needed)
            if bars and len(bars) >= momentum_period + 1:
                sector_data[symbol] = [b["close"] for b in bars]
            else:
                logs.append({"level": "debug", "msg": f"{symbol}: datos insuficientes"})
        except Exception as exc:
            logs.append({"level": "warning", "msg": f"{symbol}: error — {exc}"})

    if len(sector_data) < 3:
        logs.append(
            {"level": "warning", "msg": f"Solo {len(sector_data)} sectores con datos. Mínimo 3."}
        )
        return {"signals": signals, "logs": logs}

    current_positions = set(portfolio.keys())
    results = rank_sectors(
        sector_data=sector_data,
        current_positions=current_positions,
        top_n=top_n,
        ma_period=ma_period,
        momentum_period=momentum_period,
    )

    for r in results:
        if r.signal in ("long", "exit"):
            signals.append(
                {
                    "type": "sector_rotation_signal",
                    "symbol": r.symbol,
                    "action": r.signal,
                    "sector_name": r.sector_name,
                    "rank": r.rank,
                    "momentum_12m": r.momentum_12m,
                    "above_ma": r.above_ma,
                    "weight_pct": r.weight_pct,
                    "confidence": 0.75 if r.signal == "long" else 0.90,
                }
            )

    top_sectors = [r.symbol for r in results if r.signal == "long"]
    logs.append(
        {
            "level": "info",
            "msg": (
                f"Sector Rotation | top {top_n}: {top_sectors}"
                f" | sectores con datos: {len(sector_data)}"
            ),
        }
    )

    return {"signals": signals, "logs": logs}


if __name__ == "__main__":
    ctx = json.load(sys.stdin)
    print(json.dumps(on_cycle(ctx)))
