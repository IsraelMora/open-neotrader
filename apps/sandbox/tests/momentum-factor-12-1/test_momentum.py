"""
Tests for the momentum-factor-12-1 plugin (12-1 cross-sectional momentum).

STRICT TDD — written before the fix. Pins the price-ordering convention used
across the whole codebase (see plugins/trend-following/scripts/trend_following.py
and apps/sandbox/tests/test_run_cycle.py::test_get_ohlcv_limit_slices_tail):

    index 0  = OLDEST bar
    index -1 = MOST RECENT bar (now)

Covers:
  (a) return_12_1 pinned to a hand-computed value on a known price series
  (b) absolute-momentum filter: a symbol with negative return_12_1 must never
      get signal="long", even if it ranks in the top percentile of a universe
      that is broadly negative
  (c) signal shape: every ranked symbol carries score, rank, and an action hint
  (d) market-wide trend filter still cancels all long signals in a downtrend
"""

from __future__ import annotations

import os
import sys

_PLUGIN_ROOT = os.path.abspath(
    os.path.join(
        os.path.dirname(__file__), "..", "..", "..", "..", "plugins", "momentum-factor-12-1"
    )
)
_SCRIPTS = os.path.join(_PLUGIN_ROOT, "scripts")
sys.path.insert(0, _SCRIPTS)

from momentum import apply_trend_filter, compute_momentum_ranks  # noqa: E402


def _load_on_cycle(plugin_root: str):
    """
    Load this plugin's hooks/cycle.py under a unique module name.

    Every plugin's hook file is named cycle.py — a bare `from cycle import`
    collides via sys.modules across the full pytest session (whichever
    plugin's cycle.py is imported first "wins" for every other test file).
    See tests/market-context/test_market_context.py for the same pattern.
    """
    import importlib.util as _ilu

    spec = _ilu.spec_from_file_location(
        "_cycle_momentum_factor_12_1", os.path.join(plugin_root, "hooks", "cycle.py")
    )
    module = _ilu.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.on_cycle


on_cycle = _load_on_cycle(_PLUGIN_ROOT)


def _series_oldest_first(start: float, monthly_step: float, n: int = 14) -> list[float]:
    """14 monthly closes, index 0 = oldest (13 months ago) .. index -1 = now."""
    return [round(start + monthly_step * i, 4) for i in range(n)]


class TestReturn12_1Pinned:
    def test_return_12_1_matches_hand_computed_value(self) -> None:
        """
        Prices oldest-first: 100, 105, 110, ..., 165 (14 monthly closes, step=5).
          index 0  (13 months ago) = 100
          index 12 (1 month ago, skip month)  = 160
          index 13 (now)                       = 165

        12-1 return = skip-month price / price-13-months-ago - 1
                    = 160 / 100 - 1 = 0.60
        """
        prices = _series_oldest_first(start=100.0, monthly_step=5.0)
        assert prices[0] == 100.0
        assert prices[-2] == 160.0
        assert prices[-1] == 165.0

        universe_data = {"AAA": prices}
        ranks = compute_momentum_ranks(universe_data, top_pct=1.0)

        assert len(ranks) == 1
        assert ranks[0].return_12_1 == 0.6

    def test_reversing_the_series_changes_the_result(self) -> None:
        """
        Sanity check that ordering actually matters: feeding the series in the
        WRONG (newest-first) order must NOT silently produce the same value as
        the correct oldest-first order.
        """
        prices_oldest_first = _series_oldest_first(start=100.0, monthly_step=5.0)
        prices_newest_first = list(reversed(prices_oldest_first))

        ranks_correct = compute_momentum_ranks({"AAA": prices_oldest_first}, top_pct=1.0)
        ranks_reversed = compute_momentum_ranks({"AAA": prices_newest_first}, top_pct=1.0)

        assert ranks_correct[0].return_12_1 != ranks_reversed[0].return_12_1


