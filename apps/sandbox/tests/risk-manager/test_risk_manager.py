"""
Tests for the risk-manager plugin — unified layered risk discipline.

Strict TDD: written BEFORE implementation. All tests fail with ImportError
until plugins/risk-manager/ is fully built.

Four layers tested in isolation plus combined pass-through:
  (a) Exposure layer: hard veto / qty rescale on over-exposure entry
  (b) Concentration layer: cancels an over-concentrated sector add
  (c) Correlation layer: cancels a highly-correlated entry
  (d) Drawdown breaker layer: halts or scales when drawdown exceeds threshold
  (e) Per-layer config flag: when false, that check is skipped entirely
  (f) All layers pass → signals untouched
"""

from __future__ import annotations

import os
import sys

import pytest


# Load THIS plugin's cycle.py under a unique module name (every plugin's hook is
# named cycle.py → a bare `from cycle import` collides via sys.modules across the
# full pytest session, the same way runner.py avoids it with unique spec names).
def _load_on_cycle(_plugin):
    import importlib.util as _ilu
    import os as _os
    import sys as _sys
    _root = _os.path.join(_os.path.dirname(__file__), "..", "..", "..", "..", "plugins", _plugin)
    _sc = _os.path.join(_root, "scripts")
    if _sc not in _sys.path:
        _sys.path.insert(0, _sc)
    _spec = _ilu.spec_from_file_location("_cycle_" + _plugin.replace("-", "_"),
                                         _os.path.join(_root, "hooks", "cycle.py"))
    _m = _ilu.module_from_spec(_spec)
    _spec.loader.exec_module(_m)
    return _m.on_cycle
on_cycle = _load_on_cycle("risk-manager")

# ---------------------------------------------------------------------------
# Import path: pull scripts/ from the plugin under test
# ---------------------------------------------------------------------------
_PLUGIN_SCRIPTS = os.path.join(
    os.path.dirname(__file__),
    "..", "..", "..", "..", "plugins", "risk-manager", "scripts",
)
sys.path.insert(0, _PLUGIN_SCRIPTS)

_PLUGIN_HOOKS = os.path.join(
    os.path.dirname(__file__),
    "..", "..", "..", "..", "plugins", "risk-manager", "hooks",
)
sys.path.insert(0, _PLUGIN_HOOKS)

# We test at two levels:
#  1. Pure-math helpers in scripts/
#  2. The orchestrating on_cycle hook in hooks/cycle.py
from risk_manager_core import (  # noqa: E402
    apply_concentration_layer,
    apply_correlation_layer,
    apply_drawdown_layer,
    apply_exposure_layer,
    compute_vol_target_exposure,
    pearson_correlation,
)

pass  # on_cycle: module-level


# ---------------------------------------------------------------------------
# Synthetic ctx builder helpers
# ---------------------------------------------------------------------------

def _make_ctx(
    pending_signals: list[dict] | None = None,
    portfolio: dict | None = None,
    positions: list[dict] | None = None,
    portfolio_value: float = 100_000.0,
    equity_history: list[float] | None = None,
    equity_open_today: float = 0.0,
    circuit_state: str = "normal",
    worst_drawdown_in_state: float = 0.0,
    config: dict | None = None,
    provider_tools: dict | None = None,
) -> dict:
    return {
        "pending_signals": pending_signals or [],
        "portfolio": portfolio or {},
        "positions": positions or [],
        "portfolio_value": portfolio_value,
        "equity_history": equity_history or [portfolio_value],
        "equity_open_today": equity_open_today or portfolio_value,
        "circuit_state": circuit_state,
        "worst_drawdown_in_state": worst_drawdown_in_state,
        "config": config or _all_enabled_config(),
        "provider_tools": provider_tools or {},
    }


def _all_enabled_config(
    *,
    enable_exposure: bool = True,
    enable_concentration: bool = True,
    enable_correlation: bool = True,
    enable_drawdown_breaker: bool = True,
    # Exposure / envelope thresholds
    max_total_exposure: float = 0.80,
    max_position_pct: float = 0.40,
    max_single_trade_pct: float = 0.10,
    max_open_positions: int = 10,
    allow_shorts: bool = False,
    # Concentration (portfolio-risk-manager)
    max_sector_concentration_pct: float = 30.0,
    max_positions: int = 10,
    min_cash_pct: float = 20.0,
    # Correlation
    max_correlation: float = 0.70,
    lookback_days: int = 60,
    # Drawdown
    warning_drawdown_pct: float = 5.0,
    danger_drawdown_pct: float = 10.0,
    circuit_breaker_pct: float = 15.0,
    recovery_threshold_pct: float = 3.0,
    daily_loss_limit_pct: float = 3.0,
) -> dict:
    return {
        "enable_exposure": enable_exposure,
        "enable_concentration": enable_concentration,
        "enable_correlation": enable_correlation,
        "enable_drawdown_breaker": enable_drawdown_breaker,
        "max_total_exposure": max_total_exposure,
        "max_position_pct": max_position_pct,
        "max_single_trade_pct": max_single_trade_pct,
        "max_open_positions": max_open_positions,
        "allow_shorts": allow_shorts,
        "max_sector_concentration_pct": max_sector_concentration_pct,
        "max_positions": max_positions,
        "min_cash_pct": min_cash_pct,
        "max_correlation": max_correlation,
        "lookback_days": lookback_days,
        "warning_drawdown_pct": warning_drawdown_pct,
        "danger_drawdown_pct": danger_drawdown_pct,
        "circuit_breaker_pct": circuit_breaker_pct,
        "recovery_threshold_pct": recovery_threshold_pct,
        "daily_loss_limit_pct": daily_loss_limit_pct,
    }


