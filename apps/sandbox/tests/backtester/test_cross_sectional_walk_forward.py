"""
TDD tests for plugins/backtester/scripts/walk_forward.py —
run_cross_sectional_walk_forward() (portfolio-level anchored walk-forward).

RED phase:  fails because run_cross_sectional_walk_forward doesn't exist.
GREEN phase: passes after implementation.

Run: cd apps/sandbox && python3 -m pytest tests/backtester/test_cross_sectional_walk_forward.py -v
"""
from __future__ import annotations

import datetime
import importlib.util
import statistics
import sys
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).parents[4]
_PLUGIN_DIR = _REPO_ROOT / "plugins" / "backtester"
_SCRIPTS_DIR = _PLUGIN_DIR / "scripts"


def load_walk_forward():
    """Load scripts/walk_forward.py as a fresh module (scripts/ on sys.path so its
    own `from cross_sectional import run_cross_sectional` import resolves)."""
    scripts_str = str(_SCRIPTS_DIR)
    if scripts_str not in sys.path:
        sys.path.insert(0, scripts_str)
    spec = importlib.util.spec_from_file_location(
        "backtester_walk_forward_cs",
        str(_SCRIPTS_DIR / "walk_forward.py"),
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


@pytest.fixture
def wf():
    return load_walk_forward()


def _bars(fn, n, start=datetime.date(2023, 1, 1)):
    out = []
    for i in range(n):
        d = (start + datetime.timedelta(days=i)).isoformat()
        p = fn(i)
        out.append({"date": d, "open": p, "high": p, "low": p, "close": p, "volume": 1000.0})
    return out


# A clean regime change: strong uptrend for the first half, sharp reversal for the
# second half — lets us reason about which fold lands in-trend vs post-reversal.
def _regime_change(n=300, split=180):
    def up_then_down(i):
        if i < split:
            return 100.0 * (1.01 ** i)
        peak = 100.0 * (1.01 ** split)
        return peak * (0.99 ** (i - split))

    return up_then_down


CS_CFG = {
    "top_n": 1, "lookback": 30, "skip": 3, "rebalance_days": 10,
    "initial_capital": 10000, "commission_pct": 0.0, "slippage_pct": 0.0,
    "n_windows": 3, "in_sample_pct": 0.7,
}


class TestAnchoredWindowing:
    def test_windows_are_anchored_is_always_starts_at_zero(self, wf):
        prices = {
            "A": _bars(_regime_change(), n=300),
            "B": _bars(lambda i: 100.0, n=300),
        }
        r = wf.run_cross_sectional_walk_forward(prices, CS_CFG)
        assert r["ok"], r
        assert len(r["windows"]) >= 1
        for window in r["windows"]:
            assert window["is_start"] == 0
        # IS end grows monotonically across folds (anchored, not rolling).
        is_ends = [w["is_end"] for w in r["windows"]]
        assert is_ends == sorted(is_ends)
        assert len(set(is_ends)) == len(is_ends)  # strictly increasing, no repeats

    def test_oos_windows_are_contiguous_and_slide_forward(self, wf):
        prices = {
            "A": _bars(_regime_change(), n=300),
            "B": _bars(lambda i: 100.0, n=300),
        }
        r = wf.run_cross_sectional_walk_forward(prices, CS_CFG)
        assert r["ok"], r
        for w in r["windows"]:
            assert w["is_end"] == w["oos_start"]  # IS/OOS boundary, no gap
            assert w["oos_start"] < w["oos_end"]
        oos_starts = [w["oos_start"] for w in r["windows"]]
        assert oos_starts == sorted(oos_starts)
        assert r["windows"][-1]["oos_end"] == 300  # last window reaches the end


class TestNoLookahead:
    def test_oos_result_unaffected_by_corrupting_data_outside_its_own_window(self, wf):
        """Corrupt every bar OUTSIDE a given window's [oos_start, oos_end) range with an
        extreme sentinel price, and prove that window's OOS result is identical to the
        clean-data run — the OOS backtest for a window must only ever see its own
        sliced bars, never IS data or other-window data."""
        n = 300
        clean = {
            "A": _bars(_regime_change(n=n), n=n),
            "B": _bars(lambda i: 100.0, n=n),
        }
        clean_result = wf.run_cross_sectional_walk_forward(clean, CS_CFG)
        assert clean_result["ok"] and clean_result["windows"]

        target = clean_result["windows"][0]
        oos_start, oos_end = target["oos_start"], target["oos_end"]

        SENTINEL = 1e9

        def corrupt_outside(bars: list[dict]) -> list[dict]:
            out = []
            for i, b in enumerate(bars):
                if oos_start <= i < oos_end:
                    out.append(b)
                else:
                    out.append({**b, "open": SENTINEL, "high": SENTINEL,
                                "low": SENTINEL, "close": SENTINEL})
            return out

        corrupted = {sym: corrupt_outside(bars) for sym, bars in clean.items()}
        corrupted_result = wf.run_cross_sectional_walk_forward(corrupted, CS_CFG)
        assert corrupted_result["ok"]

        corrupted_target = next(
            w for w in corrupted_result["windows"] if w["window_idx"] == target["window_idx"]
        )
        assert corrupted_target["oos_sharpe"] == target["oos_sharpe"]
        assert corrupted_target["oos_cagr_pct"] == target["oos_cagr_pct"]
        assert corrupted_target["oos_total_return_pct"] == target["oos_total_return_pct"]

    def test_oos_call_receives_only_its_own_date_range(self, wf, monkeypatch):
        """Directly assert the date range passed into run_cross_sectional for the OOS
        call of each window never includes dates from before its own oos_start index."""
        n = 300
        prices = {
            "A": _bars(_regime_change(n=n), n=n),
            "B": _bars(lambda i: 100.0, n=n),
        }
        calls = []
        real_run_cross_sectional = wf.run_cross_sectional

        def spy(px, cfg, _context=None):
            calls.append({sym: [b["date"] for b in bars] for sym, bars in px.items()})
            return real_run_cross_sectional(px, cfg)

        monkeypatch.setattr(wf, "run_cross_sectional", spy)

        r = wf.run_cross_sectional_walk_forward(prices, CS_CFG)
        assert r["ok"]
        # 2 calls per window (IS, OOS) in window order.
        assert len(calls) == 2 * len(r["windows"])
        for idx, window in enumerate(r["windows"]):
            is_dates = calls[2 * idx]["A"]
            oos_dates = calls[2 * idx + 1]["A"]
            all_dates = [b["date"] for b in prices["A"]]
            expected_is = all_dates[: window["is_end"]]
            expected_oos = all_dates[window["oos_start"]: window["oos_end"]]
            assert is_dates == expected_is
            assert oos_dates == expected_oos
            # No overlap between IS and OOS date sets passed in.
            assert not (set(is_dates) & set(oos_dates))


class TestAggregateMath:
    def test_mean_median_and_pct_positive_are_exact_on_hand_computed_windows(self, wf, monkeypatch):
        """Force run_cross_sectional to return controlled metrics per call so the
        aggregation math (mean/median oos_sharpe, pct_positive_oos_windows,
        robust_windows) can be checked against hand-computed expected values."""
        n = 300
        prices = {
            "A": _bars(lambda i: 100.0 + i, n=n),
            "B": _bars(lambda i: 100.0, n=n),
        }
        # window 0: is_sharpe=1.0, oos_sharpe=0.6 -> ratio 0.6 (robust, >=0.5), return>0
        # window 1: is_sharpe=1.0, oos_sharpe=0.2 -> ratio 0.2 (not robust), return>0
        # window 2: is_sharpe=1.0, oos_sharpe=-0.5 -> ratio -0.5 (not robust), return<0
        def _m(sharpe, cagr, max_dd, total_ret):
            return {
                "ok": True,
                "metrics": {
                    "sharpe_ratio": sharpe,
                    "cagr_pct": cagr,
                    "max_drawdown_pct": max_dd,
                    "total_return_pct": total_ret,
                },
            }

        scripted = [
            _m(1.0, 5.0, 2.0, 5.0),   # window 0 IS
            _m(0.6, 3.0, 1.0, 3.0),   # window 0 OOS
            _m(1.0, 5.0, 2.0, 5.0),   # window 1 IS
            _m(0.2, 1.0, 4.0, 1.0),   # window 1 OOS
            _m(1.0, 5.0, 2.0, 5.0),   # window 2 IS
            _m(-0.5, -3.0, 8.0, -3.0),  # window 2 OOS
        ]
        calls = iter(scripted)
        monkeypatch.setattr(wf, "run_cross_sectional", lambda px, cfg, _context=None: next(calls))

        r = wf.run_cross_sectional_walk_forward(prices, CS_CFG)
        assert r["ok"], r
        assert r["total_windows"] == 3
        oos_sharpes = [0.6, 0.2, -0.5]
        assert r["avg_oos_sharpe"] == round(sum(oos_sharpes) / 3, 3)
        assert r["median_oos_sharpe"] == round(statistics.median(oos_sharpes), 3)
        assert r["robust_windows"] == 1  # only window 0 (ratio 0.6 >= 0.5)
        assert r["summary"]["pct_positive_oos_windows"] == round(2 / 3, 3)  # windows 0,1 positive
        assert r["verdict"] == "SOBREAJUSTADO"  # 1/3 robust < 50%


class TestConfigPassthrough:
    def test_top_n_lookback_skip_vol_target_weighting_regime_reach_every_window(
        self, wf, monkeypatch
    ):
        prices = {
            "A": _bars(_regime_change(n=300), n=300),
            "B": _bars(lambda i: 100.0, n=300),
        }
        cfg = {
            **CS_CFG,
            "top_n": 2,
            "lookback": 25,
            "skip": 2,
            "vol_target": 0.15,
            "weighting": "inverse_vol",
            "regime_filter": True,
            "regime_min_breadth": 0.4,
        }
        real_run_cross_sectional = wf.run_cross_sectional
        seen_configs = []

        def spy(px, passed_cfg, _context=None):
            seen_configs.append(passed_cfg)
            return real_run_cross_sectional(px, passed_cfg)

        monkeypatch.setattr(wf, "run_cross_sectional", spy)
        r = wf.run_cross_sectional_walk_forward(prices, cfg)
        assert r["ok"], r
        assert seen_configs, "expected at least one window to run"
        for passed_cfg in seen_configs:
            assert passed_cfg["top_n"] == 2
            assert passed_cfg["lookback"] == 25
            assert passed_cfg["skip"] == 2
            assert passed_cfg["vol_target"] == 0.15
            assert passed_cfg["weighting"] == "inverse_vol"
            assert passed_cfg["regime_filter"] is True
            assert passed_cfg["regime_min_breadth"] == 0.4


class TestValidation:
    def test_lookback_greater_or_equal_to_smallest_is_window_is_rejected(self, wf):
        prices = {
            "A": _bars(lambda i: 100.0 + i, n=100),
            "B": _bars(lambda i: 100.0, n=100),
        }
        # n=100, in_sample_pct=0.7 -> oos_total=30, n_windows=3 -> oos_per_window=10
        # smallest_is_end_idx = 100 - 3*10 = 70. lookback=70 should be rejected.
        cfg = {**CS_CFG, "n_windows": 3, "in_sample_pct": 0.7, "lookback": 70}
        r = wf.run_cross_sectional_walk_forward(prices, cfg)
        assert r["ok"] is True  # mirrors run_walk_forward's INSUFICIENTE_DATOS shape
        assert r["verdict"] == "INSUFICIENTE_DATOS"
        assert "lookback" in r["summary"]["error"].lower()

    def test_lookback_below_the_floor_is_accepted(self, wf):
        prices = {
            "A": _bars(lambda i: 100.0 + i, n=100),
            "B": _bars(lambda i: 100.0, n=100),
        }
        cfg = {**CS_CFG, "n_windows": 3, "in_sample_pct": 0.7, "lookback": 10, "skip": 1}
        r = wf.run_cross_sectional_walk_forward(prices, cfg)
        assert r["ok"] is True
        assert "error" not in r["summary"]

    def test_no_price_data_is_insuficiente_datos(self, wf):
        r = wf.run_cross_sectional_walk_forward({}, CS_CFG)
        assert r["ok"] is True
        assert r["verdict"] == "INSUFICIENTE_DATOS"

    def test_too_few_total_bars_is_insuficiente_datos(self, wf):
        prices = {"A": _bars(lambda i: 100.0 + i, n=10), "B": _bars(lambda i: 100.0, n=10)}
        r = wf.run_cross_sectional_walk_forward(prices, CS_CFG)
        assert r["ok"] is True
        assert r["verdict"] == "INSUFICIENTE_DATOS"
