"""
TDD tests for plugins/backtester/scripts/generate.py.

RED phase: all tests fail because generate.py does not exist yet.
GREEN phase: tests pass after generate.py is implemented.
Run: cd apps/sandbox && python3 -m pytest tests/backtester/test_generate.py -v
"""
from __future__ import annotations

import datetime
import os
import sys
from pathlib import Path

import pytest

from .conftest import load_generate

_REPO_ROOT = Path(__file__).parents[4]


# ---------------------------------------------------------------------------
# Fixture: load generate module fresh per test session
# ---------------------------------------------------------------------------
@pytest.fixture(scope="module")
def gen():
    return load_generate()


# ---------------------------------------------------------------------------
# normalize_bars
# ---------------------------------------------------------------------------
class TestNormalizeBars:
    def test_strips_time_from_ts(self, gen):
        raw = [{"ts": "2024-01-15T00:00:00Z", "open": 100.0, "high": 101.0, "low": 99.0, "close": 100.5, "volume": 1000}]
        result = gen.normalize_bars(raw)
        assert result[0]["date"] == "2024-01-15"

    def test_strips_time_offset_variant(self, gen):
        raw = [{"ts": "2024-03-01T09:30:00-05:00", "open": 50.0, "high": 51.0, "low": 49.0, "close": 50.5, "volume": 500}]
        result = gen.normalize_bars(raw)
        assert result[0]["date"] == "2024-03-01"

    def test_coerces_numeric_fields_to_float(self, gen):
        raw = [{"ts": "2024-01-02T00:00:00Z", "open": "10", "high": "11", "low": "9", "close": "10.5", "volume": "200"}]
        result = gen.normalize_bars(raw)
        bar = result[0]
        for field in ("open", "high", "low", "close", "volume"):
            assert isinstance(bar[field], float), f"Field {field} is not float"

    def test_empty_input_returns_empty_list(self, gen):
        assert gen.normalize_bars([]) == []

    def test_no_ts_key_raises_key_error(self, gen):
        """Malformed input without 'ts' must raise KeyError (not silently produce garbage)."""
        with pytest.raises(KeyError):
            gen.normalize_bars([{"open": 1.0, "high": 2.0, "low": 0.5, "close": 1.5, "volume": 100}])

    def test_output_has_no_ts_key(self, gen):
        raw = [{"ts": "2024-01-02T00:00:00Z", "open": 1.0, "high": 2.0, "low": 0.5, "close": 1.5, "volume": 100}]
        result = gen.normalize_bars(raw)
        assert "ts" not in result[0]
        assert "date" in result[0]


# ---------------------------------------------------------------------------
# Helpers for bar generation
# ---------------------------------------------------------------------------
def make_bars_uptrend(n: int, start_price: float = 100.0, symbol: str = "AAPL") -> list[dict]:
    """
    Generate bars designed to produce a confirmed EMA golden cross.

    Pattern: flat for 60 bars, then sharp rise — this causes EMA9 to cross above EMA21
    and stay there for confirmation_bars. Needs n >= 100 to guarantee a signal.
    """
    bars = []
    for i in range(n):
        if i < 60:
            close = start_price
        else:
            close = start_price + (i - 60) * 1.0  # sharp rise triggers golden cross
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


