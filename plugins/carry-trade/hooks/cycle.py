"""
on_cycle hook — Carry Trade.

Analiza los pares configurados, calcula el diferencial de carry,
aplica filtro de momentum y risk-off, y emite señales de carry.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from carry import apply_momentum_filter, compute_carry  # noqa: E402


def on_cycle(ctx: dict) -> dict:
    config: dict = ctx.get("config", {})
    portfolio: dict = ctx.get("portfolio", {})
    provider_tools: dict = ctx.get("provider_tools", {})
    market_data: dict = ctx.get("market_data", {})

    pairs_str = config.get("pairs", "AUD/JPY,NZD/JPY,AUD/USD,NZD/USD")
    min_carry = config.get("min_carry_pct", 2.0)
    use_momentum = config.get("use_momentum_filter", True)
    risk_off_exit = config.get("risk_off_exit", True)
    vix_threshold = config.get("vix_threshold", 25.0)

    pairs = [p.strip() for p in pairs_str.split(",") if p.strip()]

    signals = []
    logs = []
    get_ohlcv = provider_tools.get("get_ohlcv")

    # Comprobar VIX para modo risk-off
    vix_level = float(market_data.get("vix", 0.0))
    is_risk_off = risk_off_exit and vix_level > vix_threshold
    if is_risk_off:
        logs.append(
            {
                "level": "warning",
                "msg": (
                    f"Carry Trade: VIX={vix_level:.1f} > {vix_threshold}"
                    " → modo RISK-OFF, sin nuevas entradas"
                ),
            }
        )

    # Las tasas de interés pueden venir del contexto (actualizadas por el LLM)
    rates_override: dict[str, float] | None = ctx.get("interest_rates")

    for pair in pairs:
        result = compute_carry(pair, rates_override, min_carry)

        if result.signal == "neutral":
            logs.append(
                {"level": "debug", "msg": f"Carry {pair}: {result.carry_pct:+.2f}% — insuficiente"}
            )
            continue

        # Verificar si hay posición abierta
        pair_key = pair.replace("/", "")
        in_position = pair_key in portfolio or pair in portfolio
        current_pos_dir = portfolio.get(pair_key, portfolio.get(pair, {})).get("direction")

        # Salir si risk-off y hay posición de carry
        if is_risk_off and in_position:
            signals.append(
                {
                    "type": "carry_signal",
                    "symbol": pair,
                    "action": "exit",
                    "reason": f"VIX={vix_level:.1f} > {vix_threshold} — salida preventiva risk-off",
                    "confidence": 0.90,
                }
            )
            logs.append(
                {
                    "level": "warning",
                    "msg": f"Carry {pair}: salida por risk-off (VIX={vix_level:.1f})",
                }
            )
            continue

        # Sin entradas nuevas en risk-off
        if is_risk_off and not in_position:
            continue

        # Aplicar filtro de momentum
        if use_momentum and callable(get_ohlcv):
            try:
                bars = get_ohlcv(symbol=pair, timeframe="1d", limit=210)
                if bars and len(bars) >= 200:
                    prices = [b["close"] for b in bars]
                    result = apply_momentum_filter(result, prices)
            except Exception:
                pass  # sin datos de precio → conservar señal carry pura

        if result.signal == "neutral":
            logs.append(
                {
                    "level": "info",
                    "msg": (
                    f"Carry {pair}: {result.carry_pct:+.2f}% carry filtrado"
                    " por momentum (precio bajo MA200)"
                ),
                }
            )
            continue

        # No duplicar si ya en posición en la misma dirección
        if in_position and current_pos_dir == result.signal:
            logs.append({"level": "debug", "msg": f"Carry {pair}: ya en posición {result.signal}"})
            continue

        signals.append(
            {
                "type": "carry_signal",
                "symbol": pair,
                "action": result.signal,
                "carry_pct": result.carry_pct,
                "base_rate": result.base_rate,
                "quote_rate": result.quote_rate,
                "annual_carry_pct": result.annual_carry_pct,
                "confidence": result.confidence,
            }
        )
        logs.append(
            {
                "level": "info",
                "msg": (
                    f"Carry {pair}: {result.signal} | carry={result.carry_pct:+.2f}% | "
                    f"{result.base_currency}={result.base_rate:.2f}%"
                    f" - {result.quote_currency}={result.quote_rate:.2f}%"
                ),
            }
        )

    logs.append(
        {
            "level": "info",
            "msg": f"Carry Trade: {len(pairs)} pares analizados → {len(signals)} señales",
        }
    )
    return {"signals": signals, "logs": logs}


if __name__ == "__main__":
    ctx = json.load(sys.stdin)
    print(json.dumps(on_cycle(ctx)))
