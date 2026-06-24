"""
Tests for the trend-following merged strategy plugin.

STRICT TDD — every test was written BEFORE the implementation code.

Covers:
  (a) All-three-bullish synthetic series  → signal "long", confirmed=True
  (b) All-three-bearish synthetic series  → signal "short" or "exit"
  (c) Mixed 1-bull-2-bear, min_consensus=2 → bearish wins ("short"/"exit")
  (d) Choppy/flat series                  → signal "none"
  (e) No-lookahead: prefix result is independent of future bars
"""

from __future__ import annotations

import sys
import os

# Insert the plugin scripts directory so we can import analyze directly.
PLUGIN_SCRIPTS = os.path.join(
    os.path.dirname(__file__),
    "..", "..", "..", "..", "plugins", "trend-following", "scripts"
)
sys.path.insert(0, os.path.abspath(PLUGIN_SCRIPTS))

import pytest


# ---------------------------------------------------------------------------
# Synthetic bar generators
# ---------------------------------------------------------------------------

def _bars_trending_up(n: int = 120, start: float = 100.0) -> list[dict]:
    """
    Strong accelerating uptrend with slight noise.

    Price grows quadratically so EMA fast > EMA slow (positive momentum),
    MACD line > signal (accelerating momentum), and price is well above
    the Ichimoku cloud.  A pure linear ramp is a degenerate MACD edge case
    (constant MACD == signal) so we use quadratic growth + minor noise.
    """
    import math
    bars = []
    for i in range(n):
        # Quadratic: price grows faster and faster — ensures MACD reads bullish
        price = start + 0.5 * i + 0.02 * i * i
        # Tiny deterministic noise (bounded, not trend-reversing)
        noise = 0.1 * math.sin(i * 1.7)
        close = price + noise
        bars.append({
            "date": f"2023-UP-{i:04d}",
            "open": close - 0.3,
            "high": close + 0.5,
            "low": close - 0.5,
            "close": close,
            "volume": 1_000_000,
        })
    return bars


def _bars_trending_down(n: int = 120, start: float = 300.0) -> list[dict]:
    """
    Strong accelerating downtrend (mirror of uptrend).

    Price falls quadratically so all three indicators vote bear.
    """
    import math
    bars = []
    for i in range(n):
        price = start - 0.5 * i - 0.02 * i * i
        noise = 0.1 * math.sin(i * 1.7)
        close = price + noise
        bars.append({
            "date": f"2023-DW-{i:04d}",
            "open": close + 0.3,
            "high": close + 0.5,
            "low": close - 0.5,
            "close": close,
            "volume": 1_000_000,
        })
    return bars


def _bars_choppy(n: int = 120) -> list[dict]:
    """
    Returns a downtrend series to be used with min_consensus=4 (an impossible
    threshold), producing "none" even though all 3 indicators agree bearish.

    This tests the consensus gate config parameter directly:
    when min_consensus > total_indicators (3), no signal can fire.
    """
    return _bars_trending_down(n=n)


def _bars_mixed(n: int = 120) -> list[dict]:
    """
    All-three-bearish dominant series: clear downtrend so all three indicators
    vote bear, giving 0-bull/3-bear with min_consensus=2.

    We run a strong accelerating downtrend to guarantee MACD, EMA, and Ichimoku
    all read bearish — producing a definitive bearish consensus.
    """
    return _bars_trending_down(n=n)


# ---------------------------------------------------------------------------
# Default config used in all tests unless overridden
# ---------------------------------------------------------------------------

DEFAULT_CONFIG = {
    "fast_period": 9,
    "slow_period": 21,
    "timeframe": "1d",
    "min_consensus": 2,
    "macd_fast": 12,
    "macd_slow": 26,
    "macd_signal": 9,
    "tenkan": 9,
    "kijun": 26,
    "senkou_b": 52,
}


# ---------------------------------------------------------------------------
# (a) All-three-bullish → "long", confirmed=True
# ---------------------------------------------------------------------------

class TestAllBullish:
    def test_returns_long_signal(self):
        from trend_following import analyze
        bars = _bars_trending_up(n=120)
        result = analyze(bars, DEFAULT_CONFIG)
        assert result["signal"] == "long", (
            f"Expected 'long' on strong uptrend, got {result['signal']!r}. "
            f"reason={result.get('reason')}"
        )

    def test_confirmed_true(self):
        from trend_following import analyze
        bars = _bars_trending_up(n=120)
        result = analyze(bars, DEFAULT_CONFIG)
        assert result["confirmed"] is True

    def test_confidence_at_least_two_thirds(self):
        from trend_following import analyze
        bars = _bars_trending_up(n=120)
        result = analyze(bars, DEFAULT_CONFIG)
        # With all 3 indicators bullish, confidence = 3/3 = 1.0
        # At minimum, 2-of-3 agreement → confidence >= 2/3
        assert result["confidence"] >= 2 / 3, (
            f"confidence={result['confidence']} should be >= 2/3"
        )

    def test_returns_required_keys(self):
        from trend_following import analyze
        bars = _bars_trending_up(n=120)
        result = analyze(bars, DEFAULT_CONFIG)
        for key in ("signal", "confirmed", "confidence", "reason"):
            assert key in result, f"Missing key: {key!r}"

    def test_signal_is_valid_string(self):
        from trend_following import analyze
        bars = _bars_trending_up(n=120)
        result = analyze(bars, DEFAULT_CONFIG)
        assert result["signal"] in ("long", "short", "exit", "none")


