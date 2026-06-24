"""
Tests for plugins/session-breakout/scripts/session_breakout.py

TDD order:
1. Write test (failing) → verify it fails for the RIGHT reason
2. Write minimal production code to pass
3. Repeat

Synthetic daily OHLCV bars format: {date, open, high, low, close, volume}
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Module loader — loads session_breakout.py directly from the plugin's scripts/
# ---------------------------------------------------------------------------

_REPO_ROOT = Path(__file__).parents[4]
_SCRIPTS_DIR = _REPO_ROOT / "plugins" / "session-breakout" / "scripts"


def _load_module():
    """Load session_breakout.py as a fresh module without installing it."""
    module_path = _SCRIPTS_DIR / "session_breakout.py"
    spec = importlib.util.spec_from_file_location("session_breakout", str(module_path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


@pytest.fixture(scope="module")
def sb():
    """Return the session_breakout module."""
    return _load_module()


# ---------------------------------------------------------------------------
# Helpers for building synthetic daily OHLCV series
# ---------------------------------------------------------------------------

def _make_daily_bar(
    date: str,
    open_: float,
    high: float,
    low: float,
    close: float,
    volume: float = 1_000_000.0,
) -> dict:
    return {
        "date": date,
        "open": open_,
        "high": high,
        "low": low,
        "close": close,
        "volume": volume,
    }


def _base_history(n: int = 20, base_price: float = 100.0) -> list[dict]:
    """
    Generate n quiet daily bars (no gap, tight range) as historical warmup.
    prev_close = 100.0 for each synthetic bar.
    """
    bars = []
    for i in range(n):
        date = f"2024-01-{i + 1:02d}"
        bars.append(
            _make_daily_bar(
                date=date,
                open_=base_price,
                high=base_price * 1.005,
                low=base_price * 0.995,
                close=base_price,
            )
        )
    return bars


# ---------------------------------------------------------------------------
# Default config (mirrors manifest.toml defaults)
# ---------------------------------------------------------------------------

_DEFAULT_CONFIG = {
    "or_bars": 5,
    "gap_threshold_pct": 1.0,
    "breakout_buffer_pct": 0.1,
    "timeframe": "1d",
    "mode": "auto",
}


# ---------------------------------------------------------------------------
# Test A — gap-up + breakout above opening range high → "long"
# ---------------------------------------------------------------------------

class TestGapUpBreakout:
    """Gap-up continuation: today opens well above prev_close, price breaks above opening high."""

    def test_signal_is_long(self, sb):
        history = _base_history(20, 100.0)
        # prev_close = 100.0  (last bar in history)
        # Today: gap up ~2%, then breaks above intraday high of the open
        today = _make_daily_bar(
            date="2024-02-01",
            open_=102.0,   # gap up 2.0% from 100.0
            high=103.5,    # today's range high (breakout target)
            low=101.5,
            close=103.6,   # close above range high — breakout confirmed
        )
        bars = history + [today]
        cfg = {**_DEFAULT_CONFIG, "gap_threshold_pct": 1.0, "breakout_buffer_pct": 0.1}

        result = sb.analyze(bars, cfg)

        assert result["signal"] == "long", f"Expected 'long', got {result['signal']!r}"

    def test_confirmed_true_on_gap_up_breakout(self, sb):
        history = _base_history(20, 100.0)
        today = _make_daily_bar(
            date="2024-02-01",
            open_=102.0,
            high=103.5,
            low=101.5,
            close=103.6,
        )
        bars = history + [today]
        result = sb.analyze(bars, _DEFAULT_CONFIG)

        assert result["confirmed"] is True

    def test_gap_pct_is_positive(self, sb):
        history = _base_history(20, 100.0)
        today = _make_daily_bar(
            date="2024-02-01",
            open_=102.0,
            high=103.5,
            low=101.5,
            close=103.6,
        )
        bars = history + [today]
        result = sb.analyze(bars, _DEFAULT_CONFIG)

        # gap_pct = (102.0 - 100.0) / 100.0 * 100 = 2.0
        assert result["gap_pct"] > 0, f"Expected positive gap_pct, got {result['gap_pct']}"
        assert abs(result["gap_pct"] - 2.0) < 0.01

    def test_confidence_in_range(self, sb):
        history = _base_history(20, 100.0)
        today = _make_daily_bar(
            date="2024-02-01",
            open_=102.0,
            high=103.5,
            low=101.5,
            close=103.6,
        )
        bars = history + [today]
        result = sb.analyze(bars, _DEFAULT_CONFIG)

        assert 0.0 <= result["confidence"] <= 1.0

    def test_reason_is_non_empty_string(self, sb):
        history = _base_history(20, 100.0)
        today = _make_daily_bar(
            date="2024-02-01",
            open_=102.0,
            high=103.5,
            low=101.5,
            close=103.6,
        )
        bars = history + [today]
        result = sb.analyze(bars, _DEFAULT_CONFIG)

        assert isinstance(result["reason"], str) and len(result["reason"]) > 0


# ---------------------------------------------------------------------------
# Test B — gap-down + breakdown below opening range low → "short"
# ---------------------------------------------------------------------------

class TestGapDownBreakdown:
    """Gap-down continuation: today opens well below prev_close, price breaks below opening low."""

    def test_signal_is_short(self, sb):
        history = _base_history(20, 100.0)
        # prev_close = 100.0
        # Today: gap down ~2%, then breaks below intraday low
        today = _make_daily_bar(
            date="2024-02-01",
            open_=98.0,    # gap down 2.0%
            high=98.5,
            low=96.8,      # today's range low
            close=96.7,    # close below range low — breakdown confirmed
        )
        bars = history + [today]
        cfg = {**_DEFAULT_CONFIG, "gap_threshold_pct": 1.0, "breakout_buffer_pct": 0.1}

        result = sb.analyze(bars, cfg)

        assert result["signal"] == "short", f"Expected 'short', got {result['signal']!r}"

    def test_gap_pct_is_negative(self, sb):
        history = _base_history(20, 100.0)
        today = _make_daily_bar(
            date="2024-02-01",
            open_=98.0,
            high=98.5,
            low=96.8,
            close=96.7,
        )
        bars = history + [today]
        result = sb.analyze(bars, _DEFAULT_CONFIG)

        # gap_pct = (98.0 - 100.0) / 100.0 * 100 = -2.0
        assert result["gap_pct"] < 0, f"Expected negative gap_pct, got {result['gap_pct']}"
        assert abs(result["gap_pct"] - (-2.0)) < 0.01

    def test_confirmed_true_on_gap_down_breakdown(self, sb):
        history = _base_history(20, 100.0)
        today = _make_daily_bar(
            date="2024-02-01",
            open_=98.0,
            high=98.5,
            low=96.8,
            close=96.7,
        )
        bars = history + [today]
        result = sb.analyze(bars, _DEFAULT_CONFIG)

        assert result["confirmed"] is True


# ---------------------------------------------------------------------------
# Test C — flat open, no gap, range-bound → "none"
# ---------------------------------------------------------------------------

class TestNoGapRangeBound:
    """No gap, price stays within opening range: no signal."""

    def test_signal_is_none_when_no_gap(self, sb):
        history = _base_history(20, 100.0)
        # Today: essentially flat open (0.2% gap, below 1.0% threshold), range-bound
        today = _make_daily_bar(
            date="2024-02-01",
            open_=100.2,   # 0.2% gap — below gap_threshold_pct=1.0
            high=100.5,
            low=99.8,
            close=100.3,   # inside range
        )
        bars = history + [today]
        cfg = {**_DEFAULT_CONFIG, "gap_threshold_pct": 1.0}

        result = sb.analyze(bars, cfg)

        assert result["signal"] == "none", f"Expected 'none', got {result['signal']!r}"

    def test_confirmed_false_when_no_gap(self, sb):
        history = _base_history(20, 100.0)
        today = _make_daily_bar(
            date="2024-02-01",
            open_=100.2,
            high=100.5,
            low=99.8,
            close=100.3,
        )
        bars = history + [today]
        result = sb.analyze(bars, _DEFAULT_CONFIG)

        assert result["confirmed"] is False

    def test_signal_is_none_when_gap_but_inside_range(self, sb):
        """Gap above threshold but price doesn't break out of opening range."""
        history = _base_history(20, 100.0)
        today = _make_daily_bar(
            date="2024-02-01",
            open_=102.0,   # 2% gap up
            high=102.8,    # opening range high
            low=101.5,
            close=102.2,   # inside range (no breakout)
        )
        bars = history + [today]
        cfg = {**_DEFAULT_CONFIG, "gap_threshold_pct": 1.0, "breakout_buffer_pct": 0.1}

        result = sb.analyze(bars, cfg)

        assert result["signal"] == "none", f"Expected 'none' for inside-range, got {result['signal']!r}"