def _price_series_high_corr(n: int = 80) -> list[float]:
    """
    Monotonically trending series — log-returns are nearly constant,
    so any two such series will have very high Pearson correlation.
    """
    return [100.0 + i * 1.0 for i in range(n)]


def _price_series_high_corr_b(n: int = 80) -> list[float]:
    """Second trending series with tiny alternating noise — still ~0.99 correlated with _a."""
    return [100.0 + i * 1.0 + (0.01 if i % 2 == 0 else -0.01) for i in range(n)]


def _price_series_uncorrelated(n: int = 80, seed: int = 42) -> list[float]:
    """Random walk uncorrelated with anything else."""
    state = seed
    prices = [100.0]
    for _ in range(n - 1):
        state = (1664525 * state + 1013904223) & 0xFFFFFFFF
        delta = (state / 0xFFFFFFFF - 0.5) * 2.0
        prices.append(max(prices[-1] * (1 + delta * 0.005), 1.0))
    return prices


# ---------------------------------------------------------------------------
# (a) Exposure layer: over-exposure entry vetoed or rescaled
# ---------------------------------------------------------------------------

class TestExposureLayer:

    def test_a1_position_exceeding_max_single_trade_is_rescaled(self) -> None:
        """
        Single trade notional > max_single_trade_pct * portfolio_value → rescaled down.
        portfolio_value=100_000, max_single_trade_pct=0.10 → max 10_000 notional.
        A signal of qty=200 @ price=100 (notional=20_000) must be rescaled.
        """
        portfolio_value = 100_000.0
        signal = {"symbol": "AAPL", "action": "long", "qty": 200.0, "price": 100.0}
        signals = [signal]
        cfg = _all_enabled_config(max_single_trade_pct=0.10, max_total_exposure=0.95)

        result = apply_exposure_layer(
            signals=signals,
            portfolio_value=portfolio_value,
            positions=[],
            config=cfg,
        )

        # Must still be in result (approved, not dropped) but qty must be reduced
        approved = [s for s in result if s.get("action") != "cancelled"]
        assert len(approved) == 1, "Rescaled signal should still be in output as approved"
        rescaled = approved[0]
        # Original notional: 200 * 100 = 20_000; max allowed: 10_000 → qty must be ≤ 100
        assert rescaled["qty"] <= 100.0 + 1e-6, (
            f"qty should be ≤ 100 after rescale, got {rescaled['qty']}"
        )

    def test_a2_total_exposure_cap_cancels_signal_when_no_room(self) -> None:
        """
        portfolio already at 95% exposure → new long must be vetoed entirely.
        """
        portfolio_value = 100_000.0
        # Existing positions consuming 95_000 (95%)
        positions = [{"symbol": "BTC", "market_value": 95_000.0}]
        signal = {"symbol": "ETH", "action": "long", "qty": 10.0, "price": 500.0}
        cfg = _all_enabled_config(max_total_exposure=0.95)

        result = apply_exposure_layer(
            signals=[signal],
            portfolio_value=portfolio_value,
            positions=positions,
            config=cfg,
        )

        cancelled = [s for s in result if s.get("action") == "cancelled"]
        assert len(cancelled) == 1, (
            f"Signal should be cancelled when exposure is already at max; got {result}"
        )

    def test_a3_within_limits_signal_passes_through(self) -> None:
        """Signal within all limits must pass through unmodified."""
        portfolio_value = 100_000.0
        signal = {"symbol": "AAPL", "action": "long", "qty": 5.0, "price": 100.0}
        cfg = _all_enabled_config(max_single_trade_pct=0.10, max_total_exposure=0.80)

        result = apply_exposure_layer(
            signals=[signal],
            portfolio_value=portfolio_value,
            positions=[],
            config=cfg,
        )

        assert len(result) == 1
        assert result[0]["action"] != "cancelled"
        assert abs(result[0]["qty"] - 5.0) < 1e-8, "Qty should be unchanged within limits"

    def test_a4_exit_signals_pass_through_exposure_layer_unchanged(self) -> None:
        """Exit/sell signals must never be vetoed by the exposure layer."""
        signal = {"symbol": "AAPL", "action": "exit", "qty": 10.0, "price": 100.0}
        cfg = _all_enabled_config(max_total_exposure=0.0)  # even with zero exposure cap

        result = apply_exposure_layer(
            signals=[signal],
            portfolio_value=100_000.0,
            positions=[],
            config=cfg,
        )

        assert len(result) == 1
        assert result[0]["action"] == "exit"

    def test_a5_tiny_residual_qty_position_is_treated_as_flat_for_max_open(self) -> None:
        """
        A position left with a tiny float residual (e.g. 1e-12 market value —
        the kind of dust left over from a partial close) must be treated as
        FLAT ("is_new" == True) for the max-open-positions gate, not as an
        already-open position that lets the signal skip the cap check.

        Portfolio: "OPEN" is genuinely open (counts toward the cap) and
        "RESIDUAL" is a dust position from a partial close. max_open_positions=1
        is already reached by "OPEN". A new "long" for RESIDUAL must still be
        cancelled — the residual must not let it silently bypass the gate by
        being misread as "already a held position" (exact float == 0 bug).
        """
        positions = [
            {"symbol": "OPEN", "market_value": 10_000.0},
            {"symbol": "RESIDUAL", "market_value": 1e-12},
        ]
        signal = {"symbol": "RESIDUAL", "action": "long", "qty": 1.0, "price": 100.0}
        cfg = _all_enabled_config(max_open_positions=1, max_total_exposure=0.95)

        result = apply_exposure_layer(
            signals=[signal],
            portfolio_value=100_000.0,
            positions=positions,
            config=cfg,
        )

        cancelled = [s for s in result if s.get("action") == "cancelled"]
        assert len(cancelled) == 1, (
            "RESIDUAL is effectively flat (dust); the gate must treat it as a "
            "new symbol and enforce max_open_positions=1, already reached by "
            f"OPEN; got {result}"
        )


