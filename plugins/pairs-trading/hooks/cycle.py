"""
on_cycle hook — Pairs Trading.

Analiza pares de activos del universo activo, detecta cointegración
y emite señales de spread cuando el Z-Score supera el umbral.
"""

from __future__ import annotations

import itertools
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from pairs import analyze_pair, generate_signal  # noqa: E402


def on_cycle(ctx: dict) -> dict:
    universe: list[str] = ctx.get("universe", [])
    portfolio: dict = ctx.get("portfolio", {})
    config: dict = ctx.get("config", {})
    provider_tools: dict = ctx.get("provider_tools", {})

    lookback = config.get("lookback_days", 60)
    entry_z = config.get("entry_zscore", 2.0)
    exit_z = config.get("exit_zscore", 0.5)
    stop_z = config.get("stop_zscore", 3.5)
    max_pairs = config.get("max_pairs_active", 3)
    pairs_config = config.get("pairs", "")

    signals = []
    logs = []
    get_ohlcv = provider_tools.get("get_ohlcv")

    if not callable(get_ohlcv):
        logs.append({"level": "warning", "msg": "Pairs Trading: sin provider activo"})
        return {"signals": signals, "logs": logs}

    # Determinar pares a analizar
    if pairs_config:
        pairs_to_check = [tuple(p.strip().split(":")) for p in pairs_config.split(",") if ":" in p]
    elif len(universe) >= 2:
        # Limitar combinaciones para evitar explosión: max 10 símbolos del universo
        subset = universe[:10]
        pairs_to_check = list(itertools.combinations(subset, 2))
    else:
        logs.append(
            {"level": "warning", "msg": "Pairs Trading: universo insuficiente (mínimo 2 símbolos)"}
        )
        return {"signals": signals, "logs": logs}

    # Precargar precios
    price_cache: dict[str, list[float]] = {}
    for pair in pairs_to_check:
        for sym in pair:
            if sym not in price_cache:
                try:
                    bars = get_ohlcv(symbol=sym, timeframe="1d", limit=lookback + 20)
                    if bars and len(bars) >= lookback:
                        price_cache[sym] = [b["close"] for b in bars]
                except Exception as exc:
                    logs.append({"level": "warning", "msg": f"Pairs: {sym}: {exc}"})

    cointegrated_pairs = []
    active_pair_count = sum(1 for key in portfolio if key.startswith("pair_"))

    for sym_a, sym_b in pairs_to_check:
        if sym_a not in price_cache or sym_b not in price_cache:
            continue

        stats = analyze_pair(
            symbol_a=sym_a,
            symbol_b=sym_b,
            prices_a=price_cache[sym_a],
            prices_b=price_cache[sym_b],
            lookback=lookback,
        )

        if not stats.is_cointegrated:
            continue
        cointegrated_pairs.append(stats)

        # Verificar posición actual del par
        pair_key = f"pair_{sym_a}_{sym_b}"
        alt_key = f"pair_{sym_b}_{sym_a}"
        current_pos = portfolio.get(pair_key, portfolio.get(alt_key, {})).get("direction")

        sig = generate_signal(
            stats=stats,
            entry_z=entry_z,
            exit_z=exit_z,
            stop_z=stop_z,
            current_position=current_pos,
        )

        if sig is None:
            continue

        # Respetar límite de pares activos
        if sig.action in ("long_spread", "short_spread") and active_pair_count >= max_pairs:
            logs.append(
                {
                    "level": "debug",
                    "msg": (
                        f"Pairs: {sym_a}/{sym_b} señal descartada"
                        f" (max pares activos {max_pairs})"
                    ),
                }
            )
            continue

        signals.append(
            {
                "type": "pairs_signal",
                "pair": f"{sym_a}/{sym_b}",
                "action": sig.action,
                "leg_a": {"symbol": sym_a, "direction": sig.leg_a},
                "leg_b": {"symbol": sym_b, "direction": sig.leg_b},
                "beta": sig.beta,
                "z_score": sig.z_score,
                "confidence": sig.confidence,
                "reason": sig.reason,
            }
        )
        if sig.action in ("long_spread", "short_spread"):
            active_pair_count += 1
            logs.append({"level": "info", "msg": f"Pairs {sym_a}/{sym_b}: {sig.reason}"})
        else:
            logs.append({"level": "info", "msg": f"Pairs {sym_a}/{sym_b}: {sig.reason}"})

    logs.append(
        {
            "level": "info",
            "msg": (
                f"Pairs Trading: {len(cointegrated_pairs)} pares cointegrados"
                f" de {len(pairs_to_check)} analizados → {len(signals)} señales"
            ),
        }
    )
    return {"signals": signals, "logs": logs}


if __name__ == "__main__":
    ctx = json.load(sys.stdin)
    print(json.dumps(on_cycle(ctx)))