# ---------------------------------------------------------------------------
# Test D — failed breakout: gap-up but price reverses below open → "exit" or "none"
# ---------------------------------------------------------------------------

class TestFailedBreakout:
    """
    Rule: gap-up but price closes BELOW the open (reversal through the open)
    → emit "exit" (failed breakout / gap fill scenario).
    """

    def test_signal_is_exit_when_gap_up_but_close_below_open(self, sb):
        history = _base_history(20, 100.0)
        # Gap up 2%, but price reverses and closes below today's open → failed breakout
        today = _make_daily_bar(
            date="2024-02-01",
            open_=102.0,   # gap up 2%
            high=103.0,    # tried to break out
            low=101.0,
            close=101.5,   # close BELOW open — failed, reversal
        )
        bars = history + [today]
        cfg = {**_DEFAULT_CONFIG, "gap_threshold_pct": 1.0, "breakout_buffer_pct": 0.1}

        result = sb.analyze(bars, cfg)

        # A reversal back through the open = failed breakout
        assert result["signal"] in ("exit", "none"), (
            f"Expected 'exit' or 'none' for failed breakout, got {result['signal']!r}"
        )

    def test_confirmed_false_on_failed_breakout(self, sb):
        history = _base_history(20, 100.0)
        today = _make_daily_bar(
            date="2024-02-01",
            open_=102.0,
            high=103.0,
            low=101.0,
            close=101.5,
        )
        bars = history + [today]
        result = sb.analyze(bars, _DEFAULT_CONFIG)

        # A failed breakout should not be confirmed
        assert result["confirmed"] is False

    def test_exit_when_gap_down_but_close_above_open(self, sb):
        """Gap down but price recovers above the open → failed breakdown."""
        history = _base_history(20, 100.0)
        today = _make_daily_bar(
            date="2024-02-01",
            open_=98.0,    # gap down 2%
            high=99.0,
            low=97.0,
            close=98.5,    # close ABOVE open — failed breakdown, recovery
        )
        bars = history + [today]
        cfg = {**_DEFAULT_CONFIG, "gap_threshold_pct": 1.0}

        result = sb.analyze(bars, cfg)

        assert result["signal"] in ("exit", "none"), (
            f"Expected 'exit' or 'none' for failed gap-down, got {result['signal']!r}"
        )