# ---------------------------------------------------------------------------
# (b) Concentration layer: blocks an over-concentrated sector add
# ---------------------------------------------------------------------------

class TestConcentrationLayer:

    def test_b1_sector_over_limit_cancels_new_entry(self) -> None:
        """
        Portfolio already has 30% in 'tech', max_sector_concentration_pct=30%.
        A new 'long' for a tech symbol must be cancelled.
        """
        portfolio = {
            "MSFT": {"size_pct": 15.0, "sector": "tech"},
            "NVDA": {"size_pct": 15.0, "sector": "tech"},
        }
        signals = [{"symbol": "AAPL", "action": "long", "size_pct": 5.0, "sector": "tech"}]
        cfg = _all_enabled_config(max_sector_concentration_pct=30.0)

        result = apply_concentration_layer(
            signals=signals,
            portfolio=portfolio,
            config=cfg,
        )

        cancelled = [s for s in result if s.get("action") == "cancelled"]
        assert len(cancelled) == 1, (
            f"Over-concentrated sector entry should be cancelled; got {result}"
        )

    def test_b2_sector_within_limit_passes_through(self) -> None:
        """15% in tech, limit 30% → new tech entry at 5% is fine."""
        portfolio = {
            "MSFT": {"size_pct": 15.0, "sector": "tech"},
        }
        signals = [{"symbol": "AAPL", "action": "long", "size_pct": 5.0, "sector": "tech"}]
        cfg = _all_enabled_config(max_sector_concentration_pct=30.0)

        result = apply_concentration_layer(
            signals=signals,
            portfolio=portfolio,
            config=cfg,
        )

        approved = [s for s in result if s.get("action") != "cancelled"]
        assert len(approved) == 1

    def test_b3_max_positions_exceeded_cancels_new_symbol(self) -> None:
        """At max_positions, a new symbol entry is cancelled."""
        portfolio = {f"SYM{i}": {"size_pct": 5.0, "sector": "misc"} for i in range(10)}
        signals = [{"symbol": "NEW", "action": "long", "size_pct": 5.0, "sector": "misc"}]
        cfg = _all_enabled_config(max_positions=10)

        result = apply_concentration_layer(
            signals=signals,
            portfolio=portfolio,
            config=cfg,
        )

        cancelled = [s for s in result if s.get("action") == "cancelled"]
        assert len(cancelled) == 1, "New symbol when at max_positions should be cancelled"

    def test_b4_exit_signals_pass_through_concentration_layer(self) -> None:
        """Exit signals must not be blocked by concentration checks."""
        portfolio = {f"SYM{i}": {"size_pct": 10.0, "sector": "tech"} for i in range(10)}
        signals = [{"symbol": "SYM0", "action": "exit", "size_pct": 10.0, "sector": "tech"}]
        cfg = _all_enabled_config(max_sector_concentration_pct=0.0, max_positions=1)

        result = apply_concentration_layer(
            signals=signals,
            portfolio=portfolio,
            config=cfg,
        )

        assert len(result) == 1
        assert result[0]["action"] == "exit"


# ---------------------------------------------------------------------------
# (c) Correlation layer: cancels a highly-correlated entry
# ---------------------------------------------------------------------------

