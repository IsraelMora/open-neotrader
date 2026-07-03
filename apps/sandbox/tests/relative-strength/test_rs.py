"""
Tests for the relative-strength plugin — cross-sectional RS ranking.

STRICT TDD — pins the math with hand-computed values before trusting it.

Covers:
  (a) compute_return: simple N-bar return, oldest-first convention
      (index -(period+1) = start, index -1 = end — no lookahead)
  (b) compute_composite_rs: weighted average of per-period RS ratios
  (c) percentile_rank: monotonic, 0-100 scale
  (d) analyze_relative_strength: cross-sectional rank end-to-end
"""

from __future__ import annotations

import os
import sys

_SCRIPTS = os.path.abspath(
    os.path.join(
        os.path.dirname(__file__), "..", "..", "..", "..", "plugins", "relative-strength", "scripts"
    )
)
sys.path.insert(0, _SCRIPTS)

from rs import (  # noqa: E402
    analyze_relative_strength,
    compute_composite_rs,
    compute_return,
    percentile_rank,
)


class TestComputeReturn:
    def test_pinned_return_value(self) -> None:
        # 6 prices, oldest-first: 100 .. 150 (index -(3+1)=-4 -> index 2 -> 120)
        prices = [100.0, 110.0, 120.0, 130.0, 140.0, 150.0]
        # period=3: start = prices[-(3+1)] = prices[2] = 120, end = prices[-1] = 150
        ret = compute_return(prices, period=3)
        assert ret == (150.0 - 120.0) / 120.0
        assert round(ret, 4) == 0.25

    def test_insufficient_bars_returns_none(self) -> None:
        assert compute_return([100.0, 101.0], period=5) is None

    def test_zero_start_price_returns_none(self) -> None:
        assert compute_return([0.0, 10.0], period=1) is None


class TestComputeCompositeRS:
    def test_pinned_composite_rs(self) -> None:
        # single period=1, weight=1.0
        # asset: 100 -> 110 (10% return); benchmark: 100 -> 105 (5% return)
        asset_prices = [100.0, 110.0]
        bench_prices = [100.0, 105.0]
        result = compute_composite_rs(asset_prices, bench_prices, periods=[1], weights=[1.0])
        assert result is not None
        expected_rs = (1 + 0.10) / (1 + 0.05)
        assert round(result["composite_rs"], 6) == round(expected_rs, 6)
        assert round(result["rs_scores"][1], 6) == round(expected_rs, 6)

    def test_outperformer_has_rs_above_one(self) -> None:
        asset_prices = [100.0, 130.0]
        bench_prices = [100.0, 105.0]
        result = compute_composite_rs(asset_prices, bench_prices, periods=[1], weights=[1.0])
        assert result["composite_rs"] > 1.0

    def test_underperformer_has_rs_below_one(self) -> None:
        asset_prices = [100.0, 102.0]
        bench_prices = [100.0, 120.0]
        result = compute_composite_rs(asset_prices, bench_prices, periods=[1], weights=[1.0])
        assert result["composite_rs"] < 1.0


class TestPercentileRank:
    def test_highest_value_gets_100th_percentile(self) -> None:
        values = [1.0, 1.1, 1.2, 1.3]
        assert percentile_rank(1.3, values) == 75.0  # 3 of 4 are below

    def test_lowest_value_gets_0th_percentile(self) -> None:
        values = [1.0, 1.1, 1.2, 1.3]
        assert percentile_rank(1.0, values) == 0.0

    def test_monotonic_with_more_values_below(self) -> None:
        values = [1.0, 1.05, 1.10, 1.15, 1.20]
        low = percentile_rank(1.05, values)
        high = percentile_rank(1.20, values)
        assert high > low


class TestAnalyzeRelativeStrength:
    def test_strong_outperformer_gets_long_action(self) -> None:
        result = analyze_relative_strength(
            symbol="AAA",
            prices=[100.0] * 200 + [200.0] * 60,  # strong recent outperformance
            benchmark_prices=[100.0] * 260,
            universe_rs_values=[0.9, 0.95, 1.0],
            periods=[63],
            weights=[1.0],
            rs_threshold=1.05,
            top_percentile=50.0,
        )
        assert result is not None
        assert result.action == "long"
        assert result.composite_rs > 1.05

    def test_weak_performer_gets_hold_action(self) -> None:
        result = analyze_relative_strength(
            symbol="BBB",
            prices=[100.0] * 260,  # flat, no outperformance
            benchmark_prices=[100.0] * 200 + [200.0] * 60,  # benchmark rallies
            universe_rs_values=[1.1, 1.2],
            periods=[63],
            weights=[1.0],
            rs_threshold=1.05,
            top_percentile=50.0,
        )
        assert result is not None
        assert result.action == "hold"
        assert result.composite_rs < 1.05