class TestAbsoluteMomentumFilter:
    def test_negative_return_never_gets_long_even_if_top_ranked(self) -> None:
        """
        Dual-momentum absolute filter: a symbol must have return_12_1 > 0 to
        ever receive a "long" action hint, regardless of its relative rank.
        A broadly negative universe (everything down) must produce NO longs.
        """
        # Both symbols lose money over the 12-1 window; AAA loses less than BBB
        # so AAA ranks #1 by relative momentum, but its absolute score is negative.
        aaa = _series_oldest_first(start=100.0, monthly_step=-1.0)  # ends lower, mild decline
        bbb = _series_oldest_first(start=100.0, monthly_step=-3.0)  # steep decline

        ranks = compute_momentum_ranks({"AAA": aaa, "BBB": bbb}, top_pct=1.0)
        by_symbol = {r.symbol: r for r in ranks}

        assert by_symbol["AAA"].return_12_1 < 0
        assert by_symbol["AAA"].rank == 1  # best relative rank
        assert by_symbol["AAA"].signal != "long", (
            "absolute-momentum filter must reject long signals when score <= 0"
        )

    def test_positive_return_in_top_pct_gets_long(self) -> None:
        aaa = _series_oldest_first(start=100.0, monthly_step=5.0)  # positive momentum
        bbb = _series_oldest_first(start=100.0, monthly_step=-3.0)  # negative momentum

        ranks = compute_momentum_ranks({"AAA": aaa, "BBB": bbb}, top_pct=0.5)
        by_symbol = {r.symbol: r for r in ranks}

        assert by_symbol["AAA"].signal == "long"
        assert by_symbol["BBB"].signal != "long"


class TestSignalShape:
    def test_every_rank_carries_score_rank_and_action_hint(self) -> None:
        prices = _series_oldest_first(start=100.0, monthly_step=2.0)
        ranks = compute_momentum_ranks({"AAA": prices}, top_pct=1.0)

        r = ranks[0]
        assert isinstance(r.return_12_1, float)  # momentum score
        assert isinstance(r.rank, int)
        assert r.signal in ("long", "neutral", "exit")

    def test_exit_signal_for_symbol_that_fell_out_of_top(self) -> None:
        aaa = _series_oldest_first(start=100.0, monthly_step=5.0)
        bbb = _series_oldest_first(start=100.0, monthly_step=1.0)

        # top_pct=0.5 keeps only the best of the two (AAA); BBB was held previously.
        ranks = compute_momentum_ranks(
            {"AAA": aaa, "BBB": bbb}, top_pct=0.5, current_positions={"BBB"}
        )
        by_symbol = {r.symbol: r for r in ranks}
        assert by_symbol["BBB"].signal == "exit"


class TestCycleHookSignalShape:
    """on_cycle() must emit self-contained per-symbol signals: score, rank,
    volatility (for downstream inverse-vol sizing) and an action hint."""

    def _get_ohlcv_factory(self, monthly_closes: dict[str, list[float]]):
        def _get_ohlcv(symbol: str, timeframe: str = "1Month", limit: int = 14):
            closes = monthly_closes.get(symbol, [])
            bars = [{"close": c} for c in closes]
            return bars[-limit:] if limit else bars

        return _get_ohlcv

    def test_momentum_signal_carries_score_rank_and_volatility(self) -> None:
        aaa = _series_oldest_first(start=100.0, monthly_step=5.0)
        bbb = _series_oldest_first(start=100.0, monthly_step=-3.0)

        ctx = {
            "universe": ["AAA", "BBB", "CCC", "DDD", "EEE"],
            "config": {"top_pct": 20, "lookback_months": 12},
            "portfolio": {},
            "market_trend_up": True,
            "provider_tools": {
                "get_ohlcv": self._get_ohlcv_factory(
                    {
                        "AAA": aaa,
                        "BBB": bbb,
                        "CCC": bbb,
                        "DDD": bbb,
                        "EEE": bbb,
                    }
                )
            },
        }

        result = on_cycle(ctx)
        signals = {s["symbol"]: s for s in result["signals"]}

        assert "AAA" in signals
        sig = signals["AAA"]
        assert sig["action"] == "long"
        assert sig["rank"] == 1
        assert isinstance(sig["return_12_1"], float)  # momentum score
        assert "volatility_12m" in sig, "signal must carry volatility for inverse-vol sizing"
        assert isinstance(sig["volatility_12m"], float)