class TestCorrelationLayer:

    def test_c1_high_correlation_cancels_long_entry(self) -> None:
        """
        Candidate 'AAPL' has correlation > 0.7 with open position 'MSFT'.
        → The 'long' signal for AAPL must be cancelled.

        Both series are monotonically trending upward with tiny noise —
        their log-return Pearson correlation is ~0.99, well above the 0.7 threshold.
        """
        price_series = {
            "AAPL": _price_series_high_corr(80),
            "MSFT": _price_series_high_corr_b(80),
        }
        open_positions = ["MSFT"]
        signals = [{"symbol": "AAPL", "action": "long", "size_pct": 5.0}]
        cfg = _all_enabled_config(max_correlation=0.70)

        result = apply_correlation_layer(
            signals=signals,
            open_positions=open_positions,
            price_series=price_series,
            config=cfg,
        )

        cancelled = [s for s in result if s.get("action") == "cancelled"]
        assert len(cancelled) == 1, (
            f"High-corr signal should be cancelled; got {result}"
        )
        assert "cancel_reason" in cancelled[0]

    def test_c2_low_correlation_passes_through(self) -> None:
        """
        Candidate with Pearson correlation ≈ 0 vs open position should pass through.
        """
        series_a = _price_series_high_corr(80)
        series_b = _price_series_uncorrelated(80, seed=99)

        price_series = {
            "AAPL": series_b,
            "MSFT": series_a,
        }
        open_positions = ["MSFT"]
        signals = [{"symbol": "AAPL", "action": "long", "size_pct": 5.0}]
        cfg = _all_enabled_config(max_correlation=0.70)

        result = apply_correlation_layer(
            signals=signals,
            open_positions=open_positions,
            price_series=price_series,
            config=cfg,
        )

        approved = [s for s in result if s.get("action") != "cancelled"]
        assert len(approved) == 1

    def test_c3_insufficient_price_data_passes_all_signals(self) -> None:
        """
        If fewer than 2 symbols have price data, all signals must pass unchanged.
        """
        signals = [{"symbol": "AAPL", "action": "long", "size_pct": 5.0}]
        cfg = _all_enabled_config(max_correlation=0.70)

        result = apply_correlation_layer(
            signals=signals,
            open_positions=["MSFT"],
            price_series={},  # no data
            config=cfg,
        )

        assert len(result) == 1
        assert result[0]["action"] == "long"

    def test_c4_non_long_signals_pass_through_correlation_layer(self) -> None:
        """Exit and short signals must not be cancelled by the correlation layer."""
        price_series = {
            "AAPL": _price_series_high_corr(80),
            "MSFT": _price_series_high_corr_b(80),
        }
        signals = [
            {"symbol": "AAPL", "action": "exit", "size_pct": 5.0},
            {"symbol": "AAPL", "action": "short", "size_pct": 5.0},
        ]
        cfg = _all_enabled_config(max_correlation=0.0)  # extreme: any corr cancels

        result = apply_correlation_layer(
            signals=signals,
            open_positions=["MSFT"],
            price_series=price_series,
            config=cfg,
        )

        non_cancelled = [s for s in result if s.get("action") != "cancelled"]
        assert len(non_cancelled) == 2, "exit and short must not be cancelled by correlation"

    def test_c5_near_flat_series_returns_zero_not_spurious_correlation(self) -> None:
        """
        Two near-flat series (std ~1e-10, e.g. a symbol barely moving) must NOT
        produce a spurious large |correlation| that trips the correlation veto.
        The current `std_a == 0 or std_b == 0` guard only catches EXACT zero,
        so a near-zero-but-nonzero std still divides cov by a tiny denominator
        and inflates the ratio. Must be treated as "no correlation" (0.0).
        """
        n = 20
        near_flat_a = [100.0 + (1e-10 if i % 2 == 0 else -1e-10) for i in range(n)]
        near_flat_b = [50.0 + (1e-10 if i % 2 == 1 else -1e-10) for i in range(n)]

        corr = pearson_correlation(near_flat_a, near_flat_b)

        assert corr == 0.0, (
            f"Near-flat (near-zero std) series must yield 0.0 correlation, got {corr}"
        )

    def test_c6_genuinely_correlated_series_still_compute_correctly(self) -> None:
        """The near-zero-std guard must not affect series with real variance."""
        a = _price_series_high_corr(80)
        b = _price_series_high_corr_b(80)

        corr = pearson_correlation(_log_returns_for_test(a), _log_returns_for_test(b))

        assert corr > 0.9, f"Genuinely correlated series must still compute a high corr, got {corr}"


def _log_returns_for_test(prices: list[float]) -> list[float]:
    import math as _math
    return [
        _math.log(prices[i] / prices[i - 1])
        for i in range(1, len(prices))
        if prices[i - 1] > 0
    ]


# ---------------------------------------------------------------------------
# (d) Drawdown breaker: halts or scales when drawdown exceeds threshold
# ---------------------------------------------------------------------------

