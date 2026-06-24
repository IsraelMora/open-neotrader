"""
Walk-Forward Backtester — integrated into the backtester plugin.

Pardo (2008) anchored walk-forward: IS always starts at bar 0 and grows;
the OOS window slides forward with each split. Drives signal generation and
engine execution through the existing generate/engine pipeline (no standalone
momentum signals here — the real strategy adapters are used instead).

Robustness ratio = Sharpe_OOS / Sharpe_IS (>= 0.5 per window = robust).
Verdict:
  - INSUFICIENTE_DATOS : fewer than 2 valid OOS windows (min_trades met)
  - ROBUSTO            : >= 50% of valid windows have robustness_ratio >= 0.5
  - SOBREAJUSTADO      : < 50% of valid windows are robust
"""
from __future__ import annotations

import sys
from pathlib import Path

# Ensure the scripts directory is on sys.path so generate/engine can be imported.
_SCRIPTS_DIR = Path(__file__).parent
_SCRIPTS_STR = str(_SCRIPTS_DIR)
if _SCRIPTS_STR not in sys.path:
    sys.path.insert(0, _SCRIPTS_STR)

from generate import generate_signals
from engine import run_backtest

# ---------------------------------------------------------------------------
# Pure helper functions (testable without IO)
# ---------------------------------------------------------------------------

_ROBUSTNESS_THRESHOLD = 0.01  # |IS Sharpe| must exceed this to compute ratio


def compute_robustness_ratio(oos_sharpe: float, is_sharpe: float) -> float:
    """Return oos_sharpe / is_sharpe, or 0.0 when IS Sharpe is near zero."""
    if abs(is_sharpe) <= _ROBUSTNESS_THRESHOLD:
        return 0.0
    return oos_sharpe / is_sharpe


def compute_verdict(robust_count: int, total_valid: int) -> str:
    """
    Classify walk-forward result.

    robust_count : number of valid windows with robustness_ratio >= 0.5
    total_valid  : number of windows that met min_trades threshold
    """
    if total_valid < 2:
        return "INSUFICIENTE_DATOS"
    if robust_count / total_valid >= 0.5:
        return "ROBUSTO"
    return "SOBREAJUSTADO"


# ---------------------------------------------------------------------------
# Walk-forward engine
# ---------------------------------------------------------------------------

_MIN_DATA_BARS = 60  # absolute minimum — mirrors wf_backtest.py


