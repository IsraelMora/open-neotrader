"""
on_cycle hook — Earnings Drift (PEAD).

Lee el calendario de earnings del contexto (o de una skill de calendario),
calcula sorpresas de EPS y emite señales PEAD para empresas con sorpresas significativas.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from pead import analyze_price_reaction, build_pead_signal, compute_earnings_surprise  # noqa: E402


def on_cycle(ctx: dict) -> dict:
    config: dict = ctx.get("config", {})
    provider_tools: dict = ctx.get("provider_tools", {})

    min_surprise = config.get("min_surprise_pct", 5.0)
    hold_days = config.get("hold_days", 30)
    use_gap = config.get("use_price_gap", True)

    # El contexto puede traer una lista de earnings recientes del LLM o de un calendario plugin
    # Formato: [{ symbol, eps_actual, eps_estimate, report_date }]
    earnings_events: list[dict] = ctx.get("earnings_events", [])

    signals = []
    logs = []
    get_ohlcv = provider_tools.get("get_ohlcv")

    if not earnings_events:
        logs.append(
            {
                "level": "debug",
                "msg": (
                    "PEAD: sin eventos de earnings en ctx."
                    " El LLM debe proporcionar 'earnings_events'"
                    " con eps_actual y eps_estimate."
                ),
            }
        )
        return {"signals": signals, "logs": logs}

    for event in earnings_events:
        symbol = event.get("symbol", "")
        if not symbol:
            continue

        eps_actual = event.get("eps_actual")
        eps_estimate = event.get("eps_estimate")

        if eps_actual is None or eps_estimate is None:
            logs.append(
                {"level": "debug", "msg": f"PEAD {symbol}: faltan eps_actual o eps_estimate"}
            )
            continue

        # Calcular sorpresa
        surprise = compute_earnings_surprise(
            symbol=symbol,
            eps_actual=float(eps_actual),
            eps_estimate=float(eps_estimate),
            min_surprise_pct=min_surprise,
            hold_days=hold_days,
        )

        if surprise.signal == "neutral":
            logs.append(
                {
                    "level": "debug",
                    "msg": (
                        f"PEAD {symbol}: sorpresa {surprise.surprise_pct:+.1f}%"
                        " — inline (neutral)"
                    ),
                }
            )
            continue

        # Obtener datos de precio para confirmar la reacción
        reaction = None
        current_price = 0.0
        if callable(get_ohlcv):
            try:
                bars = get_ohlcv(symbol=symbol, timeframe="1d", limit=25)
                if bars and len(bars) >= 2:
                    current_price = bars[-1]["close"]
                    volumes = [b["volume"] for b in bars[:-1]]
                    avg_vol = sum(volumes) / len(volumes) if volumes else 0

                    reaction = analyze_price_reaction(
                        symbol=symbol,
                        prev_close=bars[-2]["close"],
                        open_price=bars[-1]["open"],
                        volume_today=bars[-1]["volume"],
                        avg_volume_20d=avg_vol,
                        surprise_direction="positive" if surprise.signal == "long" else "negative",
                        use_gap=use_gap,
                    )
            except Exception as exc:
                logs.append(
                    {"level": "warning", "msg": f"PEAD {symbol}: error obteniendo precio — {exc}"}
                )

        sig = build_pead_signal(surprise, reaction, current_price)
        if sig:
            signals.append(sig)
            logs.append(
                {
                    "level": "info",
                    "msg": (
                        f"PEAD {symbol}: {surprise.surprise_tier}"
                        f" ({surprise.surprise_pct:+.1f}%) → {surprise.signal}"
                        f" conf={sig['confidence']:.0%} hold={hold_days}d"
                    ),
                }
            )
        else:
            logs.append(
                {
                    "level": "info",
                    "msg": (
                        f"PEAD {symbol}: sorpresa {surprise.surprise_pct:+.1f}%"
                        " — señal débil (reacción no confirma)"
                    ),
                }
            )

    logs.append(
        {
            "level": "info",
            "msg": f"PEAD: {len(earnings_events)} eventos analizados → {len(signals)} señales",
        }
    )
    return {"signals": signals, "logs": logs}


if __name__ == "__main__":
    ctx = json.load(sys.stdin)
    print(json.dumps(on_cycle(ctx)))