class TestDrawdownLayer:

    def test_d1_breaker_drawdown_cancels_all_entries(self) -> None:
        """
        Drawdown ≥ circuit_breaker_pct → all long/short signals are cancelled.
        Equity dropped from 100_000 → 82_000 = 18% drawdown (> 15% breaker).
        """
        equity_history = [100_000.0, 95_000.0, 90_000.0, 82_000.0]
        signals = [
            {"symbol": "AAPL", "action": "long", "position_usd": 5_000.0},
            {"symbol": "TSLA", "action": "short", "position_usd": 3_000.0},
        ]
        cfg = _all_enabled_config(circuit_breaker_pct=15.0)

        result = apply_drawdown_layer(
            signals=signals,
            equity_history=equity_history,
            equity_open_today=100_000.0,
            circuit_state="normal",
            worst_drawdown_in_state=0.0,
            config=cfg,
        )

        cancelled = [s for s in result if s.get("action") == "cancelled"]
        assert len(cancelled) == 2, (
            f"Both entry signals should be cancelled at breaker drawdown; got {result}"
        )

    def test_d2_danger_drawdown_scales_position_size(self) -> None:
        """
        Drawdown ≥ danger_pct (10%) but < breaker_pct (15%) → size_multiplier=0.25.
        Signal with position_usd=10_000 should become 2_500.

        equity_history spans multiple days; peak=100_000, current=89_000 = 11% drawdown.
        equity_open_today is set to the second-to-last bar (90_000) so daily loss is
        only (90_000 - 89_000) / 90_000 ≈ 1.1% — well below the 3% daily limit.
        This ensures the DANGER state is reached, not the DAILY halt.
        """
        equity_history = [100_000.0, 97_000.0, 94_000.0, 90_000.0, 89_000.0]
        signals = [{"symbol": "AAPL", "action": "long", "position_usd": 10_000.0}]
        cfg = _all_enabled_config(danger_drawdown_pct=10.0, circuit_breaker_pct=15.0)

        result = apply_drawdown_layer(
            signals=signals,
            equity_history=equity_history,
            equity_open_today=90_000.0,  # today opened at 90k; current 89k = 1.1% daily loss
            circuit_state="normal",
            worst_drawdown_in_state=0.0,
            config=cfg,
        )

        assert len(result) == 1
        sig = result[0]
        assert sig.get("action") == "long", "Trading allowed at DANGER"
        assert sig.get("circuit_reduced") is True
        assert abs(sig.get("position_usd", 0) - 2_500.0) < 1.0, (
            f"position_usd should be 2500 (10000 * 0.25), got {sig.get('position_usd')}"
        )

    def test_d3_warning_drawdown_scales_to_50_pct(self) -> None:
        """
        Drawdown ≥ warning_pct (5%) but < danger_pct → size_multiplier=0.50.

        peak=100_000, current=94_000 = 6% drawdown.
        equity_open_today=95_000 so daily loss = (95k - 94k) / 95k ≈ 1.05% < 3% daily limit.
        """
        equity_history = [100_000.0, 98_000.0, 96_000.0, 95_000.0, 94_000.0]
        signals = [{"symbol": "AAPL", "action": "long", "position_usd": 10_000.0}]
        cfg = _all_enabled_config(warning_drawdown_pct=5.0, danger_drawdown_pct=10.0)

        result = apply_drawdown_layer(
            signals=signals,
            equity_history=equity_history,
            equity_open_today=95_000.0,  # today opened at 95k; current 94k = 1.05% daily loss
            circuit_state="normal",
            worst_drawdown_in_state=0.0,
            config=cfg,
        )

        sig = result[0]
        assert sig.get("circuit_reduced") is True
        assert abs(sig.get("position_usd", 0) - 5_000.0) < 1.0, (
            f"position_usd should be 5000 (10000 * 0.50), got {sig.get('position_usd')}"
        )

    def test_d4_exit_signals_pass_through_drawdown_layer(self) -> None:
        """Exit signals must never be cancelled by the drawdown breaker."""
        equity_history = [100_000.0, 50_000.0]  # 50% drawdown — extreme
        signals = [{"symbol": "AAPL", "action": "exit", "position_usd": 5_000.0}]
        cfg = _all_enabled_config(circuit_breaker_pct=15.0)

        result = apply_drawdown_layer(
            signals=signals,
            equity_history=equity_history,
            equity_open_today=100_000.0,
            circuit_state="normal",
            worst_drawdown_in_state=0.0,
            config=cfg,
        )

        assert len(result) == 1
        assert result[0]["action"] == "exit"

    def test_d5_normal_drawdown_leaves_signals_unchanged(self) -> None:
        """Drawdown < warning_pct → signals completely untouched."""
        equity_history = [100_000.0, 99_000.0, 98_000.0]  # 2% drawdown
        signals = [{"symbol": "AAPL", "action": "long", "position_usd": 10_000.0}]
        cfg = _all_enabled_config(warning_drawdown_pct=5.0)

        result = apply_drawdown_layer(
            signals=signals,
            equity_history=equity_history,
            equity_open_today=100_000.0,
            circuit_state="normal",
            worst_drawdown_in_state=0.0,
            config=cfg,
        )

        sig = result[0]
        assert sig.get("circuit_reduced") is not True
        assert sig.get("position_usd") == 10_000.0


