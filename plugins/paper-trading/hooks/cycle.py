"""
Paper Trading — hook de ciclo.
Intercepta señales y las simula en un portafolio virtual.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from paper import execute_signal, load_portfolio, portfolio_summary, update_prices


def on_cycle(ctx):
    cfg = ctx.get("config", {})
    pending_signals = ctx.get("pending_signals", [])
    current_prices = ctx.get("current_prices", {})  # {symbol: price}

    initial_capital = float(cfg.get("initial_capital", 10_000))
    commission = float(cfg.get("commission_pct", 0.001))
    slippage = float(cfg.get("slippage_pct", 0.001))
    max_pos_pct = float(cfg.get("max_position_pct", 20))
    intercept_live = bool(cfg.get("intercept_live", False))

    portfolio = load_portfolio(ctx, initial_capital)

    # Actualizar precios de posiciones abiertas
    if current_prices:
        portfolio = update_prices(portfolio, current_prices)

    logs = []
    executed = []
    passthrough = []  # señales que NO interceptamos (van a live)

    for sig in pending_signals:
        if intercept_live or sig.get("paper_only", False):
            portfolio, log = execute_signal(
                portfolio, sig, current_prices, commission, slippage, max_pos_pct
            )
            logs.append(log)
            executed.append(sig)
        else:
            passthrough.append(sig)

    summary = portfolio_summary(portfolio)

    report_interval = cfg.get("report_interval", "daily")
    if logs or report_interval == "cycle":
        logs.append(
            f"Paper Portfolio: ${summary['total_value']:.2f} "
            f"({summary['total_return_pct']:+.2f}%) | "
            f"{summary['open_positions']} posiciones | "
            f"WR: {summary['win_rate_pct']:.0f}% | "
            f"PF: {summary['profit_factor']:.2f}"
        )

    return {
        # Señales que no fueron interceptadas siguen al sistema live
        "signals": passthrough,
        # Estado actualizado del portafolio paper (se guarda en store)
        "paper_portfolio": {
            "cash": portfolio.cash,
            "initial_capital": portfolio.initial_capital,
            "positions": portfolio.positions,
            "trades": portfolio.trades[-50:],  # últimos 50 trades
            "created_at": portfolio.created_at,
            "updated_at": portfolio.updated_at,
        },
        "paper_summary": summary,
        "paper_executed": len(executed),
        "logs": logs,
    }