def run_walk_forward(
    strategy_id: str,
    prices: dict,
    config: dict,
) -> dict:
    """
    Execute anchored walk-forward validation for a strategy.

    Args:
        strategy_id : one of the curated strategies recognised by generate.py
                      ("trend-following", "mean-reversion", "session-breakout")
        prices      : {symbol: [bars]} — same format as plugin.run()
        config      : dict with walk-forward params plus any strategy params:
                        n_windows      (int,   default 5)
                        in_sample_pct  (float, default 0.7)
                        min_trades     (int,   default 10)
                        commission_pct (float, default 0.001)
                        slippage_pct   (float, default 0.0005)
                        initial_capital (float, default 10000)

    Returns:
        {
          ok: True,
          n_windows: int,
          avg_oos_sharpe: float,
          avg_robustness_ratio: float,
          robust_windows: int,
          total_windows: int,
          verdict: "ROBUSTO" | "SOBREAJUSTADO" | "INSUFICIENTE_DATOS",
          windows: [
            {
              window_idx, is_start, is_end, oos_start, oos_end,
              is_sharpe, oos_sharpe, is_trades, oos_trades,
              oos_win_rate, oos_profit_factor, oos_max_drawdown,
              robustness_ratio
            }, ...
          ],
          summary: {...}
        }
        or {ok: True, verdict: "INSUFICIENTE_DATOS", windows: [], ...}
    """
    n_windows = int(config.get("n_windows", 5))
    in_sample_pct = float(config.get("in_sample_pct", 0.7))
    min_trades = int(config.get("min_trades", 10))

    # Determine total bars from the first (longest) symbol's data.
    if not prices:
        return {
            "ok": True,
            "n_windows": 0,
            "avg_oos_sharpe": 0.0,
            "avg_robustness_ratio": 0.0,
            "robust_windows": 0,
            "total_windows": 0,
            "verdict": "INSUFICIENTE_DATOS",
            "windows": [],
            "summary": {"error": "No price data"},
        }

    # Use the longest symbol bar list to drive the time-axis split.
    ref_symbol = max(prices, key=lambda s: len(prices[s]))
    ref_bars = prices[ref_symbol]
    n = len(ref_bars)

    if n < _MIN_DATA_BARS:
        return {
            "ok": True,
            "n_windows": 0,
            "avg_oos_sharpe": 0.0,
            "avg_robustness_ratio": 0.0,
            "robust_windows": 0,
            "total_windows": 0,
            "verdict": "INSUFICIENTE_DATOS",
            "windows": [],
            "summary": {"error": f"Need at least {_MIN_DATA_BARS} bars, got {n}"},
        }

    # Anchored walk-forward: OOS total = (1 - in_sample_pct) of full history.
    # Each OOS window = oos_total / n_windows bars (at least 1).
    oos_total = n - int(n * in_sample_pct)
    oos_per_window = max(1, oos_total // n_windows)

    window_results = []

    for w in range(n_windows):
        # OOS window for this fold (anchored: IS always starts at 0).
        oos_end_idx = n - (n_windows - 1 - w) * oos_per_window
        oos_start_idx = oos_end_idx - oos_per_window
        is_end_idx = oos_start_idx  # IS = [0 .. is_end_idx)

        if is_end_idx < 20 or oos_end_idx > n or oos_start_idx >= oos_end_idx:
            continue

        is_bars = ref_bars[:is_end_idx]
        oos_bars = ref_bars[oos_start_idx:oos_end_idx]

        # Build per-symbol slices for both windows.
        is_prices = _slice_prices(prices, 0, is_end_idx)
        oos_prices = _slice_prices(prices, oos_start_idx, oos_end_idx)

        is_metrics = _backtest_window(strategy_id, is_prices, config)
        oos_metrics = _backtest_window(strategy_id, oos_prices, config)

        is_sharpe = is_metrics["sharpe_ratio"]
        oos_sharpe = oos_metrics["sharpe_ratio"]
        robustness = compute_robustness_ratio(oos_sharpe, is_sharpe)

        window_results.append({
            "window_idx": w,
            "is_start": 0,
            "is_end": is_end_idx,
            "oos_start": oos_start_idx,
            "oos_end": oos_end_idx,
            "is_sharpe": round(is_sharpe, 3),
            "oos_sharpe": round(oos_sharpe, 3),
            "is_trades": is_metrics["total_trades"],
            "oos_trades": oos_metrics["total_trades"],
            "oos_win_rate": round(oos_metrics["win_rate_pct"] / 100, 3),
            "oos_profit_factor": round(oos_metrics["profit_factor"], 3),
            "oos_max_drawdown": round(oos_metrics["max_drawdown_pct"] / 100, 3),
            "robustness_ratio": round(robustness, 3),
        })

    if not window_results:
        return {
            "ok": True,
            "n_windows": 0,
            "avg_oos_sharpe": 0.0,
            "avg_robustness_ratio": 0.0,
            "robust_windows": 0,
            "total_windows": 0,
            "verdict": "INSUFICIENTE_DATOS",
            "windows": [],
            "summary": {},
        }

    valid = [w for w in window_results if w["oos_trades"] >= min_trades]
    avg_oos_sharpe = sum(w["oos_sharpe"] for w in valid) / len(valid) if valid else 0.0
    avg_robustness = sum(w["robustness_ratio"] for w in valid) / len(valid) if valid else 0.0
    robust_count = sum(1 for w in valid if w["robustness_ratio"] >= 0.5)

    verdict = compute_verdict(robust_count, len(valid))

    summary: dict = {}
    if valid:
        summary = {
            "avg_oos_win_rate": round(sum(w["oos_win_rate"] for w in valid) / len(valid), 3),
            "avg_oos_profit_factor": round(
                sum(w["oos_profit_factor"] for w in valid) / len(valid), 3
            ),
            "avg_oos_max_drawdown": round(
                sum(w["oos_max_drawdown"] for w in valid) / len(valid), 3
            ),
            "pct_robust_windows": round(robust_count / len(valid), 3),
        }

    return {
        "ok": True,
        "n_windows": len(window_results),
        "avg_oos_sharpe": round(avg_oos_sharpe, 3),
        "avg_robustness_ratio": round(avg_robustness, 3),
        "robust_windows": robust_count,
        "total_windows": len(valid),
        "verdict": verdict,
        "windows": window_results,
        "summary": summary,
    }


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _slice_prices(
    prices: dict, start: int, end: int
) -> dict:
    """Return a sub-dict of prices sliced to [start:end] for each symbol."""
    return {sym: bars[start:end] for sym, bars in prices.items() if bars[start:end]}


def _backtest_window(
    strategy_id: str,
    prices: dict,
    config: dict,
) -> dict:
    """
    Run generate + engine over a single window's prices dict.
    Returns a flat metrics dict (same keys as BacktestResult fields).
    """
    all_signals: list[dict] = []
    for symbol, bars in prices.items():
        if not bars:
            continue
        per_symbol_cfg = {**config, "symbol": symbol}
        signals = generate_signals(strategy_id, bars, per_symbol_cfg)
        all_signals.extend(signals)

    result = run_backtest(all_signals, prices, config)

    return {
        "sharpe_ratio": result.sharpe_ratio,
        "total_trades": result.total_trades,
        "win_rate_pct": result.win_rate_pct,
        "profit_factor": result.profit_factor,
        "max_drawdown_pct": result.max_drawdown_pct,
    }
