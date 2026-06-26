"""
Backtester plugin — run skill.

Orchestrates signal generation (generate.py) and backtest execution (engine.py).
No network access; receives pre-fetched OHLCV data via args.
"""
from __future__ import annotations

import sys
from pathlib import Path

_SCRIPTS_DIR = str(Path(__file__).parent / "scripts")
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

from engine import run_backtest
from generate import generate_signals
from walk_forward import run_walk_forward as _run_walk_forward
from cross_sectional import run_cross_sectional as _run_cross_sectional


def run_cross_sectional(prices: dict, config: dict, _context=None) -> dict:
    """Cross-sectional momentum portfolio backtest: rank the universe by 12-1
    momentum, hold the top-N equal-weight, rebalance periodically.

    Args:
        prices: {symbol: [normalized bars with date/open/high/low/close/volume]}
        config: {top_n, rebalance_days, lookback, skip, initial_capital}
    Returns:
        {ok, metrics{total_return_pct,cagr_pct,sharpe_ratio,max_drawdown_pct,
         buy_hold_return_pct,alpha_pct}, equity_curve, final_holdings, ...}
        or {ok: False, error}
    """
    if not prices:
        return {"ok": False, "error": "No price data provided"}
    try:
        return _run_cross_sectional(prices, config)
    except Exception as exc:  # noqa: BLE001 — surface as structured error
        return {"ok": False, "error": f"Cross-sectional backtest failed: {exc}"}


def run(
    strategy_id: str,
    prices: dict,
    config: dict,
    _context=None,
) -> dict:
    """
    Execute a backtest for a given strategy and set of price histories.

    Args:
        strategy_id: e.g. "trend-following", "mean-reversion" or "session-breakout"
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
                "buy_hold_return_pct": result.buy_hold_return_pct,
                "alpha_pct": result.alpha_pct,
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


def run_walk_forward(
    strategy_id: str,
    prices: dict,
    config: dict,
    _context=None,
) -> dict:
    """
    Execute anchored walk-forward validation for a strategy (Pardo 2008).

    Splits the price history into N rolling in-sample / out-of-sample windows
    and runs a full backtest (generate → engine) on each. Computes the
    robustness ratio (Sharpe_OOS / Sharpe_IS) per window and returns a verdict:
      - ROBUSTO           : >= 50% of valid windows have robustness_ratio >= 0.5
      - SOBREAJUSTADO     : < 50% of valid windows are robust
      - INSUFICIENTE_DATOS: fewer than 2 valid OOS windows

    Args:
        strategy_id: e.g. "trend-following", "mean-reversion", "session-breakout"
        prices:      {symbol: [normalized bars with date/open/high/low/close/volume]}
        config:      walk-forward config dict:
                       n_windows (int, default 5)
                       in_sample_pct (float, default 0.7)
                       min_trades (int, default 10)
                       commission_pct, slippage_pct, initial_capital, ...
        _context:    SDK context (unused but required by runner.py call convention)

    Returns:
        {
          "ok": True,
          "verdict": "ROBUSTO" | "SOBREAJUSTADO" | "INSUFICIENTE_DATOS",
          "n_windows": int,
          "avg_oos_sharpe": float,
          "avg_robustness_ratio": float,
          "robust_windows": int,
          "total_windows": int,
          "windows": [{window_idx, is_sharpe, oos_sharpe, robustness_ratio, ...}, ...],
          "summary": {...}
        }
        or {"ok": False, "error": "<message>"}
    """
    if not prices:
        return {"ok": False, "error": "No price data provided"}

    for symbol, bars in prices.items():
        if not bars:
            return {"ok": False, "error": f"Empty bar list for symbol '{symbol}'"}

    try:
        return _run_walk_forward(strategy_id, prices, config)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    except Exception as exc:
        return {"ok": False, "error": f"Walk-forward failed: {exc}"}
