"""
on_cycle hook — Mean Reversion Z-Score.

Analiza cada símbolo del universo activo y emite señales cuando
el precio está estadísticamente alejado de su media (|Z| > umbral).
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from zscore import analyze  # noqa: E402


def on_cycle(ctx: dict) -> dict:
    universe: list[str] = ctx.get("universe", [])
    portfolio: dict = ctx.get("portfolio", {})
    config: dict = ctx.get("config", {})
    provider_tools: dict = ctx.get("provider_tools", {})

    lookback = config.get("lookback_days", 20)
    entry_z = config.get("entry_zscore", 2.0)
    exit_z = config.get("exit_zscore", 0.5)
    min_history = config.get("min_history_days", 30)
    symbols_override = config.get("symbols", "")

    # Determinar lista de símbolos
    if symbols_override:
        symbols = [s.strip() for s in symbols_override.split(",") if s.strip()]
    else:
        symbols = universe

    signals = []
    logs = []
    analyzed = 0
    get_ohlcv = provider_tools.get("get_ohlcv")

    if not callable(get_ohlcv):
        logs.append({"level": "warning", "msg": "Mean Reversion: sin provider activo"})
        return {"signals": signals, "logs": logs}

    if not symbols:
        logs.append({"level": "warning", "msg": "Mean Reversion: universo vacío"})
        return {"signals": signals, "logs": logs}

    for symbol in symbols:
        try:
            bars = get_ohlcv(symbol=symbol, timeframe="1d", limit=min_history + lookback + 5)
            if not bars or len(bars) < min_history:
                continue

            prices = [b["close"] for b in bars]
            current_signal = None
            if symbol in portfolio:
                current_signal = portfolio[symbol].get("direction", None)

            result = analyze(
                symbol=symbol,
                prices=prices,
                lookback=lookback,
                entry_zscore=entry_z,
                exit_zscore=exit_z,
                current_signal=current_signal,
            )
            analyzed += 1

            if result.signal in ("long", "short"):
                signals.append(
                    {
                        "type": "mean_reversion_signal",
                        "symbol": symbol,
                        "action": result.signal,
                        "z_score": result.z_score,
                        "price": result.price,
                        "mean": result.mean,
                        "std": result.std,
                        "confidence": result.confidence,
                        "lookback": result.lookback,
                    }
                )
                logs.append(
                    {
                        "level": "info",
                        "msg": f"{symbol} Z={result.z_score:+.2f} → {result.signal} "
                        f"(conf {result.confidence:.0%})",
                    }
                )
            elif result.signal in ("exit_long", "exit_short"):
                signals.append(
                    {
                        "type": "mean_reversion_exit",
                        "symbol": symbol,
                        "action": "exit",
                        "z_score": result.z_score,
                        "price": result.price,
                        "reason": f"Z-Score volvió a zona neutral ({result.z_score:+.2f})",
                        "confidence": 0.85,
                    }
                )
                logs.append(
                    {
                        "level": "info",
                        "msg": (
                        f"{symbol} Z={result.z_score:+.2f} → {result.signal}"
                        " (reversión completada)"
                    ),
                    }
                )

        except Exception as exc:
            logs.append({"level": "warning", "msg": f"{symbol}: {exc}"})

    logs.append(
        {
            "level": "info",
            "msg": f"Mean Reversion: {analyzed}/{len(symbols)} símbolos analizados | "
            f"{len(signals)} señales",
        }
    )

    return {"signals": signals, "logs": logs}


if __name__ == "__main__":
    ctx = json.load(sys.stdin)
    print(json.dumps(on_cycle(ctx)))
