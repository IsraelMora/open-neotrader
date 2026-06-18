"""
on_cycle — KAMA Adaptive Moving Average

Lee price_history del contexto y emite pending_signals basadas en cruces KAMA/precio.
Solo genera señales en régimen tendencial (ER > 0.6).
"""

import json
import sys


def main():
    raw = sys.stdin.read().strip()
    ctx: dict = json.loads(raw) if raw else {}
    config: dict = ctx.get("__plugin_config__", {})

    price_history: dict = ctx.get("price_history", {})
    prices_now: dict = ctx.get("prices", {})
    pending: list = list(ctx.get("pending_signals", []))

    if not price_history:
        print(json.dumps(ctx))
        return

    from kama import analyze_symbol

    for symbol, hist in price_history.items():
        if not hist or len(hist) < 20:
            continue
        # Añadir precio actual al final si está disponible
        full_series = list(hist)
        if symbol in prices_now:
            full_series.append(prices_now[symbol])

        result = analyze_symbol(symbol, full_series, config)
        if result.get("signal") in ("buy", "sell"):
            pending.append(
                {
                    "source": "kama-adaptive",
                    "symbol": symbol,
                    "action": result["signal"],
                    "confidence": result["confidence"],
                    "price": result["price"],
                    "er": result["er"],
                    "regime": result["regime"],
                    "kama": result["kama"],
                    "pct_from_kama": result["pct_from_kama"],
                    "reason": (
                        f"KAMA cruce {result['signal']}"
                        f" | ER={result['er']:.3f} | {result['regime']}"
                    ),
                }
            )

    ctx["pending_signals"] = pending
    print(json.dumps(ctx))


if __name__ == "__main__":
    main()
