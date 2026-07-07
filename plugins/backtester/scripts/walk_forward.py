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

import statistics
import sys
from pathlib import Path

# Ensure the scripts directory is on sys.path so generate/engine can be imported.
_SCRIPTS_DIR = Path(__file__).parent
_SCRIPTS_STR = str(_SCRIPTS_DIR)
if _SCRIPTS_STR not in sys.path:
    sys.path.insert(0, _SCRIPTS_STR)

from cross_sectional import run_cross_sectional  # noqa: E402
from engine import run_backtest  # noqa: E402
from generate import generate_signals  # noqa: E402

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


# ---------------------------------------------------------------------------
# Cross-sectional (portfolio-level) walk-forward
# ---------------------------------------------------------------------------
#
# Same ANCHORED walk-forward semantics as run_walk_forward() above (Pardo 2008):
# IS always starts at bar 0 and grows; the OOS window slides forward each fold.
# Window-boundary math (oos_total/oos_per_window/oos_end_idx/oos_start_idx/
# is_end_idx) and the no-lookahead slicing (_slice_prices — a plain bars[start:end]
# per symbol, no warmup prefix prepended to OOS) are IDENTICAL to run_walk_forward:
# this reuses the same helper rather than re-deriving the split logic. The engine
# itself is run_cross_sectional() (imported from cross_sectional.py, not
# duplicated) on each window's price slice — so a window with a thin/short-history
# symbol is handled by the SAME thin-symbol-drop logic as a plain run, not by any
# special-cased warmup buffer here.
#
# Verdict vocabulary and thresholds mirror run_walk_forward()/compute_verdict()
# EXACTLY (same function, reused, not reimplemented) — only the per-window inputs
# differ:
#   - "valid window"   : per-symbol validity is `oos_trades >= min_trades` (enough
#                        OOS trades to trust the ratio). The portfolio analog has
#                        no discrete trade count; the equivalent floor is that BOTH
#                        the IS and OOS cross-sectional backtests for that window
#                        actually ran (`is_ok and oos_ok` — i.e. run_cross_sectional
#                        didn't hit its own "Insufficient overlapping history"
#                        error on that slice). A window that failed to produce a
#                        result carries no statistical information, same as a
#                        window with too few trades.
#   - robustness_ratio : identical formula, reused verbatim — compute_robustness_ratio
#                        (oos_sharpe / is_sharpe, 0 when |is_sharpe| <= 0.01).
#   - ROBUSTO          : >= 50% of valid windows have robustness_ratio >= 0.5 (same
#                        threshold, same compute_verdict call).
#   - SOBREAJUSTADO    : < 50% of valid windows are robust (same).
#   - INSUFICIENTE_DATOS: < 2 valid windows, OR fewer than _MIN_DATA_BARS total bars,
#                        OR no price data (same floor as run_walk_forward).
#
# Additional cross-sectional-only aggregates (per the design brief, not present in
# the per-symbol version): median_oos_sharpe (mean alone can be skewed by one
# outlier window) and pct_positive_oos_windows (breadth check — are OOS windows
# NET positive, independent of Sharpe).


def _cs_wf_insufficient(error_msg: str | None = None) -> dict:
    """Shared 'not enough data' shape — same fields/verdict as run_walk_forward's
    early-return paths, adapted to the cross-sectional result shape."""
    return {
        "ok": True,
        "n_windows": 0,
        "avg_oos_sharpe": 0.0,
        "median_oos_sharpe": 0.0,
        "avg_robustness_ratio": 0.0,
        "robust_windows": 0,
        "total_windows": 0,
        "verdict": "INSUFICIENTE_DATOS",
        "windows": [],
        "summary": ({"error": error_msg} if error_msg else {}),
    }


