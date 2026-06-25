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
