"""
Gap Opening Skill — hook de ciclo.
Detecta gaps de apertura en el universo activo y emite señales.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from gap import analyze_gap


def on_cycle(ctx):
    cfg = ctx.get("config", {})
    universe = ctx.get("universe", [])
    ohlcv = ctx.get("ohlcv", {})  # {symbol: [bars]}

    if not universe:
        return {"signals": [], "logs": ["Sin universo activo"]}

    signals = []
    logs = []

    for symbol in universe:
        bars = ohlcv.get(symbol)
        if not bars or len(bars) < 3:
            logs.append(f"{symbol}: sin datos suficientes (min 3 barras)")
            continue

        analysis = analyze_gap(symbol, bars, cfg)
        if not analysis:
            continue

        if analysis.strategy == "none" or analysis.direction == "none":
            if abs(analysis.gap_pct) >= cfg.get("gap_threshold_pct", 0.5):
                logs.append(f"{symbol}: gap {analysis.gap_pct:+.2f}% → {analysis.reason}")
            continue

        logs.append(
            f"{symbol}: {analysis.gap_type} {analysis.gap_pct:+.2f}% "
            f"→ {analysis.strategy.upper()} {analysis.direction.upper()} "
            f"(conf={analysis.confidence:.2f})"
        )

        signals.append(
            {
                "plugin_id": "gap-opening-skill",
                "symbol": symbol,
                "action": analysis.direction,
                "confidence": analysis.confidence,
                "signal_type": f"gap_{analysis.strategy}",
                "gap_pct": analysis.gap_pct,
                "gap_type": analysis.gap_type,
                "volume_confirmed": analysis.volume_confirmed,
                "trend": analysis.trend,
                "prev_close": analysis.prev_close,
                "open_price": analysis.open_price,
                "reason": analysis.reason,
                "metadata": {
                    "strategy": analysis.strategy,
                    "intraday": True,  # señal de operación intraday
                },
            }
        )

    return {
        "signals": signals,
        "logs": logs,
    }