# ---------------------------------------------------------------------------
# (e) Per-layer config toggle: disabled layer is fully skipped
# ---------------------------------------------------------------------------

class TestLayerToggles:

    def test_e1_disable_exposure_skips_exposure_checks(self) -> None:
        """
        enable_exposure=False → even a massively over-sized trade passes through.
        """
        portfolio_value = 100_000.0
        # Notional = 50_000 (50% of portfolio) but single trade cap is 10%
        signal = {"symbol": "AAPL", "action": "long", "qty": 500.0, "price": 100.0}
        cfg = _all_enabled_config(enable_exposure=False, max_single_trade_pct=0.10)

        result = apply_exposure_layer(
            signals=[signal],
            portfolio_value=portfolio_value,
            positions=[],
            config=cfg,
        )

        # Layer disabled → passes through EXACTLY as-is (no rescale, no veto)
        assert len(result) == 1
        assert result[0]["qty"] == 500.0
        assert result[0]["action"] != "cancelled"

    def test_e2_disable_concentration_skips_sector_check(self) -> None:
        """enable_concentration=False → over-concentrated sector entry is NOT cancelled."""
        portfolio = {
            "MSFT": {"size_pct": 30.0, "sector": "tech"},
        }
        signals = [{"symbol": "AAPL", "action": "long", "size_pct": 5.0, "sector": "tech"}]
        cfg = _all_enabled_config(enable_concentration=False, max_sector_concentration_pct=30.0)

        result = apply_concentration_layer(
            signals=signals,
            portfolio=portfolio,
            config=cfg,
        )

        assert all(s["action"] != "cancelled" for s in result), (
            "With enable_concentration=False, no signal should be cancelled"
        )

    def test_e3_disable_correlation_skips_correlation_check(self) -> None:
        """enable_correlation=False → perfectly correlated entry is NOT cancelled."""
        price_series = {
            "AAPL": _price_series_high_corr(80),
            "MSFT": _price_series_high_corr_b(80),
        }
        signals = [{"symbol": "AAPL", "action": "long", "size_pct": 5.0}]
        cfg = _all_enabled_config(enable_correlation=False, max_correlation=0.0)

        result = apply_correlation_layer(
            signals=signals,
            open_positions=["MSFT"],
            price_series=price_series,
            config=cfg,
        )

        assert all(s["action"] != "cancelled" for s in result)

    def test_e4_disable_drawdown_skips_circuit_check(self) -> None:
        """enable_drawdown_breaker=False → even 50% drawdown does not cancel signals."""
        equity_history = [100_000.0, 50_000.0]
        signals = [{"symbol": "AAPL", "action": "long", "position_usd": 5_000.0}]
        cfg = _all_enabled_config(enable_drawdown_breaker=False, circuit_breaker_pct=15.0)

        result = apply_drawdown_layer(
            signals=signals,
            equity_history=equity_history,
            equity_open_today=100_000.0,
            circuit_state="normal",
            worst_drawdown_in_state=0.0,
            config=cfg,
        )

        assert len(result) == 1
        assert result[0]["action"] == "long"
        assert result[0].get("circuit_reduced") is not True


# ---------------------------------------------------------------------------
# (f) All layers pass → signals completely untouched by on_cycle
# ---------------------------------------------------------------------------