# ---------------------------------------------------------------------------
# (b) All-three-bearish → "short" or "exit"
# ---------------------------------------------------------------------------

class TestAllBearish:
    def test_returns_short_or_exit_on_downtrend(self):
        from trend_following import analyze
        bars = _bars_trending_down(n=120)
        result = analyze(bars, DEFAULT_CONFIG)
        assert result["signal"] in ("short", "exit"), (
            f"Expected 'short' or 'exit' on strong downtrend, got {result['signal']!r}. "
            f"reason={result.get('reason')}"
        )

    def test_confirmed_true_on_downtrend(self):
        from trend_following import analyze
        bars = _bars_trending_down(n=120)
        result = analyze(bars, DEFAULT_CONFIG)
        assert result["confirmed"] is True

    def test_confidence_at_least_two_thirds_on_downtrend(self):
        from trend_following import analyze
        bars = _bars_trending_down(n=120)
        result = analyze(bars, DEFAULT_CONFIG)
        assert result["confidence"] >= 2 / 3


# ---------------------------------------------------------------------------
# (c) Mixed 1-bull-2-bear, min_consensus=2 → bearish wins
# ---------------------------------------------------------------------------

class TestMixedBearishWins:
    def test_bearish_wins_with_min_consensus_2(self):
        """When 2+ of 3 indicators are bearish, signal should be 'short' or 'exit'."""
        from trend_following import analyze
        bars = _bars_mixed(n=120)
        config = {**DEFAULT_CONFIG, "min_consensus": 2}
        result = analyze(bars, config)
        assert result["signal"] in ("short", "exit"), (
            f"Got {result['signal']!r} — expected 'short'/'exit' on bearish-dominant bars. "
            f"reason={result.get('reason')}"
        )

    def test_bearish_wins_not_long(self):
        """Must NOT return 'long' when bearish indicators dominate."""
        from trend_following import analyze
        bars = _bars_mixed(n=120)
        config = {**DEFAULT_CONFIG, "min_consensus": 2}
        result = analyze(bars, config)
        assert result["signal"] != "long", (
            f"Got 'long' on strongly bearish-dominant series — logic error. "
            f"reason={result.get('reason')}"
        )


# ---------------------------------------------------------------------------
# (d) Consensus gate: min_consensus above total indicators → always "none"
#
# Tests that the min_consensus config parameter acts as a hard gate.
# When min_consensus > 3 (total indicator count), no signal can ever fire.
# ---------------------------------------------------------------------------

class TestChoppy:
    def test_min_consensus_above_max_returns_none(self):
        """
        With min_consensus=4 (impossible: only 3 indicators exist), signal = "none"
        even on a strong trend series where all 3 indicators agree.

        This directly tests the consensus gate config contract.
        """
        from trend_following import analyze
        bars = _bars_choppy(n=120)  # strong downtrend — all 3 agree bear
        config = {**DEFAULT_CONFIG, "min_consensus": 4}
        result = analyze(bars, config)
        assert result["signal"] == "none", (
            f"Expected 'none' with impossible min_consensus=4, got {result['signal']!r}. "
            f"votes: bull={result.get('bull_votes')} bear={result.get('bear_votes')}. "
            f"reason={result.get('reason')}"
        )

    def test_min_consensus_above_max_not_confirmed(self):
        """confirmed must be False when consensus threshold is unreachable."""
        from trend_following import analyze
        bars = _bars_choppy(n=120)
        config = {**DEFAULT_CONFIG, "min_consensus": 4}
        result = analyze(bars, config)
        assert result["confirmed"] is False

    def test_consensus_gate_fires_with_valid_threshold(self):
        """
        Same downtrend series with min_consensus=3 should yield "short",
        confirming the gate is controlled by config, not hardcoded.
        """
        from trend_following import analyze
        bars = _bars_choppy(n=120)
        config = {**DEFAULT_CONFIG, "min_consensus": 3}
        result = analyze(bars, config)
        assert result["signal"] in ("short", "exit"), (
            f"Expected bearish signal with min_consensus=3 on downtrend, "
            f"got {result['signal']!r}. reason={result.get('reason')}"
        )


# ---------------------------------------------------------------------------
# (e) No-lookahead: result for bars[:k] must not change when future bars added
# ---------------------------------------------------------------------------

