"""
Backtester — hook bajo demanda.
Se ejecuta cuando el agente llama run_backtest via tools.json.
Recibe señales históricas y precios del ctx e invoca el motor.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))


from engine import format_result, run_backtest


def on_demand(ctx):
    cfg = ctx.get("config", {})
    signals = ctx.get("backtest_signals", [])
    prices = ctx.get("backtest_prices", {})

    if not signals:
        return {
            "ok": False,
            "error": "No se proporcionaron señales. Usa inject_backtest_signals para añadirlas.",
        }

    if not prices:
        return {
            "ok": False,
            "error": (
                "No se proporcionaron precios históricos. "
                "Usa inject_backtest_prices para añadirlos."
            ),
        }

    try:
        result = run_backtest(signals, prices, cfg)
        return {
            "ok": True,
            "summary": format_result(result),
            "metrics": {
                "total_return_pct": result.total_return_pct,
                "cagr_pct": result.cagr_pct,
                "sharpe_ratio": result.sharpe_ratio,
                "sortino_ratio": result.sortino_ratio,
                "max_drawdown_pct": result.max_drawdown_pct,
                "calmar_ratio": result.calmar_ratio,
                "total_trades": result.total_trades,
                "win_rate_pct": result.win_rate_pct,
                "profit_factor": result.profit_factor,
                "avg_win_pct": result.avg_win_pct,
                "avg_loss_pct": result.avg_loss_pct,
                "avg_duration_days": result.avg_duration_days,
                "largest_win_pct": result.largest_win_pct,
                "largest_loss_pct": result.largest_loss_pct,
                "time_in_market_pct": result.time_in_market_pct,
            },
            "equity_curve": result.equity_curve,
            "trades": result.trades,
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}
