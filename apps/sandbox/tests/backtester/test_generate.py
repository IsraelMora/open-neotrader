"""
Tests for plugins/backtester/scripts/generate.py.

Covers the sliding-window adapter over the 3 curated strategies
(trend-following, mean-reversion, session-breakout), all of which expose the
uniform contract analyze(bars, config) -> {"signal": ...}.

Run: cd apps/sandbox && python3 -m pytest tests/backtester/test_generate.py -v
"""
from __future__ import annotations

import datetime
import math
from pathlib import Path

import pytest

from .conftest import load_generate

_REPO_ROOT = Path(__file__).parents[4]


@pytest.fixture(scope="module")
def gen():
    return load_generate()


# ---------------------------------------------------------------------------
# normalize_bars
# ---------------------------------------------------------------------------
class TestNormalizeBars:
    def test_strips_time_from_ts(self, gen):
        raw = [{
            "ts": "2024-01-15T00:00:00Z", "open": 100.0, "high": 101.0,
            "low": 99.0, "close": 100.5, "volume": 1000,
        }]
        result = gen.normalize_bars(raw)
        assert result[0]["date"] == "2024-01-15"

    def test_strips_time_offset_variant(self, gen):
        raw = [{
            "ts": "2024-03-01T09:30:00-05:00", "open": 50.0, "high": 51.0,
            "low": 49.0, "close": 50.5, "volume": 500,
        }]
        result = gen.normalize_bars(raw)
        assert result[0]["date"] == "2024-03-01"

    def test_coerces_numeric_fields_to_float(self, gen):
        raw = [{
            "ts": "2024-01-02T00:00:00Z", "open": "10", "high": "11",
            "low": "9", "close": "10.5", "volume": "200",
        }]
        result = gen.normalize_bars(raw)
        bar = result[0]
        for field in ("open", "high", "low", "close", "volume"):
            assert isinstance(bar[field], float), f"Field {field} is not float"

    def test_empty_input_returns_empty_list(self, gen):
        assert gen.normalize_bars([]) == []

    def test_no_ts_key_raises_key_error(self, gen):
        with pytest.raises(KeyError):
            gen.normalize_bars([
                {"open": 1.0, "high": 2.0, "low": 0.5, "close": 1.5, "volume": 100}
            ])

    def test_output_has_no_ts_key(self, gen):
        raw = [{
            "ts": "2024-01-02T00:00:00Z", "open": 1.0, "high": 2.0,
            "low": 0.5, "close": 1.5, "volume": 100,
        }]
        result = gen.normalize_bars(raw)
        assert "ts" not in result[0]
        assert "date" in result[0]


# ---------------------------------------------------------------------------
# Bar helpers
# ---------------------------------------------------------------------------
def _bar(i: int, open_: float, high: float, low: float, close: float) -> dict:
    date = (datetime.date(2023, 1, 1) + datetime.timedelta(days=i)).isoformat()
    return {"date": date, "open": open_, "high": high, "low": low, "close": close, "volume": 1000.0}


def _from_closes(closes: list[float]) -> list[dict]:
    """OHLC bars from a close series (open=prev close, high/low padded)."""
    bars = []
    prev = closes[0]
    for i, c in enumerate(closes):
        o = prev
        bars.append(_bar(i, o, max(o, c) + 0.5, min(o, c) - 0.5, c))
        prev = c
    return bars


def make_accelerating_uptrend(n: int) -> list[dict]:
    """Quadratic (accelerating) rise → EMA, MACD and Ichimoku all bullish."""
    return _from_closes([100.0 + 0.5 * i + 0.02 * i * i for i in range(n)])


def make_sine(n: int, amp: float = 15.0, period: int = 20, base: float = 100.0) -> list[dict]:
    """Stationary oscillation around `base` → mean-reverting (finite OU half-life)."""
    return _from_closes([base + amp * math.sin(2 * math.pi * i / period) for i in range(n)])


def make_flat_with_gap_up(n: int, gap_at: int) -> list[dict]:
    """Flat at 100, then one gap-up breakout bar at `gap_at` (close == high)."""
    bars = []
    for i in range(n):
        if i == gap_at:
            bars.append(_bar(i, 105.0, 106.0, 104.0, 106.0))  # +5% gap, close==high
        elif i > gap_at:
            bars.append(_bar(i, 106.0, 106.0, 106.0, 106.0))
        else:
            bars.append(_bar(i, 100.0, 100.0, 100.0, 100.0))
    return bars


# ---------------------------------------------------------------------------
# Generic contract (any strategy)
# ---------------------------------------------------------------------------
class TestGenerateSignalsContract:
    def test_unknown_strategy_raises_value_error(self, gen):
        with pytest.raises(ValueError, match="Unknown strategy"):
            gen.generate_signals("not-a-real-strategy", make_sine(100), {"symbol": "X"})

    @pytest.mark.parametrize("strategy", ["trend-following", "mean-reversion", "session-breakout"])
    def test_empty_bars_returns_empty(self, gen, strategy):
        assert gen.generate_signals(strategy, [], {"symbol": "X"}) == []

    @pytest.mark.parametrize("strategy", ["trend-following", "mean-reversion", "session-breakout"])
    def test_returns_list_of_valid_signals(self, gen, strategy):
        result = gen.generate_signals(strategy, make_sine(120), {"symbol": "X"})
        assert isinstance(result, list)
        bar_dates = {b["date"] for b in make_sine(120)}
        for sig in result:
            assert set(sig) >= {"symbol", "action", "date"}
            assert sig["action"] in ("long", "short", "exit")
            assert sig["date"] in bar_dates