class TestOnCycleIntegration:

    def test_f1_clean_state_signals_pass_through_on_cycle(self) -> None:
        """
        No risk violations in any layer → on_cycle returns signals unchanged.
        """
        signal = {
            "symbol": "AAPL",
            "action": "long",
            "qty": 5.0,
            "price": 100.0,
            "size_pct": 5.0,
            "position_usd": 500.0,
            "sector": "tech",
        }
        ctx = _make_ctx(
            pending_signals=[signal],
            portfolio={"GOOG": {"size_pct": 10.0, "sector": "tech"}},
            positions=[{"symbol": "GOOG", "market_value": 10_000.0}],
            portfolio_value=100_000.0,
            equity_history=[100_000.0, 99_000.0, 99_500.0],  # 0.5% drawdown
            config=_all_enabled_config(
                max_sector_concentration_pct=30.0,
                max_correlation=0.70,
                warning_drawdown_pct=5.0,
            ),
        )

        result = on_cycle(ctx)

        assert "signals" in result
        assert "logs" in result
        # All signals should pass through (none cancelled)
        cancelled = [s for s in result["signals"] if s.get("action") == "cancelled"]
        assert len(cancelled) == 0, (
            f"No violations → zero cancelled signals; got: {cancelled}"
        )

    def test_f2_on_cycle_layers_apply_in_order_exposure_first(self) -> None:
        """
        With exposure layer blocking a signal, the later layers never see it.
        The drawdown state is NORMAL so drawdown layer does not cancel.
        But exposure is 95% full → signal should be cancelled.
        """
        signal = {
            "symbol": "ETH",
            "action": "long",
            "qty": 100.0,
            "price": 100.0,
            "size_pct": 10.0,
            "position_usd": 10_000.0,
        }
        ctx = _make_ctx(
            pending_signals=[signal],
            positions=[{"symbol": "BTC", "market_value": 95_000.0}],
            portfolio_value=100_000.0,
            equity_history=[100_000.0, 99_500.0],  # tiny drawdown — normal
            config=_all_enabled_config(max_total_exposure=0.95),
        )

        result = on_cycle(ctx)
        cancelled = [s for s in result["signals"] if s.get("action") == "cancelled"]
        assert len(cancelled) == 1

    def test_f3_on_cycle_empty_pending_signals_returns_empty(self) -> None:
        """on_cycle with no pending signals returns signals=[] without error."""
        ctx = _make_ctx(pending_signals=[])
        result = on_cycle(ctx)
        assert result["signals"] == []

    def test_f4_on_cycle_returns_required_keys(self) -> None:
        """on_cycle must return a dict with at least 'signals' and 'logs' keys."""
        ctx = _make_ctx(pending_signals=[])
        result = on_cycle(ctx)
        assert "signals" in result
        assert "logs" in result
        assert isinstance(result["logs"], list)

    def test_f5_on_cycle_all_layers_disabled_passes_everything(self) -> None:
        """With all four layers disabled, signals pass through completely."""
        # Even a grotesque signal should pass
        signal = {
            "symbol": "AAPL",
            "action": "long",
            "qty": 99999.0,
            "price": 999.0,
            "size_pct": 100.0,
            "position_usd": 99_000_000.0,
            "sector": "tech",
        }
        ctx = _make_ctx(
            pending_signals=[signal],
            portfolio={f"S{i}": {"size_pct": 10.0, "sector": "tech"} for i in range(20)},
            positions=[{"symbol": "BIG", "market_value": 99_000.0}],
            portfolio_value=100_000.0,
            equity_history=[100_000.0, 40_000.0],  # 60% drawdown
            config=_all_enabled_config(
                enable_exposure=False,
                enable_concentration=False,
                enable_correlation=False,
                enable_drawdown_breaker=False,
            ),
        )

        result = on_cycle(ctx)
        cancelled = [s for s in result["signals"] if s.get("action") == "cancelled"]
        assert len(cancelled) == 0, "All layers disabled → nothing cancelled"


# ---------------------------------------------------------------------------
# Vol-target exposure scalar (Moreira & Muir 2017 style) — batch 6 research
# reproduction. exposure_t = clip(target_vol / realized_vol_{t-1}, 0, cap).
# ---------------------------------------------------------------------------


def _constant_vol_closes(n: int, daily_ret: float, start: float = 100.0) -> list[float]:
    """Deterministic close series with alternating +daily_ret/-daily_ret so the
    sample stdev of returns is exactly daily_ret (mean ~0), for exact vol math."""
    closes = [start]
    for i in range(n):
        r = daily_ret if i % 2 == 0 else -daily_ret
        closes.append(closes[-1] * (1 + r))
    return closes


class TestComputeVolTargetExposure:
    def test_g1_insufficient_history_returns_none(self) -> None:
        """Fewer than vol_window_days prior returns -> None (caller treats as 0 exposure)."""
        closes = [100.0, 101.0, 102.0]  # only 2 prior returns, window needs 20
        assert compute_vol_target_exposure(closes, 12.0, 20, 1.0) is None

    def test_g2_exact_target_vol_yields_scalar_near_one(self) -> None:
        """When realized annualized vol ~= target_vol, scalar ~= 1.0."""
        import math

        daily_ret = 0.12 / math.sqrt(252)  # annualizes to ~12%
        closes = _constant_vol_closes(40, daily_ret)
        scalar = compute_vol_target_exposure(closes, 12.0, 20, 1.0)
        assert scalar is not None
        assert 0.9 <= scalar <= 1.1

    def test_g3_high_vol_scales_exposure_down(self) -> None:
        """Realized vol >> target -> scalar well below 1."""
        closes = _constant_vol_closes(40, 0.05)  # ~79% annualized vol
        scalar = compute_vol_target_exposure(closes, 12.0, 20, 1.0)
        assert scalar is not None
        assert scalar < 0.3

    def test_g4_low_vol_clips_at_cap(self) -> None:
        """Realized vol << target -> scalar clips at exposure_cap, never exceeds it."""
        closes = _constant_vol_closes(40, 0.0001)
        scalar = compute_vol_target_exposure(closes, 12.0, 20, 1.0)
        assert scalar == 1.0

    def test_g5_cap_above_one_allows_leverage(self) -> None:
        closes = _constant_vol_closes(40, 0.0001)
        scalar = compute_vol_target_exposure(closes, 15.0, 20, 1.5)
        assert scalar == 1.5

    def test_g6_scalar_never_negative(self) -> None:
        closes = _constant_vol_closes(40, 0.05)
        scalar = compute_vol_target_exposure(closes, 12.0, 20, 1.0)
        assert scalar is not None
        assert scalar >= 0.0

    def test_g7_no_lookahead_last_close_excluded_from_vol(self) -> None:
        """Appending an extreme final close (a lookahead leak if used) must NOT
        change the computed scalar, because compute_vol_target_exposure always
        excludes the most recent close from the return series."""
        import math

        daily_ret = 0.12 / math.sqrt(252)
        closes = _constant_vol_closes(40, daily_ret)
        scalar_before = compute_vol_target_exposure(closes, 12.0, 20, 1.0)
        closes_with_shock = closes + [closes[-1] * 3.0]  # extreme "today" close
        scalar_after = compute_vol_target_exposure(closes_with_shock, 12.0, 20, 1.0)
        assert scalar_before == pytest.approx(scalar_after, abs=1e-9)

    def test_g8_zero_vol_returns_cap_not_none(self) -> None:
        """Flat closes (zero realized vol) -> scalar clips at cap (not a crash/None)."""
        closes = [100.0] * 40
        scalar = compute_vol_target_exposure(closes, 12.0, 20, 1.0)
        assert scalar == 1.0


