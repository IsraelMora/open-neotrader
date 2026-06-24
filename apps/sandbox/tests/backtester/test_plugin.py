"""
TDD tests for plugins/backtester/plugin.py — run() skill.

RED phase: fails because plugin.py does not exist yet.
GREEN phase: passes after plugin.py is implemented.
Run: cd apps/sandbox && python3 -m pytest tests/backtester/test_plugin.py -v
"""
from __future__ import annotations

import datetime
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from .conftest import load_plugin

_REPO_ROOT = Path(__file__).parents[4]


@pytest.fixture(scope="module")
def plugin():
    return load_plugin()


def _make_ctx() -> MagicMock:
    ctx = MagicMock()
    ctx.metadata = {}
    return ctx


def _make_bars_uptrend(n: int, start_price: float = 100.0) -> list[dict]:
    """
    Accelerating (quadratic) rise → EMA, MACD and Ichimoku all turn bullish,
    so trend-following emits a confirmed long. Needs n >= 78 (senkou_b+kijun).
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


def _make_bars_mild(n: int, start_price: float = 100.0) -> list[dict]:
    """Mild linear uptrend — used for zero-trade tests (no EMA signal)."""
    bars = []
    price = start_price
    for i in range(n):
        date = (datetime.date(2023, 1, 1) + datetime.timedelta(days=i)).isoformat()
        close = price + (i * 0.1)
        bars.append({
            "date": date,
            "open": close - 0.2,
            "high": close + 0.3,
            "low": close - 0.4,
            "close": close,
            "volume": 1000.0,
        })
    return bars


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------
class TestRunHappyPath:
    def test_returns_dict_with_ok_true(self, plugin):
        prices = {"AAPL": _make_bars_uptrend(150)}
        result = plugin.run(
            strategy_id="trend-following",
            prices=prices,
            config={"initial_capital": 10000},
            _context=_make_ctx(),
        )
        assert isinstance(result, dict)
        assert result["ok"] is True

    def test_result_has_metrics(self, plugin):
        prices = {"AAPL": _make_bars_uptrend(150)}
        result = plugin.run(
            strategy_id="trend-following",
            prices=prices,
            config={"initial_capital": 10000},
            _context=_make_ctx(),
        )
        metrics = result["metrics"]
        for key in ("total_return_pct", "sharpe_ratio", "max_drawdown_pct", "win_rate_pct", "profit_factor"):
            assert key in metrics, f"Missing metric: {key}"

    def test_result_has_equity_curve(self, plugin):
        prices = {"AAPL": _make_bars_uptrend(150)}
        result = plugin.run(
            strategy_id="trend-following",
            prices=prices,
            config={"initial_capital": 10000},
            _context=_make_ctx(),
        )
        assert "equity_curve" in result
        assert isinstance(result["equity_curve"], list)

    def test_result_has_trades(self, plugin):
        prices = {"AAPL": _make_bars_uptrend(150)}
        result = plugin.run(
            strategy_id="trend-following",
            prices=prices,
            config={"initial_capital": 10000},
            _context=_make_ctx(),
        )
        assert "trades" in result
        assert isinstance(result["trades"], list)

    def test_rsi_strategy_also_works(self, plugin):
        """RSI adapter must be reachable through run()."""
        bars = []
        for i in range(60):
            price = max(100.0 - i * 2.5, 1.0)
            date = (datetime.date(2023, 1, 1) + datetime.timedelta(days=i)).isoformat()
            bars.append({
                "date": date,
                "open": price + 0.5,
                "high": price + 1.0,
                "low": max(price - 1.0, 0.1),
                "close": price,
                "volume": 1000.0,
            })
        prices = {"TEST": bars}
        result = plugin.run(
            strategy_id="mean-reversion",
            prices=prices,
            config={"initial_capital": 5000, "oversold": 35.0, "confirmation_bars": 1},
            _context=_make_ctx(),
        )
        assert result["ok"] is True


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------
class TestRunEdgeCases:
    def test_empty_prices_returns_error(self, plugin):
        result = plugin.run(
            strategy_id="trend-following",
            prices={},
            config={},
            _context=_make_ctx(),
        )
        assert result["ok"] is False
        assert "error" in result

    def test_empty_bars_for_symbol_returns_error(self, plugin):
        result = plugin.run(
            strategy_id="trend-following",
            prices={"AAPL": []},
            config={},
            _context=_make_ctx(),
        )
        assert result["ok"] is False

    def test_all_neutral_signals_returns_ok_with_zero_trades(self, plugin):
        """Too few bars → no signals → zero trades → still ok=True with valid metrics."""
        prices = {"AAPL": _make_bars_mild(20)}  # 20 bars < 78 minimum for trend-following
        result = plugin.run(
            strategy_id="trend-following",
            prices=prices,
            config={"initial_capital": 10000},
            _context=_make_ctx(),
        )
        assert result["ok"] is True
        assert result["metrics"]["total_trades"] == 0

    def test_unknown_strategy_returns_error(self, plugin):
        prices = {"AAPL": _make_bars_mild(100)}
        result = plugin.run(
            strategy_id="not-real",
            prices=prices,
            config={},
            _context=_make_ctx(),
        )
        assert result["ok"] is False
        assert "not-real" in result["error"] or "Unknown" in result["error"]

    def test_multi_symbol_prices(self, plugin):
        """run() must handle multiple symbols in the prices dict."""
        prices = {
            "AAPL": _make_bars_uptrend(150, start_price=150.0),
            "MSFT": _make_bars_uptrend(150, start_price=300.0),
        }
        result = plugin.run(
            strategy_id="trend-following",
            prices=prices,
            config={"initial_capital": 10000},
            _context=_make_ctx(),
        )
        assert result["ok"] is True