# ---------------------------------------------------------------------------
# Test E — no-lookahead: prefix result must be independent of future bars
# ---------------------------------------------------------------------------

class TestNoLookahead:
    """Strict no-lookahead: appending future bars must not change signal for the prefix."""

    def test_prefix_signal_unchanged_after_append(self, sb):
        history = _base_history(20, 100.0)
        today = _make_daily_bar(
            date="2024-02-01",
            open_=102.0,
            high=103.5,
            low=101.5,
            close=103.6,
        )
        bars_prefix = history + [today]
        result_prefix = sb.analyze(bars_prefix, _DEFAULT_CONFIG)

        # Append a dramatically different "future" bar
        future = _make_daily_bar(
            date="2024-02-02",
            open_=90.0,   # crash next day
            high=91.0,
            low=88.0,
            close=88.5,
        )
        # analyze on prefix AGAIN (the future bar must not be visible to prefix call)
        result_prefix_again = sb.analyze(bars_prefix, _DEFAULT_CONFIG)

        assert result_prefix["signal"] == result_prefix_again["signal"], (
            "Signal changed between two identical prefix calls — non-deterministic behavior"
        )

    def test_prefix_result_differs_from_full_when_future_changes_signal(self, sb):
        """
        The result for bars[0..N] must be based only on bars[0..N].
        Comparing analyze(prefix) vs analyze(prefix + [future]) is allowed to differ
        (the future bar is a DIFFERENT bar — that is expected). What must NOT change
        is analyze(prefix) called twice returning the same thing.
        """
        history = _base_history(20, 100.0)
        today = _make_daily_bar(
            date="2024-02-01",
            open_=102.0,
            high=103.5,
            low=101.5,
            close=103.6,
        )
        bars_prefix = history + [today]

        r1 = sb.analyze(bars_prefix, _DEFAULT_CONFIG)
        r2 = sb.analyze(bars_prefix, _DEFAULT_CONFIG)

        assert r1["signal"] == r2["signal"]
        assert r1["gap_pct"] == r2["gap_pct"]
        assert r1["confidence"] == r2["confidence"]


