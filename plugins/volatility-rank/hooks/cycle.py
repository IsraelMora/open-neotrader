"""
Volatility Rank — hook de ciclo.
Calcula HV Percentile para activos del universo y emite señales de régimen de volatilidad.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from hvrank import analyze_volatility_rank


def on_cycle(ctx):
    cfg = ctx.get("config", {})
    universe = ctx.get("universe", [])
    ohlcv = ctx.get("ohlcv", {})  # {symbol: [bars]}

    emit_high = cfg.get("emit_on_high", True)
    emit_low = cfg.get("emit_on_low", True)

    if not universe:
        return {"signals": [], "logs": ["Sin universo activo"]}

    signals = []
    logs = []

    for symbol in universe:
        bars = ohlcv.get(symbol)
        if not bars or len(bars) < 30:
            logs.append(f"{symbol}: datos insuficientes (mín 30 barras)")
            continue

        closes = [float(b["close"]) for b in bars if b.get("close", 0) > 0]

        result = analyze_volatility_rank(symbol, closes, cfg)
        if not result:
            logs.append(f"{symbol}: no se pudo calcular HV rank")
            continue

        logs.append(
            f"{symbol}: HV={result.current_hv:.1f}% "
            f"[{result.hv_1y_low:.1f}–{result.hv_1y_high:.1f}] "
            f"pct={result.hv_percentile:.0f}th → {result.vol_regime.upper()}"
        )

        if result.signal == "neutral":
            continue

        if result.signal == "sell_premium" and not emit_high:
            continue

        if result.signal == "buy_premium" and not emit_low:
            continue

        signals.append(
            {
                "plugin_id": "volatility-rank",
                "symbol": symbol,
                "action": "short" if result.signal == "sell_premium" else "long",
                "confidence": result.confidence,
                "signal_type": result.signal,
                "vol_regime": result.vol_regime,
                "hv_current": result.current_hv,
                "hv_percentile": result.hv_percentile,
                "hv_1y_range": [result.hv_1y_low, result.hv_1y_high],
                "hv_1y_mean": result.hv_1y_mean,
                "reason": (
                    f"HV al {result.hv_percentile:.0f}th percentil "
                    f"({result.current_hv:.1f}% vs media {result.hv_1y_mean:.1f}%) → "
                    f"{'premium selling' if result.signal == 'sell_premium' else 'premium buying'}"
                ),
            }
        )

    return {
        "signals": signals,
        "logs": logs,
    }
