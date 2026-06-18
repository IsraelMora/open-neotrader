"""Hook de ciclo DCA — genera órdenes de compra periódicas de importe fijo."""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from dca import (
    compute_dca_signals,
    load_dca_state,
    portfolio_summary,
    save_dca_state,
    update_position,
)

STATE_FILE = os.path.join(os.path.dirname(__file__), "..", "data", "dca_state.json")


def on_cycle(ctx: dict) -> dict:
    config = ctx.get("config", {})
    universe = ctx.get("universe", [])
    ohlcv = ctx.get("ohlcv", {})

    amount_per_cycle = float(config.get("amount_per_cycle", 100.0))
    frequency_days = int(config.get("frequency_days", 7))
    max_positions = int(config.get("max_positions", 5))
    min_dip_pct = float(config.get("min_dip_pct", 0.0))
    volatility_boost = bool(config.get("volatility_boost", False))
    vol_multiplier = float(config.get("volatility_multiplier", 2.0))

    # Precio actual = último close
    current_prices: dict[str, float] = {}
    recent_returns: dict[str, float] = {}
    for symbol in universe:
        closes = ohlcv.get(symbol, {}).get("closes", [])
        if closes:
            current_prices[symbol] = closes[-1]
            if len(closes) >= 2:
                recent_returns[symbol] = (closes[-1] - closes[-2]) / closes[-2]

    # Cargar estado DCA persistente
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    positions = load_dca_state(STATE_FILE)

    dca_signals = compute_dca_signals(
        universe=universe,
        current_prices=current_prices,
        dca_positions=positions,
        amount_per_cycle=amount_per_cycle,
        frequency_days=frequency_days,
        max_positions=max_positions,
        min_dip_pct=min_dip_pct,
        volatility_boost=volatility_boost,
        volatility_multiplier=vol_multiplier,
        recent_returns=recent_returns,
    )

    # Convertir a formato de señal estándar y actualizar estado
    signals = []
    buys = 0
    for sig in dca_signals:
        if sig.action != "buy":
            continue
        price = current_prices.get(sig.symbol)
        if price is None:
            continue

        signals.append(
            {
                "symbol": sig.symbol,
                "action": "long",
                "strength": 0.7,  # DCA es determinista — fuerza fija moderada
                "plugin": "dollar-cost-averaging",
                "reason": sig.reason,
                "meta": {
                    "invest_amount": sig.amount,
                    "current_price": price,
                    "estimated_shares": sig.amount / price,
                    "days_since_last_buy": sig.days_since_last,
                    "dca_type": "periodic",
                },
            }
        )

        # Actualizar posición en estado persistente
        positions[sig.symbol] = update_position(
            positions.get(sig.symbol),
            sig.symbol,
            sig.amount,
            price,
        )
        buys += 1

    # Guardar estado actualizado
    if buys > 0:
        save_dca_state(positions, STATE_FILE)

    summary = portfolio_summary(positions, current_prices)

    return {
        "signals": signals,
        "meta": {
            "dca_buys": buys,
            "portfolio_summary": summary,
            "total_signals_evaluated": len(dca_signals),
        },
    }
