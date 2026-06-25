"""
Cross-sectional momentum backtest (portfolio-level).

Unlike the per-symbol signal backtester (engine.py), this ranks the WHOLE universe
by 12-1 style momentum each rebalance, holds the top-N equal-weight, and rebalances
periodically. Cross-sectional momentum is one of the most robust documented factors
(Jegadeesh & Titman 1993), so it's the most promising honest edge available here.

Strict no-lookahead: momentum at rebalance index i uses prices at i-skip and i-lookback
(both in the past); positions are held going forward until the next rebalance.

run_cross_sectional(prices, config) -> {ok, metrics, equity_curve, final_holdings, ...}
"""
from __future__ import annotations

import math
from datetime import date as _date
from typing import Any


def _annualized_metrics(
    equity_curve: list[dict], daily_returns: list[float], capital: float
) -> dict:
    final_eq = equity_curve[-1]["equity"] if equity_curve else capital
    total_return = (final_eq / capital - 1.0) * 100 if capital > 0 else 0.0

    # CAGR over the calendar span
    cagr = 0.0
    if len(equity_curve) >= 2 and capital > 0 and final_eq > 0:
        try:
            d0 = _date.fromisoformat(equity_curve[0]["date"])
            d1 = _date.fromisoformat(equity_curve[-1]["date"])
            years = max((d1 - d0).days / 365.25, 1e-9)
            cagr = ((final_eq / capital) ** (1 / years) - 1.0) * 100
        except Exception:
            cagr = 0.0

    # Sharpe (daily → annualized)
    sharpe = 0.0
    if len(daily_returns) >= 2:
        mean_r = sum(daily_returns) / len(daily_returns)
        var = sum((r - mean_r) ** 2 for r in daily_returns) / (len(daily_returns) - 1)
        std = math.sqrt(var)
        if std > 0:
            sharpe = (mean_r / std) * math.sqrt(252)

    # Max drawdown (equity floors at >= 0 by construction)
    peak = capital
    max_dd = 0.0
    for p in equity_curve:
        eq = p["equity"]
        if eq > peak:
            peak = eq
        if peak > 0:
            dd = (peak - eq) / peak * 100
            if dd > max_dd:
                max_dd = dd

    return {
        "total_return_pct": round(total_return, 2),
        "cagr_pct": round(cagr, 2),
        "sharpe_ratio": round(sharpe, 2),
        "max_drawdown_pct": round(max_dd, 2),
    }


def run_cross_sectional(prices: dict[str, list[dict]], config: dict, _context=None) -> dict:
    """Backtest a top-N cross-sectional momentum portfolio over the universe."""
    if not prices:
        return {"ok": False, "error": "No price data provided"}

    top_n = int(config.get("top_n", 3))
    rebalance_days = max(1, int(config.get("rebalance_days", 21)))
    lookback = int(config.get("lookback", 252))
    skip = int(config.get("skip", 21))
    capital = float(config.get("initial_capital", 10000))

    # Common trading dates across the ENTIRE universe (so every symbol has a price).
    date_sets = [set(b["date"] for b in bars) for bars in prices.values() if bars]
    if not date_sets:
        return {"ok": False, "error": "Empty price series"}
    common = sorted(set.intersection(*date_sets))
    if len(common) <= lookback + 1:
        return {
            "ok": False,
            "error": f"Insufficient overlapping history: {len(common)} bars <= lookback {lookback}",
        }

    px = {s: {b["date"]: b["close"] for b in bars} for s, bars in prices.items()}
    symbols = list(prices.keys())

    def momentum(sym: str, i: int) -> float | None:
        """12-1 style momentum at common-date index i (no lookahead)."""
        if i - lookback < 0:
            return None
        p_now = px[sym].get(common[i - skip])
        p_old = px[sym].get(common[i - lookback])
        if not p_now or not p_old or p_old <= 0:
            return None
        return p_now / p_old - 1.0

    equity = capital
    holdings: list[str] = []
    equity_curve: list[dict] = []
    daily_returns: list[float] = []
    prev_val = capital

    for i in range(len(common)):
        date = common[i]

        # Rebalance on schedule (only once enough history exists).
        if i >= lookback and (i - lookback) % rebalance_days == 0:
            ranked = sorted(
                ((s, momentum(s, i)) for s in symbols),
                key=lambda x: (x[1] is not None, x[1]),
                reverse=True,
            )
            # Hold only positive-momentum names (don't buy falling assets).
            holdings = [s for s, m in ranked[:top_n] if m is not None and m > 0]

        # Apply one day of equal-weight return from yesterday's holdings.
        if holdings and i > 0:
            rets = []
            for s in holdings:
                p0 = px[s].get(common[i - 1])
                p1 = px[s].get(date)
                if p0 and p1 and p0 > 0:
                    rets.append(p1 / p0 - 1.0)
            if rets:
                equity *= 1.0 + sum(rets) / len(rets)

        equity = max(0.0, equity)
        equity_curve.append({"date": date, "equity": round(equity, 2)})
        if i > 0 and prev_val > 0:
            daily_returns.append(equity / prev_val - 1.0)
        prev_val = equity

    metrics = _annualized_metrics(equity_curve, daily_returns, capital)

    # Benchmark: equal-weight buy & hold of the WHOLE universe over the same dates.
    bench_ret = 0.0
    per_symbol = []
    for s in symbols:
        p0 = px[s].get(common[0])
        p1 = px[s].get(common[-1])
        if p0 and p1 and p0 > 0:
            per_symbol.append(p1 / p0 - 1.0)
    if per_symbol:
        bench_ret = sum(per_symbol) / len(per_symbol) * 100
    metrics["buy_hold_return_pct"] = round(bench_ret, 2)
    metrics["alpha_pct"] = round(metrics["total_return_pct"] - bench_ret, 2)

    return {
        "ok": True,
        "metrics": metrics,
        "equity_curve": equity_curve,
        "final_holdings": holdings,
        "n_dates": len(common),
        "universe_size": len(symbols),
    }
