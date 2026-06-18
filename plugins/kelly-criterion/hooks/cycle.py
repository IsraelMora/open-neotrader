"""
on_cycle hook — Kelly Criterion Discipline.

Se activa en cada ciclo de trading. Lee señales pendientes del contexto
y calcula el tamaño de posición óptimo con Kelly para cada una.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from kelly import compute_kelly, position_size, stats_from_trades  # noqa: E402


def on_cycle(ctx: dict) -> dict:
    """
    Args:
        ctx["pending_signals"]: lista de señales de otros plugins con action="long"
        ctx["portfolio_value"]: valor total del portfolio en USD
        ctx["config"]:         config del plugin (kelly_fraction, max_position_pct)
        ctx["trade_history"]:  historial de trades con 'pnl_pct'

    Returns:
        { signals: [...], logs: [...] }
        Los signals son las mismas señales enriquecidas con position_size.
    """
    pending_signals: list[dict] = ctx.get("pending_signals", [])
    portfolio_value: float = ctx.get("portfolio_value", 10_000.0)
    config: dict = ctx.get("config", {})
    trade_history: list[dict] = ctx.get("trade_history", [])

    kelly_fraction_cfg = config.get("kelly_fraction", 0.5)
    max_position_pct = config.get("max_position_pct", 10.0)

    signals = []
    logs = []

    # Calcular estadísticas históricas
    stats = stats_from_trades(trade_history, min_required=30)
    use_safety = not stats.is_reliable

    if use_safety:
        logs.append(
            {
                "level": "info",
                "msg": (
                    f"Kelly en modo seguro: {stats.n_trades} trades"
                    " (mínimo 30). Usando 2% por trade."
                ),
            }
        )
        effective_kelly = 0.02  # 2% por defecto si no hay historial
    else:
        effective_kelly = compute_kelly(
            stats.win_rate, stats.payoff_ratio, fraction=kelly_fraction_cfg
        )
        logs.append(
            {
                "level": "info",
                "msg": (
                    f"Kelly stats | win_rate={stats.win_rate:.1%}"
                    f" | payoff={stats.payoff_ratio:.2f}"
                    f" | kelly_full={stats.kelly_full:.1%}"
                    f" | kelly_half={stats.kelly_half:.1%}"
                    f" | usando={effective_kelly:.1%}"
                ),
            }
        )

    # Enriquecer señales long con sizing de Kelly
    for sig in pending_signals:
        if sig.get("action") != "long":
            signals.append(sig)  # pasar exit/neutral sin modificar
            continue

        symbol = sig.get("symbol", "?")
        price = sig.get("price", 0.0)
        stop_loss_pct = sig.get("stop_loss_pct", 2.0)
        take_profit_pct = sig.get("take_profit_pct", 3.0)

        if price <= 0:
            logs.append(
                {"level": "warning", "msg": f"{symbol}: precio inválido ({price}), omitido"}
            )
            continue

        sizing = position_size(
            capital=portfolio_value,
            price=price,
            stop_loss_pct=stop_loss_pct,
            take_profit_pct=take_profit_pct,
            kelly_fraction=effective_kelly,
            max_position_pct=max_position_pct,
            use_safety=use_safety,
        )

        enriched = {
            **sig,
            "kelly": {
                "shares": sizing.shares,
                "position_usd": sizing.position_usd,
                "position_pct": sizing.position_pct_capital,
                "risk_usd": sizing.risk_usd,
                "reward_usd": sizing.reward_usd,
                "rr_ratio": sizing.risk_reward_ratio,
                "warning": sizing.warning,
            },
        }
        signals.append(enriched)

    sized_count = sum(1 for s in signals if "kelly" in s)
    logs.append(
        {
            "level": "info",
            "msg": (
                f"Kelly sizing completado: {sized_count} señales"
                f" dimensionadas de {len(pending_signals)} recibidas."
            ),
        }
    )

    return {"signals": signals, "logs": logs}


if __name__ == "__main__":
    ctx = json.load(sys.stdin)
    result = on_cycle(ctx)
    print(json.dumps(result))
