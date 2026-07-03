"""Hook de ciclo RS — ranking de fuerza relativa vs benchmark en todo el universo."""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from rs import analyze_relative_strength, compute_composite_rs


def _closes(ohlcv: dict, symbol: str) -> list[float]:
    """Extracts closing prices, oldest→newest, from ctx["ohlcv"][symbol].

    ctx["ohlcv"][symbol] is a LIST of bar dicts ({open,high,low,close,volume,date}),
    not a dict with a "closes" key — mirrors how momentum-factor-12-1 and
    trend-following read bars. Missing/empty/malformed symbol data safely yields [].
    """
    bars = ohlcv.get(symbol, [])
    if not isinstance(bars, list):
        return []
    closes: list[float] = []
    for bar in bars:
        if isinstance(bar, dict) and "close" in bar and bar["close"] is not None:
            closes.append(bar["close"])
    return closes


def on_cycle(ctx: dict) -> dict:
    config = ctx.get("config", {})
    universe = ctx.get("universe", [])
    ohlcv = ctx.get("ohlcv", {})

    periods = config.get("periods", [63, 126, 189, 252])
    weights = config.get("weights", [0.4, 0.2, 0.2, 0.2])
    benchmark = config.get("benchmark", "SPY")
    rs_threshold = float(config.get("rs_threshold", 1.05))
    top_percentile = float(config.get("top_percentile", 80.0))

    benchmark_prices = _closes(ohlcv, benchmark)

    if not benchmark_prices:
        return {"signals": [], "meta": {"error": f"benchmark {benchmark} sin datos OHLCV"}}

    # Fase 1: calcular RS compuesto de todo el universo (para ranking)
    universe_rs: list[float] = []
    symbol_rs: dict[str, float] = {}

    for symbol in universe:
        if symbol == benchmark:
            continue
        prices = _closes(ohlcv, symbol)
        result = compute_composite_rs(prices, benchmark_prices, periods, weights)
        if result:
            composite = result["composite_rs"]
            universe_rs.append(composite)
            symbol_rs[symbol] = composite

    signals = []
    skipped = []

    # Fase 2: señales con percentil calculado sobre todo el universo
    for symbol in universe:
        if symbol == benchmark:
            continue
        prices = _closes(ohlcv, symbol)

        if not prices:
            skipped.append(symbol)
            continue

        result = analyze_relative_strength(
            symbol=symbol,
            prices=prices,
            benchmark_prices=benchmark_prices,
            universe_rs_values=[v for k, v in symbol_rs.items() if k != symbol],
            periods=periods,
            weights=weights,
            rs_threshold=rs_threshold,
            top_percentile=top_percentile,
        )

        if result is None or result.action == "hold":
            continue

        signals.append(
            {
                "symbol": symbol,
                "action": result.action,
                "strength": result.signal_strength,
                "plugin": "relative-strength",
                "reason": result.reason,
                "meta": {
                    "composite_rs": result.composite_rs,
                    "percentile_rank": result.percentile_rank,
                    "rs_scores": result.rs_scores,
                    "benchmark": benchmark,
                },
            }
        )

    # Ordenar por fuerza relativa descendente
    signals.sort(key=lambda s: s["meta"]["composite_rs"], reverse=True)

    return {
        "signals": signals,
        "meta": {
            "analyzed": len(symbol_rs),
            "skipped": skipped,
            "signals_count": len(signals),
            "benchmark": benchmark,
            "universe_rs_range": {
                "min": min(universe_rs) if universe_rs else None,
                "max": max(universe_rs) if universe_rs else None,
                "mean": sum(universe_rs) / len(universe_rs) if universe_rs else None,
            },
        },
    }