def _assert_no_lookahead(gen, strategy: str, bars: list[dict], config: dict):
    """Truncating future bars must not change the first emitted signal."""
    full = gen.generate_signals(strategy, bars, config)
    assert len(full) > 0, f"{strategy}: expected ≥1 signal — adjust the test series"
    first = full[0]
    k = next(i for i, b in enumerate(bars) if b["date"] == first["date"])
    truncated = gen.generate_signals(strategy, bars[: k + 1], config)
    assert len(truncated) > 0, f"{strategy}: lookahead suspected — no signal in truncated run"
    assert truncated[-1]["date"] == first["date"]
    assert truncated[-1]["action"] == first["action"]


# ---------------------------------------------------------------------------
# trend-following
# ---------------------------------------------------------------------------
class TestTrendFollowing:
    STRATEGY = "trend-following"

    def test_accelerating_uptrend_yields_long(self, gen):
        result = gen.generate_signals(
            self.STRATEGY, make_accelerating_uptrend(140), {"symbol": "AAPL"}
        )
        assert any(s["action"] == "long" for s in result), "accelerating uptrend should go long"

    def test_no_signal_before_min_bars(self, gen):
        # min_bars = senkou_b(52)+kijun(26)=78 → 60 bars produce nothing
        result = gen.generate_signals(
            self.STRATEGY, make_accelerating_uptrend(60), {"symbol": "AAPL"}
        )
        assert result == []

    def test_no_lookahead(self, gen):
        _assert_no_lookahead(gen, self.STRATEGY, make_accelerating_uptrend(140), {"symbol": "AAPL"})


# ---------------------------------------------------------------------------
# mean-reversion
# ---------------------------------------------------------------------------
class TestMeanReversion:
    STRATEGY = "mean-reversion"
    # Lower entry_z and drop RSI confirm so the oscillation reliably triggers.
    CONFIG = {"symbol": "X", "entry_z": 1.0, "use_rsi_confirm": False}

    def test_oscillation_yields_a_signal(self, gen):
        result = gen.generate_signals(self.STRATEGY, make_sine(140), self.CONFIG)
        assert len(result) > 0, "a stationary oscillation should produce reversion signals"
        assert any(s["action"] in ("long", "short", "exit") for s in result)

    def test_no_signal_before_min_bars(self, gen):
        # min_bars = max(lookback*3+20, lookback+rsi+10) = 80 → 50 bars produce nothing
        result = gen.generate_signals(self.STRATEGY, make_sine(50), self.CONFIG)
        assert result == []

    def test_no_lookahead(self, gen):
        _assert_no_lookahead(gen, self.STRATEGY, make_sine(140), self.CONFIG)


# ---------------------------------------------------------------------------
# session-breakout
# ---------------------------------------------------------------------------
class TestSessionBreakout:
    STRATEGY = "session-breakout"

    def test_gap_up_breakout_yields_long(self, gen):
        bars = make_flat_with_gap_up(40, gap_at=30)
        result = gen.generate_signals(self.STRATEGY, bars, {"symbol": "X"})
        longs = [s for s in result if s["action"] == "long"]
        assert len(longs) > 0, "gap-up breakout should go long"

    def test_no_lookahead(self, gen):
        bars = make_flat_with_gap_up(40, gap_at=30)
        _assert_no_lookahead(gen, self.STRATEGY, bars, {"symbol": "X"})


# ---------------------------------------------------------------------------
# max_lookback (fast mode) — caps the analyze() window without lookahead
# ---------------------------------------------------------------------------
class TestMaxLookback:
    def test_caps_window_when_set_and_full_by_default(self, gen, monkeypatch):
        seen: list[int] = []

        class FakeMod:
            @staticmethod
            def analyze(window, config):
                seen.append(len(window))
                return {"signal": "none"}

        monkeypatch.setattr(gen, "_load_strategy_module", lambda *a, **k: FakeMod)
        bars = make_accelerating_uptrend(300)

        # Default: full growing window → reaches len(bars)
        seen.clear()
        gen.generate_signals("trend-following", bars, {"symbol": "X"})
        assert max(seen) == len(bars)

        # max_lookback=120 (> min_bars 78) → window never exceeds 120
        seen.clear()
        gen.generate_signals("trend-following", bars, {"symbol": "X", "max_lookback": 120})
        assert seen and max(seen) <= 120

    def test_clamped_to_min_bars(self, gen, monkeypatch):
        """max_lookback below the strategy's min_bars is raised to min_bars so the
        strategy always has the history it needs."""
        seen: list[int] = []

        class FakeMod:
            @staticmethod
            def analyze(window, config):
                seen.append(len(window))
                return {"signal": "none"}

        monkeypatch.setattr(gen, "_load_strategy_module", lambda *a, **k: FakeMod)
        bars = make_accelerating_uptrend(300)
        # trend-following min_bars = 78; ask for 10 → clamped up to 78
        gen.generate_signals("trend-following", bars, {"symbol": "X", "max_lookback": 10})
        assert seen and max(seen) <= 78 and max(seen) >= 70
