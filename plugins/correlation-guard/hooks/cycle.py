"""
on_cycle hook — Correlation Guard.

Lee las posiciones abiertas y las señales pendientes,
calcula correlaciones y cancela las señales que superen el umbral.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from correlation import filter_signals_by_correlation  # noqa: E402


def on_cycle(ctx: dict) -> dict:
    pending_signals: list[dict] = ctx.get("pending_signals", [])
    portfolio: dict = ctx.get("portfolio", {})
    config: dict = ctx.get("config", {})
    provider_tools: dict = ctx.get("provider_tools", {})

    max_corr = config.get("max_correlation", 0.7)
    lookback = config.get("lookback_days", 60)

    open_positions = list(portfolio.keys())
    logs = []

    if not pending_signals:
        return {"signals": pending_signals, "logs": logs}

    # Recopilar precios para todos los activos relevantes
    all_symbols = list(
        set([s["symbol"] for s in pending_signals if s.get("action") == "long"] + open_positions)
    )

    price_series: dict[str, list[float]] = {}
    get_ohlcv = provider_tools.get("get_ohlcv")

    if callable(get_ohlcv):
        for symbol in all_symbols:
            try:
                bars = get_ohlcv(symbol=symbol, timeframe="1d", limit=lookback + 5)
                if bars and len(bars) >= 10:
                    price_series[symbol] = [b["close"] for b in bars]
            except Exception:
                pass

    if len(price_series) < 2:
        logs.append(
            {
                "level": "debug",
                "msg": "Correlation Guard: datos insuficientes para calcular correlaciones",
            }
        )
        return {"signals": pending_signals, "logs": logs}

    filtered, correlations = filter_signals_by_correlation(
        pending_signals=pending_signals,
        open_positions=open_positions,
        price_series=price_series,
        max_correlation=max_corr,
    )

    cancelled_count = sum(1 for s in filtered if s.get("action") == "cancelled")
    if cancelled_count:
        for corr in correlations:
            logs.append(
                {
                    "level": "warning",
                    "msg": (
                        f"Correlación alta: {corr.symbol_a} ↔ {corr.symbol_b}"
                        f" = {corr.correlation:.2f} (umbral {max_corr})"
                    ),
                }
            )
        logs.append(
            {"level": "info", "msg": f"Correlation Guard canceló {cancelled_count} señales"}
        )
    else:
        logs.append(
            {
                "level": "debug",
                "msg": f"Correlation Guard: ninguna señal cancelada (umbral {max_corr})",
            }
        )

    return {"signals": filtered, "logs": logs}


if __name__ == "__main__":
    ctx = json.load(sys.stdin)
    print(json.dumps(on_cycle(ctx)))
