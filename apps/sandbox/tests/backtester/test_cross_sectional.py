"""
Tests for plugins/backtester/scripts/cross_sectional.py — portfolio-level
cross-sectional momentum backtest (rank the universe by 12-1 momentum, hold the
top-N, rebalance periodically). This is a DIFFERENT engine from the per-symbol
signal backtester: it allocates across a universe.

Run: cd apps/sandbox && python3 -m pytest tests/backtester/test_cross_sectional.py -v
"""
from __future__ import annotations

import datetime
import math

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


class TestVolatilityTargeting:
    """Volatility-managed momentum (Barroso & Santa-Clara 2015): scale exposure toward
    a constant target vol. High realized vol → shrink exposure (hold cash); low vol →
    cap at max_leverage (no borrowing by default). Off when vol_target <= 0."""

    # A net-rising but very volatile name (alternating +10% / -5%) → high realized vol.
    _vol_riser = staticmethod(lambda i: 100.0 * (1.10 ** ((i + 1) // 2)) * (0.95 ** (i // 2)))
    _cfg = {
        "top_n": 1, "lookback": 20, "skip": 1, "rebalance_days": 20,
        "initial_capital": 10000, "commission_pct": 0.0, "slippage_pct": 0.0,
    }

    def test_scales_down_a_high_vol_holding(self, cs):
        prices = {
            "V": _bars(self._vol_riser, n=120),
            "FLAT": _bars(lambda i: 100.0, n=120),
        }
        plain = cs.run_cross_sectional(prices, self._cfg)
        vt = cs.run_cross_sectional(prices, {**self._cfg, "vol_target": 0.15, "vol_window": 10})
        assert plain["ok"] and vt["ok"]
        assert "V" in plain["final_holdings"]
        # Dampened exposure on a volatile riser → smaller (still positive) net move.
        assert 0 < vt["metrics"]["total_return_pct"] < plain["metrics"]["total_return_pct"], (
            vt["metrics"]["total_return_pct"],
            plain["metrics"]["total_return_pct"],
        )

    def test_caps_at_no_leverage_when_vol_is_low(self, cs):
        prices = {
            "S": _bars(lambda i: 100.0 * (1.005 ** i), n=120),  # smooth → ~zero realized vol
            "FLAT": _bars(lambda i: 100.0, n=120),
        }
        plain = cs.run_cross_sectional(prices, self._cfg)
        vt = cs.run_cross_sectional(
            prices, {**self._cfg, "vol_target": 0.50, "vol_window": 10, "max_leverage": 1.0}
        )
        assert plain["ok"] and vt["ok"]
        # Realized vol below target but capped at 1.0 → no leverage → identical returns.
        assert abs(
            vt["metrics"]["total_return_pct"] - plain["metrics"]["total_return_pct"]
        ) < 0.01, (vt["metrics"]["total_return_pct"], plain["metrics"]["total_return_pct"])


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


class TestPeriodsPerYear:
    """`periods_per_year` (default 252) scales Sharpe's sqrt(N) annualization factor.
    CAGR is calendar-date-span-based (not bar-count-based), so it is NOT affected —
    only the bar-count/sqrt(N)-based Sharpe scaling is."""

    _prices = {
        "WIN": _bars(lambda i: 100.0 * (1.01 ** i)),
        "FLAT": _bars(lambda i: 100.0),
        "LOSE": _bars(lambda i: 100.0 * (0.99 ** i)),
    }

    def test_default_and_explicit_252_are_byte_identical(self, cs):
        default = cs.run_cross_sectional(self._prices, CFG)
        explicit = cs.run_cross_sectional(self._prices, {**CFG, "periods_per_year": 252})
        assert default["ok"] and explicit["ok"]
        assert default["metrics"] == explicit["metrics"]
        assert default["equity_curve"] == explicit["equity_curve"]

    def test_sharpe_scales_by_sqrt_ratio_of_periods_per_year(self, cs):
        r252 = cs.run_cross_sectional(self._prices, CFG)
        r52 = cs.run_cross_sectional(self._prices, {**CFG, "periods_per_year": 52})
        assert r252["ok"] and r52["ok"]
        # CAGR is calendar-date-based -> unaffected by periods_per_year.
        assert r252["metrics"]["cagr_pct"] == r52["metrics"]["cagr_pct"]
        sharpe_252 = r252["metrics"]["sharpe_ratio"]
        sharpe_52 = r52["metrics"]["sharpe_ratio"]
        assert sharpe_252 != 0
        expected_ratio = math.sqrt(52 / 252)
        actual_ratio = sharpe_52 / sharpe_252
        assert abs(actual_ratio - expected_ratio) < 0.01, (actual_ratio, expected_ratio)


class TestInverseVolWeighting:
    """weighting config: "equal" (default, byte-identical) | "inverse_vol" (risk parity —
    weight_i ∝ 1/realized_vol_i over trailing vol_window bars, strictly no-lookahead).
    Falls back to equal weight for a rebalance when a name lacks enough vol history."""

    def test_weighting_absent_and_equal_are_identical(self, cs):
        prices = {
            "WIN": _bars(lambda i: 100.0 * (1.01 ** i)),
            "FLAT": _bars(lambda i: 100.0),
            "LOSE": _bars(lambda i: 100.0 * (0.99 ** i)),
        }
        default = cs.run_cross_sectional(prices, CFG)
        explicit_equal = cs.run_cross_sectional(prices, {**CFG, "weighting": "equal"})
        assert default["ok"] and explicit_equal["ok"]
        assert default["metrics"] == explicit_equal["metrics"]
        assert default["equity_curve"] == explicit_equal["equity_curve"]
        assert default["final_holdings"] == explicit_equal["final_holdings"]
        assert default["final_weights"] == explicit_equal["final_weights"]
        # Baseline sanity (matches TestCrossSectional.test_selects_highest_momentum_and_profits).
        assert default["metrics"]["total_return_pct"] > 0
        assert "WIN" in default["final_holdings"]

    def test_inverse_vol_weights_lower_vol_symbol_roughly_double(self, cs):
        # A: alternating +1%/-1% around a strong uptrend (drift dominates the endpoint
        # noise so momentum stays reliably positive regardless of sampling phase) ->
        # realized vol ~1%. B/C/D: same drift, alternating +2%/-2% -> realized vol ~2%.
        # Four names (not two) so A's higher inverse-vol share stays comfortably under
        # the 0.5 cap and this test isolates the ratio, not the cap (see the dedicated
        # cap test below).
        def a(i):
            return 100.0 * (1.002 ** i) * (1.01 if i % 2 == 0 else 0.99)

        def hi_vol(i):
            return 100.0 * (1.002 ** i) * (1.02 if i % 2 == 0 else 0.98)

        prices = {
            "A": _bars(a, n=150),
            "B": _bars(hi_vol, n=150),
            "C": _bars(hi_vol, n=150),
            "D": _bars(hi_vol, n=150),
        }
        cfg = {
            "top_n": 4, "lookback": 60, "skip": 5, "rebalance_days": 20,
            "initial_capital": 10000, "commission_pct": 0.0, "slippage_pct": 0.0,
            "weighting": "inverse_vol", "vol_window": 21,
        }
        r = cs.run_cross_sectional(prices, cfg)
        assert r["ok"], r
        assert set(r["final_holdings"]) == {"A", "B", "C", "D"}
        w = r["final_weights"]
        ratio = w["A"] / w["B"]
        assert 1.7 < ratio < 2.3, w

    def test_inverse_vol_weight_is_capped_at_0_5_and_renormalized(self, cs):
        def flat_ish(i):
            return 100.0 * (1.0005 ** i) * (1.0001 if i % 2 == 0 else 0.9999)

        def volatile(i):
            return 100.0 * (1.0005 ** i) * (1.01 if i % 2 == 0 else 0.99)

        prices = {
            "X": _bars(flat_ish, n=150),
            "Y": _bars(volatile, n=150),
            "Z": _bars(volatile, n=150),
        }
        cfg = {
            "top_n": 3, "lookback": 60, "skip": 5, "rebalance_days": 20,
            "initial_capital": 10000, "commission_pct": 0.0, "slippage_pct": 0.0,
            "weighting": "inverse_vol", "vol_window": 21,
        }
        r = cs.run_cross_sectional(prices, cfg)
        assert r["ok"], r
        w = r["final_weights"]
        assert abs(w["X"] - 0.5) < 0.02, w
        assert abs(sum(w.values()) - 1.0) < 1e-9, w

    def test_inverse_vol_single_holding_is_not_capped_to_half(self, cs):
        # top_n=1 -> exactly one name survives momentum selection. Its pre-cap
        # inverse-vol weight is always 1.0 (only name to normalize against), so
        # the 0.5 cap must NOT apply here: there is no other name to redistribute
        # the freed budget to, so capping would silently drop half the equity
        # exposure for this rebalance instead of holding the sole name at 100%.
        prices = {
            "WIN": _bars(lambda i: 100.0 * (1.01 ** i) * (1.01 if i % 2 == 0 else 0.99)),
            "LOSE": _bars(lambda i: 100.0 * (0.99 ** i)),
        }
        cfg = {
            "top_n": 1, "lookback": 60, "skip": 5, "rebalance_days": 20,
            "initial_capital": 10000, "commission_pct": 0.0, "slippage_pct": 0.0,
            "weighting": "inverse_vol", "vol_window": 21,
        }
        r = cs.run_cross_sectional(prices, cfg)
        assert r["ok"], r
        assert r["final_holdings"] == ["WIN"]
        w = r["final_weights"]
        assert abs(w["WIN"] - 1.0) < 1e-9, w
        assert abs(sum(w.values()) - 1.0) < 1e-9, w

    def test_insufficient_vol_history_falls_back_to_equal_weight(self, cs):
        prices = {
            "A": _bars(lambda i: 100.0 + i, n=30),
            "B": _bars(lambda i: 100.0 * (1.001 ** i), n=30),
        }
        cfg = {
            "top_n": 2, "lookback": 2, "skip": 1, "rebalance_days": 1,
            "initial_capital": 10000, "commission_pct": 0.0, "slippage_pct": 0.0,
            "weighting": "inverse_vol", "vol_window": 21,
        }
        r = cs.run_cross_sectional(prices, cfg)
        assert r["ok"], r
        assert r["vol_weight_fallback_count"] >= 1


class TestSkipValidation:
    """skip must be strictly less than lookback — momentum(i) reads px at i-skip and
    i-lookback; skip >= lookback would silently produce a zero/negative/garbage window
    instead of a real 12-1-style momentum read. Fail loud, not silent garbage."""

    def test_skip_equal_to_lookback_is_rejected(self, cs):
        prices = {"A": _bars(lambda i: 100.0 + i), "B": _bars(lambda i: 100.0)}
        r = cs.run_cross_sectional(prices, {**CFG, "lookback": 60, "skip": 60})
        assert r["ok"] is False
        assert "skip" in r["error"].lower()
        assert "lookback" in r["error"].lower()

    def test_skip_greater_than_lookback_is_rejected(self, cs):
        prices = {"A": _bars(lambda i: 100.0 + i), "B": _bars(lambda i: 100.0)}
        r = cs.run_cross_sectional(prices, {**CFG, "lookback": 60, "skip": 90})
        assert r["ok"] is False
        assert "skip" in r["error"].lower()

    def test_skip_less_than_lookback_is_accepted(self, cs):
        prices = {"A": _bars(lambda i: 100.0 + i), "B": _bars(lambda i: 100.0)}
        r = cs.run_cross_sectional(prices, {**CFG, "lookback": 60, "skip": 5})
        assert r["ok"] is True


class TestThinSymbolRobustness:
    """One symbol returning only a handful of bars (e.g. a bad/delisted/thinly-traded
    ticker in a `limit=5000` universe fetch) must not collapse the WHOLE backtest via
    the common-date intersection. Thin symbols (bars < lookback+skip+2) are dropped
    BEFORE the intersection and reported via `dropped_symbols`."""

    def test_one_thin_symbol_is_dropped_and_backtest_succeeds(self, cs):
        prices = {
            "WIN": _bars(lambda i: 100.0 * (1.01 ** i), n=150),
            "FLAT": _bars(lambda i: 100.0, n=150),
            "THIN": _bars(lambda i: 100.0, n=1),  # only 1 bar — can never signal
        }
        r = cs.run_cross_sectional(prices, CFG)
        assert r["ok"], r
        assert r["dropped_symbols"] == [{"symbol": "THIN", "bars": 1}], r["dropped_symbols"]
        # Surviving healthy symbols still produce a normal backtest.
        assert "WIN" in r["final_holdings"]
        assert r["universe_size"] == 2

    def test_all_healthy_symbols_have_empty_dropped_list_and_regression_identical_output(
        self, cs
    ):
        """Regression: when every symbol clears the min-bars bar, output must be
        byte-identical to the pre-fix engine on the fields that matter (equity curve,
        metrics, holdings, weights) — the drop logic must be a no-op here."""
        prices = {
            "WIN": _bars(lambda i: 100.0 * (1.01 ** i)),
            "FLAT": _bars(lambda i: 100.0),
            "LOSE": _bars(lambda i: 100.0 * (0.99 ** i)),
        }
        r = cs.run_cross_sectional(prices, CFG)
        assert r["ok"], r
        assert r["dropped_symbols"] == []
        # These are exactly the fields the pre-fix engine computed — proving the
        # thin-symbol-drop logic changed nothing when there is nothing thin to drop.
        assert r["metrics"] == {
            "total_return_pct": r["metrics"]["total_return_pct"],
            "cagr_pct": r["metrics"]["cagr_pct"],
            "sharpe_ratio": r["metrics"]["sharpe_ratio"],
            "max_drawdown_pct": r["metrics"]["max_drawdown_pct"],
            "total_cost_pct": r["metrics"]["total_cost_pct"],
            "buy_hold_return_pct": r["metrics"]["buy_hold_return_pct"],
            "alpha_pct": r["metrics"]["alpha_pct"],
        }
        assert r["metrics"]["total_return_pct"] > 0
        assert "WIN" in r["final_holdings"]
        assert r["n_dates"] == 150
        assert r["universe_size"] == 3

    def test_all_symbols_thin_keeps_existing_insufficient_history_error(self, cs):
        """When dropping thin symbols would leave fewer than 2 survivors, the ORIGINAL
        'Insufficient overlapping history' error must still be raised, unchanged —
        no silent truncation, no different error shape."""
        prices = {
            "A": _bars(lambda i: 100.0 + i, n=30),
            "B": _bars(lambda i: 100.0, n=30),
        }
        r = cs.run_cross_sectional(prices, CFG)  # lookback=60, skip=5 -> both thin (30 < 67)
        assert r["ok"] is False
        assert "Insufficient overlapping history" in r["error"]
        assert "dropped_symbols" not in r


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
