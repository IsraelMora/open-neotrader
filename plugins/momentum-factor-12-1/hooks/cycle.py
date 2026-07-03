"""
on_cycle hook — Momentum Factor 12-1.

Recibe el contexto del ciclo, obtiene precios mensuales de cada símbolo
del universo activo, calcula rankings de momentum 12-1 y emite señales.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from momentum import apply_trend_filter, compute_momentum_ranks  # noqa: E402


def on_cycle(ctx: dict) -> dict:
    """
    Args:
        ctx: CycleContext del SDK de NeuroTrader
             ctx["universe"]  → lista de símbolos activos
             ctx["provider"]  → funciones del proveedor activo (dict de tools)
             ctx["config"]    → config del plugin (top_pct, lookback_months)
             ctx["portfolio"] → posiciones actuales { symbol: cantidad }

    Returns:
        { signals: [...], logs: [...] }
    """
    universe: list[str] = ctx.get("universe", [])
    config: dict = ctx.get("config", {})
    portfolio: dict = ctx.get("portfolio", {})

    top_pct = config.get("top_pct", 20) / 100.0
    lookback_months = config.get("lookback_months", 12)
    market_trend_up: bool = ctx.get("market_trend_up", True)

    signals = []
    logs = []

    if len(universe) < 5:
        logs.append(
            {
                "level": "warning",
                "msg": (
                    f"Universo muy pequeño ({len(universe)} símbolos). "
                    "Momentum necesita ≥5 activos."
                ),
            }
        )
        return {"signals": signals, "logs": logs}

    # Recopilar precios mensuales por símbolo
    # En producción el provider inyecta get_ohlcv; aquí preparamos la llamada
    universe_data: dict[str, list[float]] = {}
    provider_tools = ctx.get("provider_tools", {})
    get_ohlcv = provider_tools.get("get_ohlcv")

    for symbol in universe:
        if callable(get_ohlcv):
            try:
                bars = get_ohlcv(symbol=symbol, timeframe="1Month", limit=lookback_months + 2)
                if bars and len(bars) >= lookback_months + 2:
                    closes = [b["close"] for b in bars]
                    universe_data[symbol] = closes
                else:
                    logs.append(
                        {
                            "level": "warning",
                            "msg": f"{symbol}: datos insuficientes ({len(bars or [])} barras)",
                        }
                    )
            except Exception as exc:
                logs.append({"level": "error", "msg": f"{symbol}: error obteniendo OHLCV — {exc}"})
        else:
            # Modo simulación/test: sin provider real
            logs.append(
                {
                    "level": "debug",
                    "msg": f"{symbol}: provider no disponible, usando precio simulado",
                }
            )

    if not universe_data:
        logs.append(
            {
                "level": "warning",
                "msg": (
                    "No se obtuvieron precios. "
                    "Verifica que hay un provider activo con get_ohlcv."
                ),
            }
        )
        return {"signals": signals, "logs": logs}

    current_positions = set(portfolio.keys())
    ranks = compute_momentum_ranks(
        universe_data, top_pct, lookback_months, current_positions=current_positions
    )
    ranks = apply_trend_filter(ranks, market_trend_up)

    for r in ranks:
        if r.signal in ("long", "exit"):
            signals.append(
                {
                    "type": "momentum_signal",
                    "symbol": r.symbol,
                    "action": r.signal,
                    "rank": r.rank,
                    "return_12_1": r.return_12_1,
                    "percentile": r.percentile,
                    "volatility_12m": r.volatility_12m,
                    "vol_adjusted_score": r.vol_adjusted_score,
                    "confidence": r.percentile,
                }
            )

    long_count = sum(1 for s in signals if s["action"] == "long")
    exit_count = sum(1 for s in signals if s["action"] == "exit")
    logs.append(
        {
            "level": "info",
            "msg": (
                f"Momentum 12-1 | universo={len(universe_data)} | "
                f"long={long_count} | exit={exit_count} | "
                f"trend={'up' if market_trend_up else 'DOWN (filtro activo)'}"
            ),
        }
    )

    return {"signals": signals, "logs": logs}


if __name__ == "__main__":
    ctx = json.load(sys.stdin)
    result = on_cycle(ctx)
    print(json.dumps(result))