def make_bars_mild(n: int, start_price: float = 100.0) -> list[dict]:
    """Mild linear uptrend (used only for non-signal tests like field validation)."""
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
# generate_signals — EMA crossover adapter
# ---------------------------------------------------------------------------
class TestGenerateSignalsEma:
    STRATEGY = "ema-crossover-9-21"

    def test_returns_list(self, gen):
        bars = make_bars_uptrend(150)
        result = gen.generate_signals(self.STRATEGY, bars, {"symbol": "AAPL"})
        assert isinstance(result, list)

    def test_no_signal_before_minimum_bars(self, gen):
        """With fewer bars than required (48 for EMA), no signal emitted at all."""
        bars = make_bars_mild(30)  # 30 < 48 minimum
        result = gen.generate_signals(self.STRATEGY, bars, {"symbol": "AAPL"})
        assert len(result) == 0

    def test_signals_have_required_fields(self, gen):
        bars = make_bars_uptrend(150)
        result = gen.generate_signals(self.STRATEGY, bars, {"symbol": "AAPL"})
        for sig in result:
            assert "symbol" in sig
            assert "action" in sig
            assert "date" in sig
            assert sig["action"] in ("long", "exit")

    def test_signal_date_is_current_bar_date(self, gen):
        """Signal date must equal the bar where the signal was detected (same-bar close)."""
        bars = make_bars_uptrend(150)
        result = gen.generate_signals(self.STRATEGY, bars, {"symbol": "AAPL"})
        bar_dates = {b["date"] for b in bars}
        for sig in result:
            assert sig["date"] in bar_dates, f"Signal date {sig['date']} not in bar dates"

    def test_no_lookahead_bias(self, gen):
        """
        Truncating future bars must NOT change signals already emitted for earlier dates.

        Procedure:
          1. Generate signals for full series (150 bars — flat then sharp rise).
          2. Find the first signal date.
          3. Regenerate signals for bars[:k+1] where bars[k].date == first_signal_date.
          4. The first signal in full run must appear in truncated run too.

        The flat-then-rise pattern guarantees a golden cross signal exists in this series.
        """
        bars = make_bars_uptrend(150)
        full_signals = gen.generate_signals(self.STRATEGY, bars, {"symbol": "AAPL"})
        assert len(full_signals) > 0, (
            "No signals generated from flat-then-rise pattern — verify EMA adapter logic"
        )

        first_signal = full_signals[0]
        first_date = first_signal["date"]
        k = next(i for i, b in enumerate(bars) if b["date"] == first_date)

        truncated_signals = gen.generate_signals(self.STRATEGY, bars[:k + 1], {"symbol": "AAPL"})
        assert len(truncated_signals) > 0, "No signal in truncated run — lookahead bias suspected"
        assert truncated_signals[-1]["date"] == first_date
        assert truncated_signals[-1]["action"] == first_signal["action"]

    def test_unknown_strategy_raises_value_error(self, gen):
        bars = make_bars_mild(100)
        with pytest.raises(ValueError, match="Unknown strategy"):
            gen.generate_signals("not-a-real-strategy", bars, {"symbol": "AAPL"})

    def test_empty_bars_returns_empty(self, gen):
        result = gen.generate_signals(self.STRATEGY, [], {"symbol": "AAPL"})
        assert result == []