class TestLookbackMonthsConfigurable:
    """
    compute_momentum_ranks must honor a configurable lookback_months instead of
    hardcoding the canonical 12-1 window. Portfolios with lookback_months < 12
    (e.g. Balanceado=9, Agresivo=6, Ultra-Agresivo=6) request lookback+2 monthly
    bars and must still get real signals, not a silent empty result.
    """

    def test_lookback_6_with_8_bars_returns_real_signal(self) -> None:
        # 8 monthly bars = lookback_months(6) + 2 — the minimum required.
        prices = _series_oldest_first(start=100.0, monthly_step=5.0, n=8)
        ranks = compute_momentum_ranks({"AAA": prices}, top_pct=1.0, lookback_months=6)

        assert len(ranks) == 1
        # window_start = prices[-8] = prices[0] = 100; skip_1m = prices[-2]
        expected = prices[-2] / prices[0] - 1.0
        assert ranks[0].return_12_1 == round(expected, 4)
        assert ranks[0].signal == "long"

    def test_lookback_6_with_7_bars_is_skipped_insufficient_data(self) -> None:
        # 7 bars < lookback_months(6) + 2 = 8 — must safely skip, not crash.
        prices = _series_oldest_first(start=100.0, monthly_step=5.0, n=7)
        ranks = compute_momentum_ranks({"AAA": prices}, top_pct=1.0, lookback_months=6)

        assert ranks == []

    def test_lookback_12_default_matches_prior_canonical_output(self) -> None:
        # Same series/expectation as TestReturn12_1Pinned — default lookback_months=12
        # must reproduce the exact prior 12-1 behavior.
        prices = _series_oldest_first(start=100.0, monthly_step=5.0)
        ranks_default = compute_momentum_ranks({"AAA": prices}, top_pct=1.0)
        ranks_explicit_12 = compute_momentum_ranks(
            {"AAA": prices}, top_pct=1.0, lookback_months=12
        )

        assert ranks_default[0].return_12_1 == 0.6
        assert ranks_explicit_12[0].return_12_1 == 0.6

    def test_cycle_hook_emits_signals_with_lookback_6(self) -> None:
        aaa = _series_oldest_first(start=100.0, monthly_step=5.0, n=8)
        bbb = _series_oldest_first(start=100.0, monthly_step=-3.0, n=8)

        ctx = {
            "universe": ["AAA", "BBB", "CCC", "DDD", "EEE"],
            "config": {"top_pct": 20, "lookback_months": 6},
            "portfolio": {},
            "market_trend_up": True,
            "provider_tools": {
                "get_ohlcv": TestCycleHookSignalShape()._get_ohlcv_factory(
                    {
                        "AAA": aaa,
                        "BBB": bbb,
                        "CCC": bbb,
                        "DDD": bbb,
                        "EEE": bbb,
                    }
                )
            },
        }

        result = on_cycle(ctx)
        signals = {s["symbol"]: s for s in result["signals"]}

        assert "AAA" in signals, "lookback_months=6 must not silently drop every symbol"
        assert signals["AAA"]["action"] == "long"


class TestTrendFilter:
    def test_downtrend_cancels_all_long_signals(self) -> None:
        prices = _series_oldest_first(start=100.0, monthly_step=5.0)
        ranks = compute_momentum_ranks({"AAA": prices}, top_pct=1.0)
        assert ranks[0].signal == "long"

        ranks = apply_trend_filter(ranks, market_trend_up=False)
        assert ranks[0].signal != "long"


