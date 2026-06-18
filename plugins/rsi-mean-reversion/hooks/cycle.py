"""
Hook on_cycle para RSI Mean Reversion.
Se ejecuta en cada ciclo del agente para emitir señales de RSI.
"""

from __future__ import annotations

import os
import sys

# Añadir scripts/ al path para importar calcular_rsi
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from calcular_rsi import analyze


def on_cycle(ctx) -> dict:
    """
    ctx.config          — configuración guardada por el usuario
    ctx.emit_signal()   — emite una señal al bus de eventos de la plataforma
    ctx.log             — logger
    ctx.get_data()      — obtiene datos del provider activo (si está disponible)
    """
    cfg = ctx.config or {}
    period = int(cfg.get("rsi_period", 14))
    oversold = float(cfg.get("oversold_threshold", 30))
    overbought = float(cfg.get("overbought_threshold", 70))
    confirmation = int(cfg.get("confirmation_bars", 2))

    symbols = ctx.get_universe_symbols() if hasattr(ctx, "get_universe_symbols") else []
    if not symbols:
        ctx.log.info("RSI: sin símbolos en el universo activo")
        return {"ok": True, "signals": []}

    signals = []
    for symbol in symbols:
        try:
            ohlcv = ctx.get_ohlcv(symbol, timeframe="1Day", limit=period * 3 + 10)
            if not ohlcv or len(ohlcv) < period + 1:
                continue

            closes = [bar["close"] for bar in ohlcv]
            result = analyze(closes, period, oversold, overbought, confirmation)

            if result["signal"] != "neutral":
                signal_payload = {
                    "symbol": symbol,
                    "signal": result["signal"],
                    "rsi": round(result["last_rsi"] or 0, 2),
                    "bars_in_zone": result["bars_in_zone"],
                    "skill": "rsi-mean-reversion",
                }
                ctx.emit_signal("rsi_signal", signal_payload)
                signals.append(signal_payload)
                ctx.log.info(
                    f"RSI señal: {symbol} → {result['signal']} (RSI={result['last_rsi']:.1f})"
                )

        except Exception as e:
            ctx.log.warning(f"RSI: error procesando {symbol}: {e}")

    return {"ok": True, "signals": signals}