class TestOnCycleVolTargetMode:
    def test_h1_default_mode_no_exposure_scalar_key(self) -> None:
        """exposure_mode absent/'layered' (default): no exposure_scalar key at all,
        existing layered behavior fully preserved."""
        ctx = _make_ctx(pending_signals=[], config=_all_enabled_config())
        result = on_cycle(ctx)
        assert "exposure_scalar" not in result

    def test_h2_vol_target_mode_emits_exposure_scalar(self) -> None:
        import math

        daily_ret = 0.12 / math.sqrt(252)
        closes = _constant_vol_closes(40, daily_ret)
        bars = [{"date": f"2024-01-{i:02d}", "close": c} for i, c in enumerate(closes, start=1)]
        ctx = _make_ctx(
            pending_signals=[],
            config={
                **_all_enabled_config(),
                "exposure_mode": "vol_target",
                "target_vol_pct": 12.0,
                "vol_window_days": 20,
                "exposure_cap": 1.0,
                "vol_target_benchmark": "SPY",
            },
        )
        ctx["ohlcv"] = {"SPY": bars}
        result = on_cycle(ctx)
        assert "exposure_scalar" in result
        assert 0.0 <= result["exposure_scalar"] <= 1.0

    def test_h2b_vol_target_mode_with_enough_bars_yields_positive_scalar(self) -> None:
        """Bug reproduction guard (vol-managed-exposure-data): given >=21 daily bars
        for the benchmark in ctx["ohlcv"] (vol_window_days=20 + 1 excluded-last bar),
        on_cycle must emit a POSITIVE, finite exposure_scalar — never None/0.0. This is
        the exact condition a Vol-Managed pretest portfolio needs to actually trade:
        real benchmark data in -> a real (non-fail-safe) scalar out."""
        import math

        daily_ret = 0.12 / math.sqrt(252)
        closes = _constant_vol_closes(40, daily_ret)  # far more than the 21-bar minimum
        bars = [{"date": f"2024-01-{i:02d}", "close": c} for i, c in enumerate(closes, start=1)]
        ctx = _make_ctx(
            pending_signals=[],
            config={
                **_all_enabled_config(),
                "exposure_mode": "vol_target",
                "target_vol_pct": 12.0,
                "vol_window_days": 20,
                "exposure_cap": 1.0,
                "vol_target_benchmark": "TECL",
            },
        )
        ctx["ohlcv"] = {"TECL": bars}
        result = on_cycle(ctx)
        scalar = result["exposure_scalar"]
        assert scalar is not None
        assert math.isfinite(scalar)
        assert scalar > 0.0

    def test_h3_vol_target_mode_missing_benchmark_data_defaults_zero(self) -> None:
        """No ohlcv for the configured benchmark -> exposure_scalar=0.0 (fail-safe:
        stay in cash rather than guess an exposure)."""
        ctx = _make_ctx(
            pending_signals=[],
            config={**_all_enabled_config(), "exposure_mode": "vol_target"},
        )
        ctx["ohlcv"] = {}
        result = on_cycle(ctx)
        assert result["exposure_scalar"] == 0.0

    def test_h4_vol_target_mode_does_not_disable_other_layers(self) -> None:
        """exposure_mode=vol_target is additive: the four layers still run and can
        still cancel signals, exactly as in layered mode."""
        signal = {"symbol": "SHORT1", "action": "short", "qty": 10, "price": 100.0}
        ctx = _make_ctx(
            pending_signals=[signal],
            config={**_all_enabled_config(allow_shorts=False), "exposure_mode": "vol_target"},
        )
        ctx["ohlcv"] = {}
        result = on_cycle(ctx)
        assert result["signals"][0]["action"] == "cancelled"
