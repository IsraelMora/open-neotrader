"""
Backtester plugin — run skill.

Orchestrates signal generation (generate.py) and backtest execution (engine.py).
No network access; receives pre-fetched OHLCV data via args.
"""
from __future__ import annotations

import sys
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).parent / "scripts"
_SCRIPTS_STR = str(_SCRIPTS_DIR)
if _SCRIPTS_STR not in sys.path:
    sys.path.insert(0, _SCRIPTS_STR)

from engine import run_backtest
from generate import generate_signals


def run(
    strategy_id: str,
    prices: dict,
    config: dict,
    _context=None,
) -> dict:
    """
    Execute a backtest for a given strategy and set of price histories.

    Args:
        strategy_id: e.g. "ema-crossover-9-21" or "rsi-mean-reversion"
        prices:      {symbol: [normalized bars with date/open/high/low/close/volume]}
        config:      backtest config dict (initial_capital, commission_pct, etc.)
        _context:    SDK context (unused but required by runner.py call convention)

    Returns:
        {"ok": True, "metrics": {...}, "equity_curve": [...], "trades": [...]}
        or
        {"ok": False, "error": "<message>"}
    """
    if not prices:
        return {"ok": False, "error": "No price data provided"}

    # Validate all symbols have at least one bar
    for symbol, bars in prices.items():
        if not bars:
            return {"ok": False, "error": f"Empty bar list for symbol '{symbol}'"}

    try:
        all_signals: list[dict] = []
        for symbol, bars in prices.items():
            per_symbol_config = {**config, "symbol": symbol}
            signals = generate_signals(strategy_id, bars, per_symbol_config)
            all_signals.extend(signals)

        # engine.run_backtest returns a BacktestResult dataclass (attribute access)
        result = run_backtest(all_signals, prices, config)

        return {
            "ok": True,
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

    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    except Exception as exc:
        return {"ok": False, "error": f"Backtest failed: {exc}"}