# ---------------------------------------------------------------------------
# generate_signals — RSI mean-reversion adapter
# ---------------------------------------------------------------------------
class TestGenerateSignalsRsi:
    STRATEGY = "rsi-mean-reversion"

    def test_returns_list(self, gen):
        bars = make_bars_mild(100)
        result = gen.generate_signals(self.STRATEGY, bars, {"symbol": "AAPL"})
        assert isinstance(result, list)

    def test_no_signal_before_minimum_bars(self, gen):
        """With fewer than 17 bars, no signal emitted (RSI needs period+1+confirmation_bars)."""
        bars = make_bars_mild(10)  # 10 < 17 minimum
        result = gen.generate_signals(self.STRATEGY, bars, {"symbol": "AAPL"})
        assert len(result) == 0

    def test_signals_have_required_fields(self, gen):
        # Use declining prices to force RSI oversold
        bars = []
        prices = [100.0 - i * 2.5 for i in range(60)]
        prices = [max(p, 1.0) for p in prices]
        for i, price in enumerate(prices):
            date = (datetime.date(2023, 1, 1) + datetime.timedelta(days=i)).isoformat()
            bars.append({
                "date": date,
                "open": price + 0.5,
                "high": price + 1.0,
                "low": max(price - 1.0, 0.1),
                "close": price,
                "volume": 1000.0,
            })
        result = gen.generate_signals(
            self.STRATEGY, bars,
            {"symbol": "AAPL", "oversold": 35.0, "confirmation_bars": 1}
        )
        for sig in result:
            assert "symbol" in sig
            assert "action" in sig
            assert "date" in sig
            assert sig["action"] in ("long", "exit")

    def test_oversold_maps_to_long(self, gen):
        """
        Force RSI into oversold by generating a sharp downtrend.
        After a sharp decline, RSI should signal 'oversold' → mapped to 'long'.
        """
        bars = []
        prices = [100.0 - i * 2.5 for i in range(40)]
        prices = [max(p, 1.0) for p in prices]
        for i, price in enumerate(prices):
            date = (datetime.date(2023, 1, 1) + datetime.timedelta(days=i)).isoformat()
            bars.append({
                "date": date,
                "open": price + 0.5,
                "high": price + 1.0,
                "low": max(price - 1.0, 0.1),
                "close": price,
                "volume": 1000.0,
            })
        result = gen.generate_signals(
            self.STRATEGY, bars,
            {"symbol": "TEST", "oversold": 35.0, "confirmation_bars": 1}
        )
        long_signals = [s for s in result if s["action"] == "long"]
        assert len(long_signals) > 0, "Expected at least one 'long' signal from oversold RSI"

    def test_no_lookahead_bias(self, gen):
        """
        Same no-lookahead contract as EMA: truncating future bars must not
        change signals already emitted for earlier dates.
        """
        bars = []
        prices = [100.0 - i * 2.5 for i in range(60)]
        prices = [max(p, 1.0) for p in prices]
        for i, price in enumerate(prices):
            date = (datetime.date(2023, 1, 1) + datetime.timedelta(days=i)).isoformat()
            bars.append({
                "date": date,
                "open": price + 0.5,
                "high": price + 1.0,
                "low": max(price - 1.0, 0.1),
                "close": price,
                "volume": 1000.0,
            })
        full_signals = gen.generate_signals(
            self.STRATEGY, bars,
            {"symbol": "TEST", "oversold": 35.0, "confirmation_bars": 1}
        )
        assert len(full_signals) > 0, "No signals generated — adjust prices or thresholds"

        first_signal = full_signals[0]
        first_date = first_signal["date"]
        k = next(i for i, b in enumerate(bars) if b["date"] == first_date)

        truncated_signals = gen.generate_signals(
            self.STRATEGY, bars[:k + 1],
            {"symbol": "TEST", "oversold": 35.0, "confirmation_bars": 1}
        )
        assert len(truncated_signals) > 0
        assert truncated_signals[-1]["date"] == first_date
        assert truncated_signals[-1]["action"] == first_signal["action"]

    def test_empty_bars_returns_empty(self, gen):
        result = gen.generate_signals(self.STRATEGY, [], {"symbol": "AAPL"})
        assert result == []

    def test_divergence_bull_maps_to_long(self, gen, monkeypatch):
        """A bullish divergence (which preempts oversold in the strategy) must map to long."""

        class _Stub:
            @staticmethod
            def analyze(**_kw):
                return {"signal": "divergence_bull", "last_rsi": 25.0, "rsi": [], "bars_in_zone": 1}

        monkeypatch.setattr(gen, "_load_strategy_module", lambda *_a, **_k: _Stub)
        result = gen.generate_signals(self.STRATEGY, make_bars_mild(30), {"symbol": "X"})
        assert len(result) > 0
        assert all(s["action"] == "long" for s in result)

    def test_divergence_bear_maps_to_exit(self, gen, monkeypatch):
        """A bearish divergence (which preempts overbought) must map to exit."""

        class _Stub:
            @staticmethod
            def analyze(**_kw):
                return {"signal": "divergence_bear", "last_rsi": 75.0, "rsi": [], "bars_in_zone": 1}

        monkeypatch.setattr(gen, "_load_strategy_module", lambda *_a, **_k: _Stub)
        result = gen.generate_signals(self.STRATEGY, make_bars_mild(30), {"symbol": "X"})
        assert len(result) > 0
        assert all(s["action"] == "exit" for s in result)
