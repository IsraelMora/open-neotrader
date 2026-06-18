"""
on_cycle — Wyckoff Volume Analysis

Lee OHLCV del contexto y detecta fases de acumulación/distribución.
Solo emite señales cuando hay un Spring, Upthrust o SOS/SOW con alta confianza.
"""

import json
import sys


def main():
    raw = sys.stdin.read().strip()
    ctx: dict = json.loads(raw) if raw else {}
    config: dict = ctx.get("__plugin_config__", {})

    # Espera ohlcv_history: dict[symbol, {"highs": [...], "lows": [...],
    #                                      "closes": [...], "volumes": [...]}]
    ohlcv: dict = ctx.get("ohlcv_history", {})
    # Alternativa: price_history + volume_history
    price_history: dict = ctx.get("price_history", {})
    volume_history: dict = ctx.get("volume_history", {})
    pending: list = list(ctx.get("pending_signals", []))
    phase_confidence = float(config.get("phase_confidence", 0.6))

    from wyckoff import analyze

    symbols = set(ohlcv.keys()) | set(price_history.keys())
    for symbol in symbols:
        try:
            if symbol in ohlcv:
                data = ohlcv[symbol]
                highs = data.get("highs", data.get("high", []))
                lows = data.get("lows", data.get("low", []))
                closes = data.get("closes", data.get("close", []))
                volumes = data.get("volumes", data.get("volume", []))
            else:
                closes = price_history.get(symbol, [])
                volumes = volume_history.get(symbol, [])
                # Sin OHLC usar close como proxy de high/low
                highs = closes
                lows = closes

            if len(closes) < 20:
                continue

            result = analyze(
                highs=list(highs),
                lows=list(lows),
                closes=list(closes),
                volumes=list(volumes) if volumes else [1.0] * len(closes),
                config=config,
            )

            if result.signal in ("buy", "sell") and result.confidence >= phase_confidence:
                pending.append(
                    {
                        "source": "wyckoff-volume",
                        "symbol": symbol,
                        "action": result.signal,
                        "confidence": result.confidence,
                        "phase": f"{result.phase} Phase {result.sub_phase}",
                        "trend_bias": result.trend_bias,
                        "spring": result.spring_detected,
                        "upthrust": result.upthrust_detected,
                        "support": result.support,
                        "resistance": result.resistance,
                        "reason": (
                            "Spring detectado — falsa ruptura soporte → acumulación"
                            if result.spring_detected
                            else "Upthrust detectado — falsa ruptura resistencia → distribución"
                            if result.upthrust_detected
                            else f"Wyckoff {result.phase} {result.sub_phase} — {result.trend_bias}"
                        ),
                    }
                )
        except Exception:
            pass  # No interrumpir el ciclo si un símbolo falla

    ctx["pending_signals"] = pending
    print(json.dumps(ctx))


if __name__ == "__main__":
    main()
