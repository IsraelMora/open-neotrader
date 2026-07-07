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


def _annualized_metrics(
    equity_curve: list[dict],
    daily_returns: list[float],
    capital: float,
    periods_per_year: float = 252,
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
            sharpe = (mean_r / std) * math.sqrt(periods_per_year)

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
    if skip >= lookback:
        return {
            "ok": False,
            "error": f"skip ({skip}) must be less than lookback ({lookback})",
        }
    capital = float(config.get("initial_capital", 10000))
    # Transaction costs charged on the notional traded at each rebalance (and on the
    # initial entry from cash). Without this the portfolio rebalances for free, which
    # OVERSTATES returns — turnover is not costless. Defaults match the per-symbol
    # engine / RunBacktestDto so both engines price friction consistently.
    cost_pct = float(config.get("commission_pct", 0.001)) + float(
        config.get("slippage_pct", 0.0005)
    )
    # Regime filter (dual momentum, Antonacci): when market breadth is weak (few names
    # with positive momentum) go fully to cash. Off by default.
    # EMPIRICAL NOTE (2016-2026, 20 mega-caps): this breadth filter did NOT reduce max
    # drawdown and slightly lowered returns — the period was mostly bullish so it rarely
    # triggered, and the monthly rebalance lag meant it didn't dodge fast drawdowns. It
    # may help in prolonged bear regimes, but that benefit is unproven here. Don't assume
    # it improves risk-adjusted returns without re-testing on YOUR universe/period.
    regime_filter = bool(config.get("regime_filter", False))
    regime_min_breadth = float(config.get("regime_min_breadth", 0.5))
    # Volatility targeting (Barroso & Santa-Clara 2015, "Momentum has its moments"):
    # scale exposure toward a constant annualized target vol using the portfolio's
    # trailing realized vol (PAST returns only → no lookahead). High vol → shrink
    # exposure into cash; low vol → cap at max_leverage (no borrowing by default).
    # Off when vol_target <= 0. This is one of the few robustly documented improvements
    # to momentum: it raises Sharpe and cuts the worst crash drawdowns.
    vol_target = float(config.get("vol_target", 0.0))
    vol_window = max(2, int(config.get("vol_window", 21)))
    max_leverage = float(config.get("max_leverage", 1.0))
    # Position weighting at each rebalance: "equal" (default, unchanged behavior) or
    # "inverse_vol" (risk parity — weight_i ∝ 1/realized_vol_i over the trailing
    # `vol_window` bars, reusing the vol_target config above). Falls back to equal
    # weight for a given rebalance (not silently) when a selected name lacks enough
    # trailing history for a valid vol estimate.
    weighting = str(config.get("weighting", "equal"))
    # Annualization factor for bar-count-based metrics (Sharpe's sqrt(N) scaling).
    # CAGR here is calendar-date-span-based (see _annualized_metrics), so it is NOT
    # affected by this — only Sharpe is.
    periods_per_year = float(config.get("periods_per_year", 252))

    # Common trading dates across the ENTIRE universe (so every symbol has a price).
    date_sets = [{b["date"] for b in bars} for bars in prices.values() if bars]
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

    def _exposure(names: list[str], i: int) -> float:
        """Vol-target scale for `names` using trailing realized vol up to index i."""
        if vol_target <= 0 or not names:
            return 1.0
        port_rets: list[float] = []
        for k in range(max(1, i - vol_window + 1), i + 1):
            day = []
            for s in names:
                p0 = px[s].get(common[k - 1])
                p1 = px[s].get(common[k])
                if p0 and p1 and p0 > 0:
                    day.append(p1 / p0 - 1.0)
            if day:
                port_rets.append(sum(day) / len(day))
        if len(port_rets) < 2:
            return 1.0
        mean_r = sum(port_rets) / len(port_rets)
        var = sum((r - mean_r) ** 2 for r in port_rets) / (len(port_rets) - 1)
        ann_vol = math.sqrt(var) * math.sqrt(252)
        if ann_vol <= 0:
            return 1.0
        return min(max_leverage, vol_target / ann_vol)

    equity = capital
    holdings: list[str] = []
    exposure = 1.0  # vol-target scale applied to daily portfolio returns
    weights: dict[str, float] = {}  # current equal-weight allocation by symbol
    total_cost = 0.0
    equity_curve: list[dict] = []
    daily_returns: list[float] = []
    prev_val = capital
    vol_weight_fallback_count = 0

    def _equal_weights(names: list[str]) -> dict[str, float]:
        return {s: 1.0 / len(names) for s in names} if names else {}

    def _inverse_vol_weights(names: list[str], i: int) -> tuple[dict[str, float], bool]:
        """Inverse-realized-vol weights for `names` at rebalance index i.

        Realized vol per name = std of daily returns over the trailing `vol_window`
        bars STRICTLY BEFORE i (bar i itself is never touched — no lookahead). Falls
        back to equal weight for this rebalance only (returns `fell_back=True`) when
        any name lacks at least 2 valid trailing returns, or has zero realized vol.
        """
        if not names:
            return {}, False
        vols: dict[str, float | None] = {}
        for s in names:
            rets = []
            for k in range(max(1, i - vol_window), i):
                p0 = px[s].get(common[k - 1])
                p1 = px[s].get(common[k])
                if p0 and p1 and p0 > 0:
                    rets.append(p1 / p0 - 1.0)
            if len(rets) < 2:
                vols[s] = None
                continue
            mean_r = sum(rets) / len(rets)
            var = sum((r - mean_r) ** 2 for r in rets) / (len(rets) - 1)
            vols[s] = math.sqrt(var)
        if any(v is None or v <= 0 for v in vols.values()):
            return _equal_weights(names), True
        inv = {s: 1.0 / vols[s] for s in names}  # type: ignore[operator]
        total = sum(inv.values())
        if total <= 0:
            return _equal_weights(names), True
        w = {s: inv[s] / total for s in names}
        # Cap any single weight at 0.5 (avoid degenerate concentration). Naively
        # rescaling ALL weights to sum to 1 after a flat min(0.5, w) would re-inflate
        # the capped name back above 0.5 (dividing 0.5 by a sub-1 total). Instead,
        # fix violators at exactly 0.5 and redistribute the remaining budget
        # proportionally among the non-violators (iterating in case that push creates
        # a new violator), so the cap actually holds and weights still sum to 1.
        cap = 0.5
        for _ in range(len(w)):
            over = {s for s, wv in w.items() if wv > cap + 1e-12}
            if not over:
                break
            remaining_names = [s for s in w if s not in over]
            if not remaining_names:
                # No non-violating name to redistribute the freed budget to
                # (a sole holding, or every name tied/over in this iteration).
                # There is nothing "degenerate" to fix here — capping without
                # a valid redistribution target would just shrink total
                # exposure below 1.0, so leave weights as-is.
                break
            remaining_budget = 1.0 - cap * len(over)
            remaining_sum = sum(w[s] for s in remaining_names)
            new_w = dict.fromkeys(over, cap)
            if remaining_sum > 0:
                for s in remaining_names:
                    new_w[s] = (w[s] / remaining_sum) * remaining_budget
            else:
                for s in remaining_names:
                    new_w[s] = remaining_budget / len(remaining_names)
            w = new_w
        return w, False

    for i in range(len(common)):
        date = common[i]

        # Rebalance on schedule (only once enough history exists).
        if i >= lookback and (i - lookback) % rebalance_days == 0:
            ranked = sorted(
                ((s, momentum(s, i)) for s in symbols),
                key=lambda x: (x[1] is not None, x[1]),
                reverse=True,
            )
            valid = [m for _, m in ranked if m is not None]
            breadth = (sum(1 for m in valid if m > 0) / len(valid)) if valid else 0.0
            if regime_filter and breadth < regime_min_breadth:
                holdings = []  # weak market-wide breadth → cash
            else:
                # Hold only positive-momentum names (don't buy falling assets).
                holdings = [s for s, m in ranked[:top_n] if m is not None and m > 0]

            # Charge cost on the traded notional: sum of |Δweight| across all names
            # (covers both the names sold and the names bought, incl. entry from cash).
            if weighting == "inverse_vol":
                new_weights, fell_back = _inverse_vol_weights(holdings, i)
                if fell_back:
                    vol_weight_fallback_count += 1
            else:
                new_weights = _equal_weights(holdings)
            traded = sum(
                abs(new_weights.get(s, 0.0) - weights.get(s, 0.0))
                for s in set(new_weights) | set(weights)
            )
            cost = cost_pct * traded * equity
            equity = max(0.0, equity - cost)
            total_cost += cost
            weights = new_weights
            # Set vol-target exposure for the upcoming holding period.
            exposure = _exposure(holdings, i)

        # Apply one day of weighted return from yesterday's holdings (equal-weight
        # unless `weighting: inverse_vol`), scaled by the vol-target exposure (the
        # un-invested fraction sits in cash, earning 0).
        if holdings and i > 0:
            weighted_ret = 0.0
            have_any = False
            for s in holdings:
                p0 = px[s].get(common[i - 1])
                p1 = px[s].get(date)
                if p0 and p1 and p0 > 0:
                    weighted_ret += weights.get(s, 0.0) * (p1 / p0 - 1.0)
                    have_any = True
            if have_any:
                equity *= 1.0 + exposure * weighted_ret

        equity = max(0.0, equity)
        equity_curve.append({"date": date, "equity": round(equity, 2)})
        if i > 0 and prev_val > 0:
            daily_returns.append(equity / prev_val - 1.0)
        prev_val = equity

    metrics = _annualized_metrics(equity_curve, daily_returns, capital, periods_per_year)
    metrics["total_cost_pct"] = round((total_cost / capital * 100) if capital > 0 else 0.0, 2)

    # Benchmark: equal-weight of the WHOLE universe, daily-compounded over the SAME
    # common dates (consistent with how the strategy equity is built). This is robust
    # to a single symbol's bad/split-glitched first print, unlike a naive p_last/p_first
    # ratio which one outlier can blow up.
    bench_eq = capital
    for i in range(1, len(common)):
        rets = []
        for s in symbols:
            p0 = px[s].get(common[i - 1])
            p1 = px[s].get(common[i])
            if p0 and p1 and p0 > 0:
                rets.append(p1 / p0 - 1.0)
        if rets:
            bench_eq *= 1.0 + sum(rets) / len(rets)
    bench_ret = (bench_eq / capital - 1.0) * 100 if capital > 0 else 0.0
    metrics["buy_hold_return_pct"] = round(bench_ret, 2)
    metrics["alpha_pct"] = round(metrics["total_return_pct"] - bench_ret, 2)

    result = {
        "ok": True,
        "metrics": metrics,
        "equity_curve": equity_curve,
        "final_holdings": holdings,
        "final_weights": weights,
        "n_dates": len(common),
        "universe_size": len(symbols),
    }
    if weighting == "inverse_vol":
        result["vol_weight_fallback_count"] = vol_weight_fallback_count
    return result
