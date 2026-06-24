"""
TDD tests for plugins/backtester/scripts/walk_forward.py
and plugins/backtester/plugin.py — run_walk_forward() skill.

RED phase:  fails because walk_forward.py and run_walk_forward() don't exist.
GREEN phase: passes after implementation.

Run: cd apps/sandbox && python3 -m pytest tests/backtester/test_walk_forward.py -v
"""
from __future__ import annotations

import datetime
import importlib.util
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from .conftest import load_plugin

_REPO_ROOT = Path(__file__).parents[4]
_PLUGIN_DIR = _REPO_ROOT / "plugins" / "backtester"
_SCRIPTS_DIR = _PLUGIN_DIR / "scripts"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_walk_forward():
    """Load scripts/walk_forward.py as a fresh module."""
    scripts_str = str(_SCRIPTS_DIR)
    if scripts_str not in sys.path:
        sys.path.insert(0, scripts_str)
    spec = importlib.util.spec_from_file_location(
        "backtester_walk_forward",
        str(_SCRIPTS_DIR / "walk_forward.py"),
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def _make_bars_uptrend(n: int, start_price: float = 100.0) -> list[dict]:
    """
    Accelerating quadratic uptrend.
    close(i) = start + 0.5*i + 0.02*i*i  → same as test_plugin.py.

    trend-following (Ichimoku + EMA) needs ≥ 78 bars; using ≥ 150 bars
    so n_windows=3 walk-forward still has large enough IS windows.
    """
    bars = []
    for i in range(n):
        close = start_price + 0.5 * i + 0.02 * i * i
        date = (datetime.date(2023, 1, 1) + datetime.timedelta(days=i)).isoformat()
        bars.append({
            "date": date,
            "open": close - 0.2,
            "high": close + 0.5,
            "low": close - 0.5,
            "close": close,
            "volume": 1000.0,
        })
    return bars


def _make_ctx() -> MagicMock:
    ctx = MagicMock()
    ctx.metadata = {}
    return ctx


# ---------------------------------------------------------------------------
# walk_forward module — pure-function tests
# ---------------------------------------------------------------------------

class TestWalkForwardModule:
    @pytest.fixture(scope="class")
    def wf(self):
        return load_walk_forward()

    def test_run_walk_forward_returns_windows(self, wf):
        """run_walk_forward() over a multi-window series populates windows list."""
        bars = _make_bars_uptrend(300)
        result = wf.run_walk_forward(
            strategy_id="trend-following",
            prices={"SYM": bars},
            config={"n_windows": 3, "in_sample_pct": 0.7, "min_trades": 0},
        )
        assert result["ok"] is True
        windows = result["windows"]
        assert isinstance(windows, list)
        assert len(windows) >= 1

    def test_each_window_has_is_and_oos_metrics(self, wf):
        """Each window dict must carry is_sharpe and oos_sharpe."""
        bars = _make_bars_uptrend(300)
        result = wf.run_walk_forward(
            strategy_id="trend-following",
            prices={"SYM": bars},
            config={"n_windows": 3, "in_sample_pct": 0.7, "min_trades": 0},
        )
        for w in result["windows"]:
            assert "is_sharpe" in w, f"Missing is_sharpe in window: {w}"
            assert "oos_sharpe" in w, f"Missing oos_sharpe in window: {w}"
            assert "is_trades" in w
            assert "oos_trades" in w
            assert "robustness_ratio" in w

    def test_robustness_ratio_computation(self, wf):
        """
        compute_robustness_ratio(oos_sharpe, is_sharpe) must equal
        oos_sharpe / is_sharpe when |is_sharpe| > threshold, else 0.
        """
        assert wf.compute_robustness_ratio(1.0, 2.0) == pytest.approx(0.5)
        assert wf.compute_robustness_ratio(1.5, 3.0) == pytest.approx(0.5)
        # is_sharpe near zero → 0
        assert wf.compute_robustness_ratio(1.0, 0.0) == pytest.approx(0.0)
        assert wf.compute_robustness_ratio(1.0, 0.005) == pytest.approx(0.0)

    def test_verdict_robusto(self, wf):
        """≥50% robust windows → ROBUSTO."""
        verdict = wf.compute_verdict(robust_count=3, total_valid=4)
        assert verdict == "ROBUSTO"

    def test_verdict_sobreajustado(self, wf):
        """<50% robust windows → SOBREAJUSTADO."""
        verdict = wf.compute_verdict(robust_count=1, total_valid=4)
        assert verdict == "SOBREAJUSTADO"

    def test_verdict_insuficiente_datos_few_windows(self, wf):
        """< 2 valid windows → INSUFICIENTE_DATOS."""
        verdict = wf.compute_verdict(robust_count=1, total_valid=1)
        assert verdict == "INSUFICIENTE_DATOS"

    def test_verdict_insuficiente_datos_zero_windows(self, wf):
        """0 valid windows → INSUFICIENTE_DATOS."""
        verdict = wf.compute_verdict(robust_count=0, total_valid=0)
        assert verdict == "INSUFICIENTE_DATOS"

    def test_too_little_data_returns_insuficiente(self, wf):
        """Fewer than 60 bars → INSUFICIENTE_DATOS, no crash."""
        bars = _make_bars_uptrend(30)
        result = wf.run_walk_forward(
            strategy_id="trend-following",
            prices={"SYM": bars},
            config={},
        )
        assert result["ok"] is True
        assert result["verdict"] == "INSUFICIENTE_DATOS"
        assert result["windows"] == []

    def test_top_level_fields_present(self, wf):
        """Result must include n_windows, avg_oos_sharpe, avg_robustness_ratio, verdict."""
        bars = _make_bars_uptrend(300)
        result = wf.run_walk_forward(
            strategy_id="trend-following",
            prices={"SYM": bars},
            config={"n_windows": 3, "in_sample_pct": 0.7, "min_trades": 0},
        )
        for key in ("n_windows", "avg_oos_sharpe", "avg_robustness_ratio", "verdict", "windows"):
            assert key in result, f"Missing key: {key}"


# ---------------------------------------------------------------------------
# plugin.py — run_walk_forward() skill
# ---------------------------------------------------------------------------

class TestPluginRunWalkForward:
    @pytest.fixture(scope="class")
    def plugin(self):
        return load_plugin()

    def test_run_walk_forward_exists(self, plugin):
        """plugin must expose run_walk_forward callable."""
        assert callable(getattr(plugin, "run_walk_forward", None))

    def test_basic_happy_path(self, plugin):
        bars = _make_bars_uptrend(300)
        result = plugin.run_walk_forward(
            strategy_id="trend-following",
            prices={"AAPL": bars},
            config={"n_windows": 3, "in_sample_pct": 0.7, "min_trades": 0},
            _context=_make_ctx(),
        )
        assert result["ok"] is True
        assert "windows" in result
        assert "verdict" in result
        assert isinstance(result["windows"], list)

    def test_verdict_is_one_of_three_values(self, plugin):
        bars = _make_bars_uptrend(300)
        result = plugin.run_walk_forward(
            strategy_id="trend-following",
            prices={"AAPL": bars},
            config={"n_windows": 3, "in_sample_pct": 0.7, "min_trades": 0},
            _context=_make_ctx(),
        )
        assert result["verdict"] in ("ROBUSTO", "SOBREAJUSTADO", "INSUFICIENTE_DATOS")

    def test_too_little_data_no_crash(self, plugin):
        bars = _make_bars_uptrend(20)
        result = plugin.run_walk_forward(
            strategy_id="trend-following",
            prices={"AAPL": bars},
            config={},
            _context=_make_ctx(),
        )
        assert result["ok"] is True
        assert result["verdict"] == "INSUFICIENTE_DATOS"

    def test_empty_prices_returns_error(self, plugin):
        result = plugin.run_walk_forward(
            strategy_id="trend-following",
            prices={},
            config={},
            _context=_make_ctx(),
        )
        assert result["ok"] is False
        assert "error" in result

    def test_unknown_strategy_returns_error(self, plugin):
        bars = _make_bars_uptrend(200)
        result = plugin.run_walk_forward(
            strategy_id="not-a-real-strategy",
            prices={"SYM": bars},
            config={},
            _context=_make_ctx(),
        )
        assert result["ok"] is False
        assert "error" in result

    def test_robustness_ratio_in_windows(self, plugin):
        """Every window in the result must carry a robustness_ratio field."""
        bars = _make_bars_uptrend(300)
        result = plugin.run_walk_forward(
            strategy_id="trend-following",
            prices={"AAPL": bars},
            config={"n_windows": 3, "in_sample_pct": 0.7, "min_trades": 0},
            _context=_make_ctx(),
        )
        for w in result["windows"]:
            assert "robustness_ratio" in w
