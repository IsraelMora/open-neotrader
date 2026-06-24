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


# ---------------------------------------------------------------------------
# 4. Mark-to-market equity (bar-by-bar), not sampled only at trade closes
# ---------------------------------------------------------------------------
class TestMarkToMarketEquity:
    def test_drawdown_captures_intratrade_dip(self, engine):
        """Equity must be marked to market every bar: a deep dip WHILE holding a
        position counts toward max drawdown even if price recovers before exit.
        Sampling equity only at trade close (the old behaviour) reports ~0%."""
        bars = [
            _bar("2024-01-01", 100.0, 100.0),  # long signal here → fill next open
            _bar("2024-01-02", 100.0, 100.0),  # entry fill at open=100 (≈all equity)
            _bar("2024-01-03", 100.0, 100.0),
            _bar("2024-01-04", 70.0, 70.0),    # ~30% dip while still holding
            _bar("2024-01-05", 75.0, 75.0),
            _bar("2024-01-06", 105.0, 105.0),  # recovers
            _bar("2024-01-07", 106.0, 106.0),  # exit signal → fill next open
            _bar("2024-01-08", 106.0, 106.0),  # exit fill
        ]
        signals = [
            {"symbol": "AAA", "action": "long", "date": "2024-01-01"},
            {"symbol": "AAA", "action": "exit", "date": "2024-01-07"},
        ]
        result = engine.run_backtest(signals, {"AAA": bars}, {"initial_capital": 10000})
        assert result.total_trades == 1
        # Position is ~100% of equity; a 30% intra-hold dip → ~30% drawdown.
        assert result.max_drawdown_pct > 20.0

    def test_equity_curve_has_a_point_per_bar(self, engine):
        """The equity curve is daily (one mark-to-market point per bar of the
        backtest span), not just entry/exit snapshots."""
        bars = _series(datetime.date(2024, 1, 1), 12, lambda i: 100.0, lambda i: 100.0 + i)
        signals = [
            {"symbol": "AAA", "action": "long", "date": bars[0]["date"]},
            {"symbol": "AAA", "action": "exit", "date": bars[10]["date"]},
        ]
        result = engine.run_backtest(signals, {"AAA": bars}, {"initial_capital": 10000})
        # 12 bars → at least ~one equity point per bar (old engine produced ~2-3).
        assert len(result.equity_curve) >= 10


# ---------------------------------------------------------------------------
# 4b. Capital exhaustion must not crash (no division by zero)
# ---------------------------------------------------------------------------
class TestCapitalExhaustion:
    def test_second_symbol_when_capital_exhausted_does_not_crash(self, engine):
        """If the first long consumes all capital, a second concurrent long has
        zero funds. The engine must skip it gracefully — never open a zero-cost
        position (which would later divide by zero in pnl_pct)."""
        a = [_bar("2024-01-01", 100.0, 100.0), _bar("2024-01-02", 100.0, 100.0),
             _bar("2024-01-03", 110.0, 110.0), _bar("2024-01-04", 110.0, 110.0)]
        b = [_bar("2024-01-01", 50.0, 50.0), _bar("2024-01-02", 50.0, 50.0),
             _bar("2024-01-03", 55.0, 55.0), _bar("2024-01-04", 55.0, 55.0)]
        signals = [
            {"symbol": "A", "action": "long", "date": "2024-01-01"},
            {"symbol": "B", "action": "long", "date": "2024-01-01"},
            {"symbol": "A", "action": "exit", "date": "2024-01-03"},
            {"symbol": "B", "action": "exit", "date": "2024-01-03"},
        ]
        # initial_capital fully absorbed by A → B cannot be funded.
        result = engine.run_backtest(signals, {"A": a, "B": b}, {"initial_capital": 100})
        # No exception, and the unfunded symbol simply produced no trade.
        assert result.total_trades == 1


# ---------------------------------------------------------------------------
# 5. Buy & hold benchmark + alpha (does the strategy beat just holding?)
# ---------------------------------------------------------------------------
class TestBuyAndHoldBenchmark:
    def test_single_symbol_buy_hold_return(self, engine):
        """B&H = buy at the first bar's open, hold to the last bar's close.
        First open 100 → last close 150 ⇒ +50%, regardless of strategy trades."""
        bars = [
            _bar("2024-01-01", 100.0, 100.0),
            _bar("2024-01-02", 120.0, 120.0),
            _bar("2024-01-03", 140.0, 150.0),
        ]
        # No trades at all; benchmark must still be computed from prices.
        result = engine.run_backtest([], {"AAA": bars}, {"initial_capital": 10000})
        assert result.buy_hold_return_pct == pytest.approx(50.0, abs=0.01)

    def test_alpha_is_strategy_minus_buy_hold(self, engine):
        """Alpha = strategy total return − buy & hold return. A strategy that sits
        out a rising market has NEGATIVE alpha even if it never loses money."""
        bars = [
            _bar("2024-01-01", 100.0, 100.0),
            _bar("2024-01-02", 150.0, 200.0),  # market doubles
            _bar("2024-01-03", 200.0, 200.0),
        ]
        result = engine.run_backtest([], {"AAA": bars}, {"initial_capital": 10000})
        # Flat strategy (0%) in a +100% market ⇒ alpha ≈ -100%.
        assert result.buy_hold_return_pct == pytest.approx(100.0, abs=0.01)
        assert result.alpha_pct == pytest.approx(result.total_return_pct - result.buy_hold_return_pct, abs=0.01)
        assert result.alpha_pct < 0.0

    def test_multi_symbol_buy_hold_is_equal_weight(self, engine):
        """A basket B&H is the equal-weight average of per-symbol returns:
        one symbol +50%, one −10% ⇒ +20%."""
        up = [_bar("2024-01-01", 100.0, 100.0), _bar("2024-01-02", 150.0, 150.0)]
        down = [_bar("2024-01-01", 100.0, 100.0), _bar("2024-01-02", 90.0, 90.0)]
        result = engine.run_backtest([], {"UP": up, "DOWN": down}, {"initial_capital": 10000})
        assert result.buy_hold_return_pct == pytest.approx(20.0, abs=0.01)
