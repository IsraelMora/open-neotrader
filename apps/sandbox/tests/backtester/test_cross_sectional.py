"""
Tests for plugins/backtester/scripts/cross_sectional.py — portfolio-level
cross-sectional momentum backtest (rank the universe by 12-1 momentum, hold the
top-N, rebalance periodically). This is a DIFFERENT engine from the per-symbol
signal backtester: it allocates across a universe.

Run: cd apps/sandbox && python3 -m pytest tests/backtester/test_cross_sectional.py -v
"""
from __future__ import annotations

import datetime

import pytest

from .conftest import load_cross_sectional


@pytest.fixture(scope="module")
def cs():
    return load_cross_sectional()


def _bars(fn, n=150, start=datetime.date(2023, 1, 1)):
    out = []
    for i in range(n):
        d = (start + datetime.timedelta(days=i)).isoformat()
        p = fn(i)
        out.append({"date": d, "open": p, "high": p, "low": p, "close": p, "volume": 1000.0})
    return out


CFG = {"top_n": 1, "lookback": 60, "skip": 5, "rebalance_days": 20, "initial_capital": 10000}


class TestTransactionCosts:
    def test_costs_reduce_returns(self, cs):
        """Rebalancing into positions is not free. With non-zero commission/slippage
        the same run must yield a LOWER total return than the cost-free run — otherwise
        the backtest is overstating profitability (a real correctness gap)."""
        prices = {
            "WIN": _bars(lambda i: 100.0 * (1.01 ** i)),
            "FLAT": _bars(lambda i: 100.0),
            "LOSE": _bars(lambda i: 100.0 * (0.99 ** i)),
        }
        free = cs.run_cross_sectional(
            prices, {**CFG, "commission_pct": 0.0, "slippage_pct": 0.0}
        )
        costly = cs.run_cross_sectional(
            prices, {**CFG, "commission_pct": 0.01, "slippage_pct": 0.005}
        )
        assert free["ok"] and costly["ok"]
        assert (
            costly["metrics"]["total_return_pct"] < free["metrics"]["total_return_pct"]
        ), (costly["metrics"], free["metrics"])

    def test_turnover_costs_more_than_steady_holding(self, cs):
        """A portfolio that swaps its holding mid-run must pay more in costs than one
        that holds the same leader throughout. `churn` has A lead the first half and B
        the second (forces a sell+buy); `steady` keeps A on top the whole time."""
        cfg = {
            "top_n": 1, "lookback": 20, "skip": 1, "rebalance_days": 20,
            "initial_capital": 10000, "commission_pct": 0.02, "slippage_pct": 0.0,
        }
        churn = {
            "A": _bars(lambda i: 100.0 * (1.03 ** i) if i < 60 else 100.0 * (1.03 ** 59), n=120),
            "B": _bars(lambda i: 100.0 if i < 60 else 100.0 * (1.03 ** (i - 60)), n=120),
        }
        steady = {
            "A": _bars(lambda i: 100.0 * (1.02 ** i), n=120),
            "B": _bars(lambda i: 100.0, n=120),
        }
        r_churn = cs.run_cross_sectional(churn, cfg)
        r_steady = cs.run_cross_sectional(steady, cfg)
        assert r_churn["ok"] and r_steady["ok"]
        assert r_churn["metrics"]["total_cost_pct"] > r_steady["metrics"]["total_cost_pct"], (
            r_churn["metrics"]["total_cost_pct"],
            r_steady["metrics"]["total_cost_pct"],
        )


class TestRegimeFilter:
    def test_goes_to_cash_when_breadth_is_weak(self, cs):
        """Regime filter (dual momentum): if too few names have positive momentum
        (weak market breadth), hold CASH instead of buying into a falling market."""
        prices = {
            "UP": _bars(lambda i: 100.0 * (1.01 ** i)),
            "D1": _bars(lambda i: 100.0 * (0.99 ** i)),
            "D2": _bars(lambda i: 100.0 * (0.99 ** i)),
            "D3": _bars(lambda i: 100.0 * (0.99 ** i)),
        }
        # breadth = 1/4 positive = 0.25 < 0.5 → cash
        r = cs.run_cross_sectional(
            prices, {**CFG, "top_n": 2, "regime_filter": True, "regime_min_breadth": 0.5}
        )
        assert r["ok"]
        assert r["final_holdings"] == [], r["final_holdings"]
        # without the filter it would still hold the riser
        r2 = cs.run_cross_sectional(prices, {**CFG, "top_n": 2})
        assert "UP" in r2["final_holdings"]


class TestCrossSectional:
    def test_selects_highest_momentum_and_profits(self, cs):
        prices = {
            "WIN": _bars(lambda i: 100.0 * (1.01 ** i)),   # steady strong uptrend
            "FLAT": _bars(lambda i: 100.0),
            "LOSE": _bars(lambda i: 100.0 * (0.99 ** i)),  # steady downtrend
        }
        r = cs.run_cross_sectional(prices, CFG)
        assert r["ok"], r
        # top_n=1 → holds WIN (best momentum) → positive return
        assert r["metrics"]["total_return_pct"] > 0
        assert "WIN" in r["final_holdings"]

    def test_insufficient_history_is_handled(self, cs):
        prices = {"A": _bars(lambda i: 100.0 + i, n=30), "B": _bars(lambda i: 100.0, n=30)}
        r = cs.run_cross_sectional(prices, CFG)  # lookback 60 > 30 bars
        assert r["ok"] is False
        assert "error" in r

    def test_only_positive_momentum_held(self, cs):
        # All symbols decline → no positive momentum → no holdings → ~flat (no losses)
        prices = {
            "D1": _bars(lambda i: 100.0 * (0.995 ** i)),
            "D2": _bars(lambda i: 100.0 * (0.99 ** i)),
        }
        r = cs.run_cross_sectional(prices, CFG)
        assert r["ok"]
        # Never holds a declining asset → return must not be deeply negative
        assert r["metrics"]["total_return_pct"] >= -1.0

    def test_benchmark_is_sane_not_outlier_inflated(self, cs):
        """Equal-weight benchmark is daily-compounded (robust). A smoothly rising
        symbol + a flat one yields a sane positive benchmark, not an absurd ratio."""
        prices = {
            "UP": _bars(lambda i: 100.0 * (1.005 ** i)),
            "FLAT": _bars(lambda i: 100.0),
        }
        r = cs.run_cross_sectional(prices, CFG)
        assert r["ok"]
        bh = r["metrics"]["buy_hold_return_pct"]
        assert 0 < bh < 200, f"benchmark should be sane, got {bh}"
