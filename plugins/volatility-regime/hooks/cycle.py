"""
on_cycle hook — Volatility Regime Detection.

Obtiene datos del índice de referencia (SPY o equivalente),
detecta el régimen de volatilidad y emite una señal de régimen
que otros plugins pueden usar para adaptar su comportamiento.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from regime import detect_regime  # noqa: E402


def on_cycle(ctx: dict) -> dict:
    config: dict = ctx.get("config", {})
    provider_tools: dict = ctx.get("provider_tools", {})

    index_symbol = config.get("index_symbol", "SPY")
    vix_symbol = config.get("vix_symbol", "^VIX")
    lookback_days = config.get("vol_lookback_days", 252)
    bars_needed = lookback_days + 30

    signals = []
    logs = []
    get_ohlcv = provider_tools.get("get_ohlcv")

    index_closes: list[float] = []
    vix_value: float | None = None

    if callable(get_ohlcv):
        try:
            bars = get_ohlcv(symbol=index_symbol, timeframe="1d", limit=bars_needed)
            if bars:
                index_closes = [b["close"] for b in bars]
        except Exception as exc:
            logs.append({"level": "warning", "msg": f"Error obteniendo {index_symbol}: {exc}"})

        try:
            vix_bars = get_ohlcv(symbol=vix_symbol, timeframe="1d", limit=5)
            if vix_bars:
                vix_value = vix_bars[-1]["close"]
        except Exception:
            logs.append(
                {"level": "debug", "msg": "VIX no disponible, usando solo volatilidad realizada"}
            )
    else:
        logs.append(
            {"level": "warning", "msg": "Sin provider activo. Régimen no puede determinarse."}
        )
        return {"signals": signals, "logs": logs}

    if not index_closes:
        logs.append({"level": "warning", "msg": f"Sin datos del índice {index_symbol}"})
        return {"signals": signals, "logs": logs}

    result = detect_regime(
        index_closes=index_closes,
        vix_value=vix_value,
        vix_low=config.get("vix_low_threshold", 15.0),
        vix_high=config.get("vix_high_threshold", 25.0),
        vix_crisis=config.get("vix_crisis_threshold", 40.0),
        lookback_days=lookback_days,
    )

    # Emitir señal de régimen (otros plugins la leerán del contexto)
    signals.append(
        {
            "type": "volatility_regime",
            "symbol": index_symbol,
            "action": "info",  # no implica trade
            "regime": result.regime,
            "vix": result.vix,
            "rv_21d": result.rv_21d,
            "rv_percentile": result.rv_percentile,
            "size_multiplier": result.size_multiplier,
            "preferred_strategies": result.preferred_strategies,
            "avoid_strategies": result.avoid_strategies,
            "market_trend_up": result.market_trend_up,
            "description": result.description,
        }
    )

    level = (
        "critical"
        if result.regime == "crisis"
        else ("warning" if result.regime == "high" else "info")
    )
    logs.append({"level": level, "msg": result.description})

    return {"signals": signals, "logs": logs}


if __name__ == "__main__":
    ctx = json.load(sys.stdin)
    print(json.dumps(on_cycle(ctx)))