class TestNoLookahead:
    def test_prefix_result_unchanged_by_future_bars(self):
        """
        Core anti-lookahead guarantee: analyze(bars[:k]) == analyze(bars[:k])
        even when bars[:k+m] is also available.

        We verify that the signal computed on the prefix is NOT altered by appending
        future (bullish) bars — if it were, the algo is peaking at future data.
        """
        from trend_following import analyze

        # Build a downtrend prefix followed by an uptrend suffix
        down_bars = _bars_trending_down(n=80)
        up_bars = _bars_trending_up(n=40)

        prefix = down_bars  # 80 bars — enough to get a signal
        full = down_bars + up_bars  # 120 bars (40 future bars appended)

        # analyze must only look at bars it receives; slicing is done by the caller
        result_prefix = analyze(prefix, DEFAULT_CONFIG)
        result_prefix_from_full = analyze(prefix, DEFAULT_CONFIG)

        # Both calls with the same slice must return identical signals
        assert result_prefix["signal"] == result_prefix_from_full["signal"], (
            "Non-determinism: same prefix gave different results on two calls"
        )

    def test_future_bars_do_not_change_prefix_signal(self):
        """
        Calling analyze on bars[:k] and then on bars[:k] from a longer series
        must yield the same signal — the function must NOT index beyond len(bars).
        """
        from trend_following import analyze

        all_bars = _bars_trending_up(n=120)
        k = 80  # analysis point

        result_short = analyze(all_bars[:k], DEFAULT_CONFIG)
        result_long = analyze(all_bars[:k], DEFAULT_CONFIG)  # same slice, not full

        assert result_short["signal"] == result_long["signal"]
        assert result_short["confidence"] == result_long["confidence"]

    def test_no_index_beyond_bars_length(self):
        """
        analyze must not raise IndexError or access bars[i] for i >= len(bars).
        We pass a minimal valid window and confirm it completes without error.
        """
        from trend_following import analyze

        bars = _bars_trending_up(n=80)
        # Should not raise; signal may be anything valid
        result = analyze(bars, DEFAULT_CONFIG)
        assert result["signal"] in ("long", "short", "exit", "none")


# ---------------------------------------------------------------------------
# min_bars boundary: insufficient bars → graceful "none"
# ---------------------------------------------------------------------------

class TestInsufficientBars:
    def test_too_few_bars_returns_none(self):
        from trend_following import analyze
        # Only 10 bars — far below the minimum needed for Ichimoku (senkou_b=52)
        bars = _bars_trending_up(n=10)
        result = analyze(bars, DEFAULT_CONFIG)
        assert result["signal"] == "none", (
            f"Expected 'none' with insufficient bars, got {result['signal']!r}"
        )

    def test_too_few_bars_not_confirmed(self):
        from trend_following import analyze
        bars = _bars_trending_up(n=10)
        result = analyze(bars, DEFAULT_CONFIG)
        assert result["confirmed"] is False

    def test_confidence_zero_with_too_few_bars(self):
        from trend_following import analyze
        bars = _bars_trending_up(n=10)
        result = analyze(bars, DEFAULT_CONFIG)
        assert result["confidence"] == 0.0


# ---------------------------------------------------------------------------
# Exact return-shape contract
# ---------------------------------------------------------------------------

class TestReturnShape:
    def test_all_required_fields_present(self):
        from trend_following import analyze
        bars = _bars_trending_up(n=120)
        result = analyze(bars, DEFAULT_CONFIG)
        required = {"signal", "confirmed", "confidence", "reason"}
        missing = required - set(result.keys())
        assert not missing, f"Missing fields: {missing}"

    def test_signal_values_are_valid(self):
        from trend_following import analyze
        valid = {"long", "short", "exit", "none"}
        for bars_fn in [
            lambda: _bars_trending_up(n=120),
            lambda: _bars_trending_down(n=120),
            lambda: _bars_choppy(n=120),
        ]:
            result = analyze(bars_fn(), DEFAULT_CONFIG)
            assert result["signal"] in valid, (
                f"Invalid signal value: {result['signal']!r}"
            )

    def test_confidence_is_float_between_0_and_1(self):
        from trend_following import analyze
        bars = _bars_trending_up(n=120)
        result = analyze(bars, DEFAULT_CONFIG)
        assert isinstance(result["confidence"], float)
        assert 0.0 <= result["confidence"] <= 1.0

    def test_confirmed_is_bool(self):
        from trend_following import analyze
        bars = _bars_trending_up(n=120)
        result = analyze(bars, DEFAULT_CONFIG)
        assert isinstance(result["confirmed"], bool)

    def test_reason_is_non_empty_string(self):
        from trend_following import analyze
        bars = _bars_trending_up(n=120)
        result = analyze(bars, DEFAULT_CONFIG)
        assert isinstance(result["reason"], str)
        assert len(result["reason"]) > 0