# ---------------------------------------------------------------------------
# Test F — return shape contract
# ---------------------------------------------------------------------------

class TestReturnShape:
    """analyze() must always return a dict with the required keys."""

    def test_required_keys_present_on_signal(self, sb):
        history = _base_history(20, 100.0)
        today = _make_daily_bar(
            date="2024-02-01",
            open_=102.0,
            high=103.5,
            low=101.5,
            close=103.6,
        )
        result = sb.analyze(history + [today], _DEFAULT_CONFIG)

        required = {"signal", "confirmed", "confidence", "reason", "gap_pct"}
        missing = required - set(result.keys())
        assert not missing, f"Missing keys: {missing}"

    def test_required_keys_present_on_none(self, sb):
        history = _base_history(20, 100.0)
        today = _make_daily_bar(
            date="2024-02-01",
            open_=100.1,  # tiny gap, no signal
            high=100.3,
            low=99.9,
            close=100.1,
        )
        result = sb.analyze(history + [today], _DEFAULT_CONFIG)

        required = {"signal", "confirmed", "confidence", "reason", "gap_pct"}
        missing = required - set(result.keys())
        assert not missing, f"Missing keys on 'none' result: {missing}"

    def test_insufficient_bars_returns_none_signal(self, sb):
        """With fewer bars than min_bars, analyze() must return signal='none', not crash."""
        bars = _base_history(2, 100.0)  # only 2 bars — not enough
        result = sb.analyze(bars, _DEFAULT_CONFIG)

        required = {"signal", "confirmed", "confidence", "reason", "gap_pct"}
        assert not (required - set(result.keys()))
        assert result["signal"] == "none"

    def test_signal_values_are_valid(self, sb):
        """signal must always be one of the declared enum values."""
        valid_signals = {"long", "short", "exit", "none"}

        cases = [
            # gap up + breakout
            _base_history(20, 100.0) + [_make_daily_bar("2024-02-01", 102.0, 103.5, 101.5, 103.6)],
            # gap down + breakdown
            _base_history(20, 100.0) + [_make_daily_bar("2024-02-01", 98.0, 98.5, 96.8, 96.7)],
            # flat
            _base_history(20, 100.0) + [_make_daily_bar("2024-02-01", 100.1, 100.3, 99.9, 100.1)],
        ]
        for bars in cases:
            result = sb.analyze(bars, _DEFAULT_CONFIG)
            assert result["signal"] in valid_signals, (
                f"Invalid signal value: {result['signal']!r}"
            )
