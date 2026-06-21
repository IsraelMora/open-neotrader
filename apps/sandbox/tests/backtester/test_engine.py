"""
TDD tests for plugins/backtester/scripts/engine.py correctness.

These pin down three correctness fixes that matter for HONEST profitability:
  1. Execution fills at the NEXT bar's open (no same-bar-close lookahead).
  2. CAGR is annualized over the price series' CALENDAR span, not trade count.
  3. time_in_market_pct reflects real exposure (sum of trade durations / span).

Run: cd apps/sandbox && python3 -m pytest tests/backtester/test_engine.py -v
"""
from __future__ import annotations

import datetime
import importlib.util
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).parents[4]
_ENGINE_PATH = _REPO_ROOT / "plugins" / "backtester" / "scripts" / "engine.py"


def _load_engine():
    spec = importlib.util.spec_from_file_location("backtester_engine_under_test", str(_ENGINE_PATH))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


@pytest.fixture(scope="module")
def engine():
    return _load_engine()


def _bar(date: str, open_: float, close: float) -> dict:
    return {"date": date, "open": open_, "high": max(open_, close) + 1, "low": min(open_, close) - 1, "close": close, "volume": 1000.0}


def _series(start: datetime.date, n: int, open_fn, close_fn) -> list[dict]:
    bars = []
    for i in range(n):
        d = (start + datetime.timedelta(days=i)).isoformat()
        bars.append(_bar(d, open_fn(i), close_fn(i)))
    return bars


# ---------------------------------------------------------------------------
# 1. Execution at next-bar open (no same-bar-close lookahead)
# ---------------------------------------------------------------------------
class TestNextBarOpenExecution:
    def test_entry_and_exit_fill_at_next_bar_open(self, engine):
        bars = [
            _bar("2024-01-01", open_=100.0, close=110.0),
            _bar("2024-01-02", open_=111.0, close=112.0),
            _bar("2024-01-03", open_=113.0, close=114.0),
        ]
        signals = [
            {"symbol": "AAA", "action": "long", "date": "2024-01-01"},
            {"symbol": "AAA", "action": "exit", "date": "2024-01-02"},
        ]
        result = engine.run_backtest(signals, {"AAA": bars}, {"initial_capital": 10000})
        assert result.total_trades == 1
        trade = result.trades[0]
        # Long decided on 01-01 close → filled at 01-02 open (111), NOT 01-01 close (110)
        assert trade["entry_price"] == pytest.approx(111.0)
        # Exit decided on 01-02 close → filled at 01-03 open (113), NOT 01-02 close (112)
        assert trade["exit_price"] == pytest.approx(113.0)

    def test_signal_on_last_bar_cannot_fill(self, engine):
        """A signal on the final bar has no next bar to fill on → no trade opened."""
        bars = [
            _bar("2024-01-01", 100.0, 100.0),
            _bar("2024-01-02", 100.0, 100.0),
        ]
        signals = [{"symbol": "AAA", "action": "long", "date": "2024-01-02"}]  # last bar
        result = engine.run_backtest(signals, {"AAA": bars}, {"initial_capital": 10000})
        assert result.total_trades == 0


# ---------------------------------------------------------------------------
# 2. CAGR annualized over calendar span (not trade count)
# ---------------------------------------------------------------------------
class TestCagrUsesCalendarSpan:
    def _run_over_span(self, engine, days: int):
        # Flat price except a step up: enter, hold, exit — identical return regardless of span.
        start = datetime.date(2024, 1, 1)
        bars = [
            _bar(start.isoformat(), 100.0, 100.0),
            _bar((start + datetime.timedelta(days=1)).isoformat(), 100.0, 100.0),
            _bar((start + datetime.timedelta(days=2)).isoformat(), 120.0, 120.0),
            _bar((start + datetime.timedelta(days=days - 1)).isoformat(), 120.0, 120.0),
        ]
        signals = [
            {"symbol": "AAA", "action": "long", "date": bars[0]["date"]},
            {"symbol": "AAA", "action": "exit", "date": bars[1]["date"]},
        ]
        return engine.run_backtest(signals, {"AAA": bars}, {"initial_capital": 10000})

    def test_same_return_longer_span_has_lower_cagr(self, engine):
        one_year = self._run_over_span(engine, 365)
        four_years = self._run_over_span(engine, 365 * 4)
        # Same trades / same total return, but CAGR must shrink with a longer calendar span.
        assert one_year.total_return_pct == pytest.approx(four_years.total_return_pct, abs=0.5)
        assert four_years.cagr_pct < one_year.cagr_pct - 1.0

    def test_one_year_span_cagr_close_to_total_return(self, engine):
        r = self._run_over_span(engine, 366)
        # Over ~1 year, CAGR ≈ total return (not a trade-count artifact).
        assert r.cagr_pct == pytest.approx(r.total_return_pct, rel=0.15)


# ---------------------------------------------------------------------------
# 3. time_in_market_pct reflects real exposure
# ---------------------------------------------------------------------------
class TestTimeInMarket:
    def test_short_hold_over_long_span_is_low(self, engine):
        # 100-day span, position held ~10 days → exposure ~10%, NOT 50%.
        start = datetime.date(2024, 1, 1)
        bars = _series(start, 100, lambda i: 100.0, lambda i: 100.0)
        entry_date = bars[0]["date"]
        exit_date = bars[11]["date"]  # fills next-bar: long@bar1open .. exit@bar12open ≈ 10-11 days
        signals = [
            {"symbol": "AAA", "action": "long", "date": entry_date},
            {"symbol": "AAA", "action": "exit", "date": exit_date},
        ]
        result = engine.run_backtest(signals, {"AAA": bars}, {"initial_capital": 10000})
        assert result.total_trades == 1
        assert result.time_in_market_pct < 25.0
        assert result.time_in_market_pct > 0.0