class TestShortSellingOptIn:
    """
    OPT-IN short-selling extension. Default behavior (enable_short=False) must
    be byte-identical to the pre-existing long/exit-only behavior — no short
    signals ever appear unless explicitly enabled.

    When enabled, only the bottom `short_bottom_pct` of the ranked universe
    with NEGATIVE absolute momentum (return_12_1 < 0) gets a "short" signal.
    This avoids shorting names that are merely the worst performers of an
    otherwise-positive universe (2nd-best-in-a-bull-market problem).
    """

    def test_enable_short_false_default_produces_no_short_signals(self) -> None:
        # 5-symbol universe, mixed positive/negative momentum.
        aaa = _series_oldest_first(start=100.0, monthly_step=5.0)  # positive
        bbb = _series_oldest_first(start=100.0, monthly_step=3.0)  # positive
        ccc = _series_oldest_first(start=100.0, monthly_step=-1.0)  # negative
        ddd = _series_oldest_first(start=100.0, monthly_step=-3.0)  # negative
        eee = _series_oldest_first(start=100.0, monthly_step=-5.0)  # negative, worst

        universe = {"AAA": aaa, "BBB": bbb, "CCC": ccc, "DDD": ddd, "EEE": eee}

        ranks_default = compute_momentum_ranks(universe, top_pct=0.2)
        ranks_explicit_off = compute_momentum_ranks(
            universe, top_pct=0.2, enable_short=False, short_bottom_pct=0.2
        )

        assert all(r.signal != "short" for r in ranks_default)
        assert all(r.signal != "short" for r in ranks_explicit_off)
        # byte-identical: same signals/ranks regardless of the (unused) short knobs
        assert [(r.symbol, r.signal, r.rank) for r in ranks_default] == [
            (r.symbol, r.signal, r.rank) for r in ranks_explicit_off
        ]

    def test_enable_short_true_shorts_bottom_negative_names_only(self) -> None:
        aaa = _series_oldest_first(start=100.0, monthly_step=5.0)  # positive, top
        bbb = _series_oldest_first(start=100.0, monthly_step=3.0)  # positive
        ccc = _series_oldest_first(start=100.0, monthly_step=-1.0)  # mild negative
        ddd = _series_oldest_first(start=100.0, monthly_step=-3.0)  # negative
        eee = _series_oldest_first(start=100.0, monthly_step=-5.0)  # worst, negative

        universe = {"AAA": aaa, "BBB": bbb, "CCC": ccc, "DDD": ddd, "EEE": eee}

        # top_pct=0.2 -> only AAA long. short_bottom_pct=0.2 -> only EEE (worst) short.
        ranks = compute_momentum_ranks(
            universe, top_pct=0.2, enable_short=True, short_bottom_pct=0.2
        )
        by_symbol = {r.symbol: r for r in ranks}

        assert by_symbol["AAA"].signal == "long"
        assert by_symbol["EEE"].signal == "short"
        assert by_symbol["EEE"].return_12_1 < 0
        # only the bottom name gets shorted, not every negative-momentum name
        assert by_symbol["DDD"].signal != "short"
        assert by_symbol["CCC"].signal != "short"
        assert by_symbol["BBB"].signal != "short"

    def test_enable_short_true_never_shorts_positive_momentum(self) -> None:
        # All positive momentum universe — even the worst-ranked name must
        # never get "short" because its absolute momentum is positive.
        aaa = _series_oldest_first(start=100.0, monthly_step=5.0)
        bbb = _series_oldest_first(start=100.0, monthly_step=4.0)
        ccc = _series_oldest_first(start=100.0, monthly_step=3.0)
        ddd = _series_oldest_first(start=100.0, monthly_step=2.0)
        eee = _series_oldest_first(start=100.0, monthly_step=1.0)  # worst, but still positive

        universe = {"AAA": aaa, "BBB": bbb, "CCC": ccc, "DDD": ddd, "EEE": eee}
        ranks = compute_momentum_ranks(
            universe, top_pct=0.2, enable_short=True, short_bottom_pct=0.5
        )
        assert all(r.signal != "short" for r in ranks)

    def test_cycle_hook_emits_short_signals_when_enabled(self) -> None:
        aaa = _series_oldest_first(start=100.0, monthly_step=5.0, n=8)
        bbb = _series_oldest_first(start=100.0, monthly_step=3.0, n=8)
        ccc = _series_oldest_first(start=100.0, monthly_step=-1.0, n=8)
        ddd = _series_oldest_first(start=100.0, monthly_step=-3.0, n=8)
        eee = _series_oldest_first(start=100.0, monthly_step=-5.0, n=8)

        ctx = {
            "universe": ["AAA", "BBB", "CCC", "DDD", "EEE"],
            "config": {
                "top_pct": 20,
                "lookback_months": 6,
                "enable_short": True,
                "short_bottom_pct": 20,
            },
            "portfolio": {},
            "market_trend_up": True,
            "provider_tools": {
                "get_ohlcv": TestCycleHookSignalShape()._get_ohlcv_factory(
                    {"AAA": aaa, "BBB": bbb, "CCC": ccc, "DDD": ddd, "EEE": eee}
                )
            },
        }

        result = on_cycle(ctx)
        signals = {s["symbol"]: s for s in result["signals"]}

        assert "EEE" in signals
        assert signals["EEE"]["action"] == "short"

    def test_cycle_hook_emits_no_short_signals_when_disabled_by_default(self) -> None:
        aaa = _series_oldest_first(start=100.0, monthly_step=5.0, n=8)
        bbb = _series_oldest_first(start=100.0, monthly_step=3.0, n=8)
        ccc = _series_oldest_first(start=100.0, monthly_step=-1.0, n=8)
        ddd = _series_oldest_first(start=100.0, monthly_step=-3.0, n=8)
        eee = _series_oldest_first(start=100.0, monthly_step=-5.0, n=8)

        ctx = {
            "universe": ["AAA", "BBB", "CCC", "DDD", "EEE"],
            "config": {"top_pct": 20, "lookback_months": 6},
            "portfolio": {},
            "market_trend_up": True,
            "provider_tools": {
                "get_ohlcv": TestCycleHookSignalShape()._get_ohlcv_factory(
                    {"AAA": aaa, "BBB": bbb, "CCC": ccc, "DDD": ddd, "EEE": eee}
                )
            },
        }

        result = on_cycle(ctx)
        actions = {s["action"] for s in result["signals"]}
        assert "short" not in actions