def run_cross_sectional_walk_forward(prices: dict, config: dict) -> dict:
    """
    Execute anchored walk-forward validation for the cross-sectional momentum
    portfolio engine (run_cross_sectional). See the module comment above for how
    this mirrors run_walk_forward()'s window-splitting, no-lookahead slicing, and
    verdict vocabulary/thresholds.

    Args:
        prices : {symbol: [bars]} — same format as run_cross_sectional().
        config : cross-sectional config (top_n, lookback, skip, vol_target,
                 weighting, regime_filter, ...) PLUS walk-forward params:
                   n_windows     (int,   default 5)
                   in_sample_pct (float, default 0.7)
                 The SAME config dict is passed UNCHANGED to run_cross_sectional()
                 for every IS/OOS slice in every window — no per-window overrides.

    Returns: same shape as run_walk_forward(), plus median_oos_sharpe and
        summary.pct_positive_oos_windows. Each window entry also carries
        is_dropped_symbols/oos_dropped_symbols (thin-symbol drops, capability 1)
        and is_ok/oos_ok (whether that slice's backtest ran at all).
    """
    n_windows = int(config.get("n_windows", 5))
    in_sample_pct = float(config.get("in_sample_pct", 0.7))
    lookback = int(config.get("lookback", 252))

    if not prices:
        return _cs_wf_insufficient("No price data")

    ref_symbol = max(prices, key=lambda s: len(prices[s]))
    n = len(prices[ref_symbol])

    if n < _MIN_DATA_BARS:
        return _cs_wf_insufficient(f"Need at least {_MIN_DATA_BARS} bars, got {n}")

    oos_total = n - int(n * in_sample_pct)
    oos_per_window = max(1, oos_total // n_windows)

    # Anchored: window 0 has the SMALLEST in-sample slice (IS only grows from
    # there). Validate lookback against that floor up front — a fail-fast check
    # in the same spirit as cross_sectional.py's `skip >= lookback` guard, so a
    # misconfigured lookback errors clearly instead of silently producing
    # zero-signal windows.
    smallest_is_end_idx = n - n_windows * oos_per_window
    if lookback >= smallest_is_end_idx:
        return _cs_wf_insufficient(
            f"lookback ({lookback}) must be less than the smallest in-sample "
            f"window size ({smallest_is_end_idx} bars) — reduce n_windows/lookback "
            "or provide more price history"
        )

    window_results = []

    for w in range(n_windows):
        oos_end_idx = n - (n_windows - 1 - w) * oos_per_window
        oos_start_idx = oos_end_idx - oos_per_window
        is_end_idx = oos_start_idx  # IS = [0 .. is_end_idx)

        if is_end_idx < 20 or oos_end_idx > n or oos_start_idx >= oos_end_idx:
            continue

        is_prices = _slice_prices(prices, 0, is_end_idx)
        oos_prices = _slice_prices(prices, oos_start_idx, oos_end_idx)

        is_result = run_cross_sectional(is_prices, config)
        oos_result = run_cross_sectional(oos_prices, config)

        is_ok = bool(is_result.get("ok"))
        oos_ok = bool(oos_result.get("ok"))

        is_sharpe = is_result["metrics"]["sharpe_ratio"] if is_ok else 0.0
        oos_sharpe = oos_result["metrics"]["sharpe_ratio"] if oos_ok else 0.0
        robustness = (
            compute_robustness_ratio(oos_sharpe, is_sharpe) if (is_ok and oos_ok) else 0.0
        )

        window_results.append({
            "window_idx": w,
            "is_start": 0,
            "is_end": is_end_idx,
            "oos_start": oos_start_idx,
            "oos_end": oos_end_idx,
            "is_ok": is_ok,
            "oos_ok": oos_ok,
            "is_sharpe": round(is_sharpe, 3),
            "oos_sharpe": round(oos_sharpe, 3),
            "is_cagr_pct": round(is_result["metrics"]["cagr_pct"], 3) if is_ok else 0.0,
            "oos_cagr_pct": round(oos_result["metrics"]["cagr_pct"], 3) if oos_ok else 0.0,
            "is_max_drawdown_pct": (
                round(is_result["metrics"]["max_drawdown_pct"], 3) if is_ok else 0.0
            ),
            "oos_max_drawdown_pct": (
                round(oos_result["metrics"]["max_drawdown_pct"], 3) if oos_ok else 0.0
            ),
            "oos_total_return_pct": (
                round(oos_result["metrics"]["total_return_pct"], 3) if oos_ok else 0.0
            ),
            "is_dropped_symbols": is_result.get("dropped_symbols", []) if is_ok else [],
            "oos_dropped_symbols": oos_result.get("dropped_symbols", []) if oos_ok else [],
            "robustness_ratio": round(robustness, 3),
        })

    if not window_results:
        return _cs_wf_insufficient()

    valid = [w for w in window_results if w["is_ok"] and w["oos_ok"]]

    if not valid:
        avg_oos_sharpe = median_oos_sharpe = avg_robustness = 0.0
        pct_positive_oos = 0.0
        robust_count = 0
    else:
        oos_sharpes = [w["oos_sharpe"] for w in valid]
        avg_oos_sharpe = sum(oos_sharpes) / len(valid)
        median_oos_sharpe = statistics.median(oos_sharpes)
        avg_robustness = sum(w["robustness_ratio"] for w in valid) / len(valid)
        robust_count = sum(1 for w in valid if w["robustness_ratio"] >= 0.5)
        pct_positive_oos = sum(1 for w in valid if w["oos_total_return_pct"] > 0) / len(valid)

    verdict = compute_verdict(robust_count, len(valid))

    summary: dict = {}
    if valid:
        summary = {
            "avg_oos_cagr_pct": round(sum(w["oos_cagr_pct"] for w in valid) / len(valid), 3),
            "avg_oos_max_drawdown_pct": round(
                sum(w["oos_max_drawdown_pct"] for w in valid) / len(valid), 3
            ),
            "pct_positive_oos_windows": round(pct_positive_oos, 3),
            "pct_robust_windows": round(robust_count / len(valid), 3),
        }

    return {
        "ok": True,
        "n_windows": len(window_results),
        "avg_oos_sharpe": round(avg_oos_sharpe, 3),
        "median_oos_sharpe": round(median_oos_sharpe, 3),
        "avg_robustness_ratio": round(avg_robustness, 3),
        "robust_windows": robust_count,
        "total_windows": len(valid),
        "verdict": verdict,
        "windows": window_results,
        "summary": summary,
    }
