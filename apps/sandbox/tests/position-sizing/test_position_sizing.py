"""
Tests for the unified position-sizing plugin.

Strict TDD: written BEFORE implementation. All tests must fail with ImportError
until plugins/position-sizing/ exists with scripts/ and hooks/.

Modes tested:
  (a) mode="kelly"   — sizes from win-rate/payoff from trade history
  (b) mode="pyramid" — tranche plan for new signals, adds for open positions
  (c) mode="fixed"   — uses fixed_pct regardless of history
  (d) kelly_fraction_cap limits the computed Kelly fraction
  (e) edge cases: no trade history degrades safely (fallback safety size)
"""

from __future__ import annotations

import os
import sys

import pytest

# ---------------------------------------------------------------------------
# Path wiring — let tests import from plugins/position-sizing/scripts directly
# ---------------------------------------------------------------------------

_PLUGIN_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "plugins", "position-sizing")
)
_SCRIPTS = os.path.join(_PLUGIN_ROOT, "scripts")
_HOOKS = os.path.join(_PLUGIN_ROOT, "hooks")

sys.path.insert(0, _SCRIPTS)
sys.path.insert(0, _HOOKS)

import cycle  # noqa: E402
from pyramid import calculate_tranches  # noqa: E402
from sizing import (  # noqa: E402
    compute_inverse_vol_weights,
    compute_kelly,
    position_size,
    position_size_fixed_fractional_risk,
    resolve_stop_price,
    stats_from_trades,
)

# ---------------------------------------------------------------------------
# Helpers — synthetic trade history
# ---------------------------------------------------------------------------

def _trades(
    n_wins: int, n_losses: int, avg_win_pct: float = 3.0, avg_loss_pct: float = 1.5
) -> list[dict]:
    """Build a deterministic trade history with the given win/loss profile."""
    trades = []
    for _ in range(n_wins):
        trades.append({"pnl_pct": avg_win_pct})
    for _ in range(n_losses):
        trades.append({"pnl_pct": -avg_loss_pct})
    return trades


def _long_signal(symbol: str = "AAPL", price: float = 150.0) -> dict:
    return {
        "action": "long",
        "symbol": symbol,
        "price": price,
        "entry_price": price,
        "stop_loss": price * 0.98,  # 2% stop
        "stop_loss_pct": 2.0,
        "take_profit_pct": 3.0,
        "target_price": price * 1.05,
        "size_pct": 10.0,
    }


# ---------------------------------------------------------------------------
# (a) mode="kelly" — sizes from win-rate / payoff
# ---------------------------------------------------------------------------

class TestKellyMode:

    def _ctx(self, trades: list[dict], config_override: dict | None = None) -> dict:
        config = {
            "mode": "kelly",
            "kelly_fraction_cap": 0.5,
            "max_position_pct": 15.0,
            "min_trades_required": 10,
            "safety_size_pct": 2.0,
            # pyramid params (ignored in kelly mode but must be present)
            "max_tranches": 3,
            "entry_pct": 40.0,
            "add_pct": 30.0,
            "add_trigger_r": 1.0,
            "trail_stop_after_add": True,
            # fixed param (ignored)
            "fixed_pct": 5.0,
        }
        if config_override:
            config.update(config_override)
        return {
            "pending_signals": [_long_signal()],
            "portfolio_value": 10_000.0,
            "portfolio": {},
            "trade_history": trades,
            "config": config,
        }

    def test_a_kelly_mode_sizes_signal_from_trade_history(self) -> None:
        """With 30+ trades and a decent win rate, on_cycle enriches the signal with kelly key."""
        trades = _trades(n_wins=20, n_losses=10, avg_win_pct=3.0, avg_loss_pct=1.5)
        ctx = self._ctx(trades)
        result = cycle.on_cycle(ctx)

        signals = result["signals"]
        assert len(signals) == 1
        sig = signals[0]
        assert "kelly" in sig, f"Expected 'kelly' key in signal, got keys: {list(sig.keys())}"
        k = sig["kelly"]
        assert k["shares"] > 0, "Kelly sizing must produce at least 1 share"
        assert k["position_pct"] > 0, "position_pct must be positive"
        assert k["position_pct"] <= 15.0, "position_pct must respect max_position_pct"

    def test_a_kelly_mode_result_has_logs(self) -> None:
        trades = _trades(20, 10)
        ctx = self._ctx(trades)
        result = cycle.on_cycle(ctx)
        assert "logs" in result
        assert len(result["logs"]) > 0

    def test_a_kelly_non_long_signals_pass_through_unchanged(self) -> None:
        """Exit signals must not be touched by Kelly sizing."""
        trades = _trades(20, 10)
        ctx = self._ctx(trades)
        ctx["pending_signals"] = [{"action": "exit", "symbol": "AAPL"}]
        result = cycle.on_cycle(ctx)
        assert len(result["signals"]) == 1
        assert "kelly" not in result["signals"][0]
        assert result["signals"][0]["action"] == "exit"


# ---------------------------------------------------------------------------
# (b) mode="pyramid" — tranche plan for new signals, adds for open positions
# ---------------------------------------------------------------------------

class TestPyramidMode:

    def _ctx(self, config_override: dict | None = None) -> dict:
        config = {
            "mode": "pyramid",
            "kelly_fraction_cap": 0.5,
            "max_position_pct": 15.0,
            "min_trades_required": 10,
            "safety_size_pct": 2.0,
            "max_tranches": 3,
            "entry_pct": 40.0,
            "add_pct": 30.0,
            "add_trigger_r": 1.0,
            "trail_stop_after_add": True,
            "fixed_pct": 5.0,
        }
        if config_override:
            config.update(config_override)
        return {
            "pending_signals": [_long_signal()],
            "portfolio_value": 10_000.0,
            "portfolio": {},
            "trade_history": [],
            "config": config,
        }

    def test_b_pyramid_mode_attaches_plan_to_new_signal(self) -> None:
        """New long signal gets size_pct set to first tranche and pyramid_plan attached."""
        ctx = self._ctx()
        result = cycle.on_cycle(ctx)
        signals = result["signals"]
        assert len(signals) == 1
        sig = signals[0]
        assert "pyramid_plan" in sig, f"Expected 'pyramid_plan' key, got: {list(sig.keys())}"
        plan = sig["pyramid_plan"]
        assert plan["total_tranches"] >= 1
        assert "remaining_tranches" in plan
        # size_pct should be the first tranche only (< total)
        assert sig["size_pct"] < 10.0, (
            f"First tranche size_pct ({sig['size_pct']}) should be < total (10.0)"
        )

    def test_b_pyramid_adds_to_winner_open_position(self) -> None:
        """
        An open position that has advanced >= 1 ATR triggers a pyramid_add signal.
        """
        ctx = self._ctx()
        ctx["pending_signals"] = []  # no new signals
        entry = 100.0
        stop = 98.0   # ATR = 2.0
        # current price at entry + 1 ATR → trigger reached
        current = entry + (entry - stop) * 1.0 + 0.01

        ctx["portfolio"] = {
            "TSLA": {
                "current_price": current,
                "entry_price": entry,
                "stop_loss": stop,
                "target_size_pct": 10.0,
                "meta": {
                    "pyramid_plan": {
                        "total_tranches": 3,
                        "executed_tranches": 1,
                        "remaining_tranches": [
                            {"number": 2, "size_pct": 3.0, "trigger_price": current - 0.1}
                        ],
                    }
                },
            }
        }
        result = cycle.on_cycle(ctx)
        add_signals = [s for s in result["signals"] if s.get("type") == "pyramid_add"]
        assert len(add_signals) == 1, (
            f"Expected 1 pyramid_add signal, got {len(add_signals)}. signals={result['signals']}"
        )
        add = add_signals[0]
        assert add["symbol"] == "TSLA"
        assert add["action"] == "long"
        assert add["size_pct"] > 0

    def test_b_pyramid_no_add_when_price_not_reached(self) -> None:
        """Open position that has NOT reached the add trigger emits no add signal."""
        ctx = self._ctx()
        ctx["pending_signals"] = []
        entry = 100.0
        stop = 98.0
        ctx["portfolio"] = {
            "TSLA": {
                "current_price": 100.5,  # barely moved, well short of trigger
                "entry_price": entry,
                "stop_loss": stop,
                "target_size_pct": 10.0,
                "meta": {
                    "pyramid_plan": {
                        "total_tranches": 3,
                        "executed_tranches": 1,
                        "remaining_tranches": [],
                    }
                },
            }
        }
        result = cycle.on_cycle(ctx)
        add_signals = [s for s in result["signals"] if s.get("type") == "pyramid_add"]
        assert len(add_signals) == 0


# ---------------------------------------------------------------------------
# (c) mode="fixed" — uses fixed_pct regardless of history
# ---------------------------------------------------------------------------

class TestFixedMode:

    def _ctx(self, fixed_pct: float = 5.0) -> dict:
        return {
            "pending_signals": [_long_signal()],
            "portfolio_value": 10_000.0,
            "portfolio": {},
            "trade_history": [],  # no history — fixed mode must not need it
            "config": {
                "mode": "fixed",
                "kelly_fraction_cap": 0.5,
                "max_position_pct": 15.0,
                "min_trades_required": 10,
                "safety_size_pct": 2.0,
                "max_tranches": 3,
                "entry_pct": 40.0,
                "add_pct": 30.0,
                "add_trigger_r": 1.0,
                "trail_stop_after_add": True,
                "fixed_pct": fixed_pct,
            },
        }

    def test_c_fixed_mode_uses_fixed_pct(self) -> None:
        """mode=fixed: signal is enriched with a 'fixed' key using fixed_pct."""
        ctx = self._ctx(fixed_pct=5.0)
        result = cycle.on_cycle(ctx)
        signals = result["signals"]
        assert len(signals) == 1
        sig = signals[0]
        assert "fixed" in sig, f"Expected 'fixed' key in signal, got keys: {list(sig.keys())}"
        f = sig["fixed"]
        assert f["position_pct"] == pytest.approx(5.0, abs=0.5), (
            f"Expected ~5% position, got {f['position_pct']}"
        )
        assert f["shares"] > 0

    def test_c_fixed_mode_ignores_trade_history(self) -> None:
        """Fixed mode produces the same result whether or not there is trade history."""
        ctx_no_hist = self._ctx(5.0)
        ctx_with_hist = self._ctx(5.0)
        ctx_with_hist["trade_history"] = _trades(20, 10)

        r1 = cycle.on_cycle(ctx_no_hist)
        r2 = cycle.on_cycle(ctx_with_hist)

        pct1 = r1["signals"][0]["fixed"]["position_pct"]
        pct2 = r2["signals"][0]["fixed"]["position_pct"]
        assert abs(pct1 - pct2) < 0.01, (
            f"Fixed mode must not depend on trade history: {pct1} vs {pct2}"
        )


# ---------------------------------------------------------------------------
# (c2) mode="fixed_fractional_risk" — risk-based sizing (risk-discipline pillar 2)
# ---------------------------------------------------------------------------

class TestFixedFractionalRiskMode:
    """
    fixed_fractional_risk sizes a position so that a stop-out loses exactly
    risk_per_trade_pct of equity: shares = floor((equity * risk_per_trade_pct/100)
    / |entry_price - stop_price|). Stop is read from the signal's 'stop_price' (or
    the atr-stop-loss convention 'stop_loss'), falling back to an ATR-derived stop
    (stop_atr_mult * ATR) when neither is present.
    """

    def _ctx(self, signals: list[dict], config_override: dict | None = None) -> dict:
        config = {
            "mode": "fixed_fractional_risk",
            "risk_per_trade_pct": 1.0,
            "stop_atr_mult": 2.0,
            # Wide open by default so these tests isolate the risk-based sizing math —
            # see test_capped_by_max_position_pct for the ceiling-specific test.
            "max_position_pct": 50.0,
        }
        config.update(config_override or {})
        return {
            "pending_signals": signals,
            "portfolio_value": 10_000.0,
            "portfolio": {},
            "trade_history": [],
            "config": config,
        }

    def test_sizes_from_explicit_stop_price(self) -> None:
        """entry=100, stop=98 (risk=2/share), equity=10000, risk_pct=1% → budget=100 → 50 shares."""
        sig = {**_long_signal(price=100.0), "stop_price": 98.0}
        ctx = self._ctx([sig])
        result = cycle.on_cycle(ctx)
        out = result["signals"][0]
        assert "fixed_fractional_risk" in out
        ffr = out["fixed_fractional_risk"]
        assert ffr["shares"] == 50
        assert ffr["stop_price"] == pytest.approx(98.0)

    def test_falls_back_to_stop_loss_key_atr_stop_loss_convention(self) -> None:
        """No 'stop_price' but a 'stop_loss' key (atr-stop-loss plugin convention) is used."""
        sig = {**_long_signal(price=100.0), "stop_loss": 95.0}
        sig.pop("stop_loss_pct", None)
        ctx = self._ctx([sig])
        result = cycle.on_cycle(ctx)
        out = result["signals"][0]
        ffr = out["fixed_fractional_risk"]
        # risk/share=5, budget=100 → 20 shares
        assert ffr["shares"] == 20
        assert ffr["stop_price"] == pytest.approx(95.0)

    def test_wider_stop_yields_smaller_position_inverse_relationship(self) -> None:
        """A wider stop (more risk/share) must produce a SMALLER position for the same budget."""
        tight = self._ctx([{**_long_signal(price=100.0), "stop_price": 99.0}])  # risk=1/share
        wide = self._ctx([{**_long_signal(price=100.0), "stop_price": 90.0}])  # risk=10/share

        tight_shares = cycle.on_cycle(tight)["signals"][0]["fixed_fractional_risk"]["shares"]
        wide_shares = cycle.on_cycle(wide)["signals"][0]["fixed_fractional_risk"]["shares"]

        assert wide_shares < tight_shares, (
            f"wider stop should size smaller: wide={wide_shares} tight={tight_shares}"
        )

    def test_derives_stop_from_atr_when_no_explicit_stop_present(self) -> None:
        """No stop_price/stop_loss, but atr14 is present (atr-stop-loss output) → ATR*mult."""
        sig = {**_long_signal(price=100.0), "atr14": 2.5}
        sig.pop("stop_loss", None)
        ctx = self._ctx([sig], {"stop_atr_mult": 2.0})
        result = cycle.on_cycle(ctx)
        out = result["signals"][0]
        ffr = out["fixed_fractional_risk"]
        # stop = 100 - 2.5*2 = 95 → risk/share=5 → budget=100 → 20 shares
        assert ffr["stop_price"] == pytest.approx(95.0)
        assert ffr["shares"] == 20

    def test_short_direction_derives_stop_above_entry(self) -> None:
        sig = {
            "action": "short",
            "symbol": "AAPL",
            "price": 100.0,
            "entry_price": 100.0,
            "atr14": 2.0,
        }
        ctx = self._ctx([sig], {"stop_atr_mult": 2.0})
        result = cycle.on_cycle(ctx)
        out = result["signals"][0]
        ffr = out["fixed_fractional_risk"]
        assert ffr["stop_price"] == pytest.approx(104.0)

    def test_no_stop_available_skips_signal_with_warning(self) -> None:
        """No stop_price/stop_loss/atr14/closes → cannot size; signal passes through unsized."""
        sig = _long_signal(price=100.0)
        sig.pop("stop_loss", None)
        ctx = self._ctx([sig])
        result = cycle.on_cycle(ctx)
        out = result["signals"][0]
        assert "fixed_fractional_risk" not in out
        assert any(log["level"] == "warning" for log in result["logs"])

    def test_capped_by_max_position_pct(self) -> None:
        """A very tight stop would otherwise risk-size a huge position — capped by the ceiling."""
        sig = {**_long_signal(price=100.0), "stop_price": 99.9}  # risk/share=0.1 → huge raw size
        ctx = self._ctx([sig], {"risk_per_trade_pct": 1.0, "max_position_pct": 10.0})
        result = cycle.on_cycle(ctx)
        out = result["signals"][0]["fixed_fractional_risk"]
        # capped at 10% of 10000 = 1000 usd / 100 price = 10 shares
        assert out["shares"] == 10
        assert out["capped_by_max_position"] is True

    def test_non_long_short_signals_pass_through_unmodified(self) -> None:
        sig = {"action": "hold", "symbol": "AAPL"}
        ctx = self._ctx([sig])
        result = cycle.on_cycle(ctx)
        assert result["signals"] == [sig]


# ---------------------------------------------------------------------------
# (d) kelly_fraction_cap limits computed Kelly fraction
# ---------------------------------------------------------------------------

class TestKellyFractionCap:

    def test_d_kelly_fraction_is_capped(self) -> None:
        """
        With a very favorable win rate / payoff, uncapped Kelly would be large.
        kelly_fraction_cap must clamp it so position_pct <= max_position_pct.
        """
        # 80% win rate, 4:1 payoff → raw Kelly ≈ 0.75 (very aggressive)
        trades = _trades(n_wins=80, n_losses=20, avg_win_pct=4.0, avg_loss_pct=1.0)

        # Compute uncapped stats first
        stats = stats_from_trades(trades, min_required=10)
        kelly_full = stats.kelly_full

        # Apply cap of 0.25 (much lower than the full Kelly)
        cap = 0.25
        capped = compute_kelly(stats.win_rate, stats.payoff_ratio, fraction=cap)
        assert capped <= kelly_full, "Capped Kelly must be <= full Kelly"

        # Now via on_cycle
        ctx = {
            "pending_signals": [_long_signal(price=100.0)],
            "portfolio_value": 10_000.0,
            "portfolio": {},
            "trade_history": trades,
            "config": {
                "mode": "kelly",
                "kelly_fraction_cap": cap,
                "max_position_pct": 15.0,
                "min_trades_required": 10,
                "safety_size_pct": 2.0,
                "max_tranches": 3,
                "entry_pct": 40.0,
                "add_pct": 30.0,
                "add_trigger_r": 1.0,
                "trail_stop_after_add": True,
                "fixed_pct": 5.0,
            },
        }
        result = cycle.on_cycle(ctx)
        sig = result["signals"][0]
        assert "kelly" in sig
        # position_pct is computed from capped Kelly / stop_loss_pct
        # With cap=0.25, stop=2%, position_pct = 0.25/0.02 = 12.5% clamped to max 15%
        assert sig["kelly"]["position_pct"] <= 15.0, (
            f"position_pct {sig['kelly']['position_pct']} exceeds max_position_pct=15"
        )

    def test_d_pure_kelly_math_cap(self) -> None:
        """compute_kelly with fraction=0.5 returns exactly half the full Kelly."""
        win_rate = 0.6
        payoff = 2.0
        # f* = (0.6*2 - 0.4) / 2 = 0.8/2 = 0.4
        full = compute_kelly(win_rate, payoff, fraction=1.0)
        half = compute_kelly(win_rate, payoff, fraction=0.5)
        assert full == pytest.approx(0.4, abs=1e-9)
        assert half == pytest.approx(0.2, abs=1e-9)


# ---------------------------------------------------------------------------
# (e) Edge case: no trade history → safe degradation
# ---------------------------------------------------------------------------

class TestEdgeCases:

    def test_e_no_trade_history_kelly_mode_uses_safety_size(self) -> None:
        """
        With 0 trades, kelly mode must not crash.
        It must fall back to safety_size_pct and add a warning/log.
        """
        ctx = {
            "pending_signals": [_long_signal()],
            "portfolio_value": 10_000.0,
            "portfolio": {},
            "trade_history": [],
            "config": {
                "mode": "kelly",
                "kelly_fraction_cap": 0.5,
                "max_position_pct": 15.0,
                "min_trades_required": 10,
                "safety_size_pct": 2.0,
                "max_tranches": 3,
                "entry_pct": 40.0,
                "add_pct": 30.0,
                "add_trigger_r": 1.0,
                "trail_stop_after_add": True,
                "fixed_pct": 5.0,
            },
        }
        result = cycle.on_cycle(ctx)
        assert "signals" in result
        assert len(result["signals"]) == 1
        sig = result["signals"][0]
        assert "kelly" in sig, "Even safety-mode must attach the 'kelly' key"
        assert sig["kelly"]["shares"] >= 0, "shares must be non-negative"
        # Safety size = 2%, position = 2%/2% stop = 100%... capped to max_position_pct
        # Actually: safety_size_pct=2 → position = capital * 0.02 → valid
        assert sig["kelly"]["position_pct"] <= 15.0

        # At least one log must mention safety / insufficient history
        logs = result["logs"]
        safety_logs = [
            log for log in logs
            if "seguro" in log["msg"].lower() or "safety" in log["msg"].lower()
            or "mínimo" in log["msg"].lower() or "minimum" in log["msg"].lower()
            or "insuficiente" in log["msg"].lower() or "insufficient" in log["msg"].lower()
        ]
        assert len(safety_logs) > 0, (
            f"Expected a safety/warning log. Got: {[log['msg'] for log in logs]}"
        )

    def test_e_no_trade_history_fixed_mode_works(self) -> None:
        """Fixed mode must work with 0 trade history — no crash, correct sizing."""
        ctx = {
            "pending_signals": [_long_signal()],
            "portfolio_value": 10_000.0,
            "portfolio": {},
            "trade_history": [],
            "config": {
                "mode": "fixed",
                "kelly_fraction_cap": 0.5,
                "max_position_pct": 15.0,
                "min_trades_required": 10,
                "safety_size_pct": 2.0,
                "max_tranches": 3,
                "entry_pct": 40.0,
                "add_pct": 30.0,
                "add_trigger_r": 1.0,
                "trail_stop_after_add": True,
                "fixed_pct": 3.0,
            },
        }
        result = cycle.on_cycle(ctx)
        sig = result["signals"][0]
        assert "fixed" in sig
        assert sig["fixed"]["shares"] >= 0

    def test_e_zero_price_signal_is_skipped(self) -> None:
        """A signal with price=0 must be dropped or pass through without crash."""
        ctx = {
            "pending_signals": [{"action": "long", "symbol": "BAD", "price": 0.0}],
            "portfolio_value": 10_000.0,
            "portfolio": {},
            "trade_history": _trades(20, 10),
            "config": {
                "mode": "kelly",
                "kelly_fraction_cap": 0.5,
                "max_position_pct": 15.0,
                "min_trades_required": 10,
                "safety_size_pct": 2.0,
                "max_tranches": 3,
                "entry_pct": 40.0,
                "add_pct": 30.0,
                "add_trigger_r": 1.0,
                "trail_stop_after_add": True,
                "fixed_pct": 5.0,
            },
        }
        # Must not raise
        result = cycle.on_cycle(ctx)
        assert "signals" in result

    def test_e_unknown_mode_raises_value_error(self) -> None:
        """An unrecognised mode must raise ValueError immediately."""
        ctx = {
            "pending_signals": [_long_signal()],
            "portfolio_value": 10_000.0,
            "portfolio": {},
            "trade_history": [],
            "config": {"mode": "turbo_laser_sizing"},
        }
        with pytest.raises(ValueError, match="mode"):
            cycle.on_cycle(ctx)

    def test_e_empty_pending_signals_returns_empty_list(self) -> None:
        """on_cycle with no pending signals and no open positions returns empty signals."""
        ctx = {
            "pending_signals": [],
            "portfolio_value": 10_000.0,
            "portfolio": {},
            "trade_history": [],
            "config": {"mode": "fixed", "fixed_pct": 5.0},
        }
        result = cycle.on_cycle(ctx)
        assert result["signals"] == []


# ---------------------------------------------------------------------------
# (f) mode="vol_target" — inverse-vol / risk-parity weighting
# (design doc: docs/design/trading-strategy.md step 4 — w_i ∝ 1/σ_i)
# ---------------------------------------------------------------------------

class TestVolTargetMode:

    def _ctx(self, signals: list[dict], config_override: dict | None = None) -> dict:
        config = {
            "mode": "vol_target",
            "max_position_pct": 50.0,  # loose cap so the math isn't clipped in tests
            "default_volatility_pct": 20.0,
        }
        if config_override:
            config.update(config_override)
        return {
            "pending_signals": signals,
            "portfolio_value": 10_000.0,
            "portfolio": {},
            "trade_history": [],
            "config": config,
        }

    def test_f_higher_vol_asset_gets_smaller_weight(self) -> None:
        low_vol = {**_long_signal("LOWVOL"), "volatility_12m": 0.10}
        high_vol = {**_long_signal("HIGHVOL"), "volatility_12m": 0.30}
        ctx = self._ctx([low_vol, high_vol])
        result = cycle.on_cycle(ctx)

        by_symbol = {s["symbol"]: s for s in result["signals"]}
        low = by_symbol["LOWVOL"]["vol_target"]
        high = by_symbol["HIGHVOL"]["vol_target"]

        assert low["weight"] > high["weight"], (
            "lower-vol asset must receive a LARGER inverse-vol weight"
        )
        assert low["position_pct"] > high["position_pct"]

    def test_f_weights_sum_to_one_before_capping(self) -> None:
        sigs = [
            {**_long_signal("A"), "volatility_12m": 0.10},
            {**_long_signal("B"), "volatility_12m": 0.20},
            {**_long_signal("C"), "volatility_12m": 0.30},
        ]
        ctx = self._ctx(sigs)
        result = cycle.on_cycle(ctx)
        total_weight = sum(s["vol_target"]["weight"] for s in result["signals"])
        assert total_weight == pytest.approx(1.0, abs=1e-6)

    def test_f_position_pct_respects_max_position_pct_cap(self) -> None:
        # A single signal would get 100% weight uncapped — must be clamped.
        sigs = [{**_long_signal("A"), "volatility_12m": 0.10}]
        ctx = self._ctx(sigs, {"max_position_pct": 12.0})
        result = cycle.on_cycle(ctx)
        sig = result["signals"][0]
        assert sig["vol_target"]["position_pct"] <= 12.0

    def test_f_missing_volatility_falls_back_safely_with_a_log(self) -> None:
        sigs = [{**_long_signal("NOVOL")}]  # no volatility_12m field
        ctx = self._ctx(sigs)
        result = cycle.on_cycle(ctx)
        sig = result["signals"][0]
        assert "vol_target" in sig  # must not crash / must still size the signal
        assert any("volatility" in log["msg"].lower() for log in result["logs"])

    def test_f_non_long_signals_pass_through_unchanged(self) -> None:
        ctx = self._ctx([{"action": "exit", "symbol": "AAPL"}])
        result = cycle.on_cycle(ctx)
        assert len(result["signals"]) == 1
        assert "vol_target" not in result["signals"][0]
        assert result["signals"][0]["action"] == "exit"


class TestComputeInverseVolWeights:

    def test_pinned_two_asset_weights(self) -> None:
        # vol A=0.10 -> raw 10, vol B=0.20 -> raw 5, sum=15
        weights = compute_inverse_vol_weights({"A": 0.10, "B": 0.20})
        assert weights["A"] == pytest.approx(10 / 15, abs=1e-6)
        assert weights["B"] == pytest.approx(5 / 15, abs=1e-6)

    def test_equal_vol_gives_equal_weights(self) -> None:
        weights = compute_inverse_vol_weights({"A": 0.15, "B": 0.15, "C": 0.15})
        assert weights["A"] == pytest.approx(1 / 3, abs=1e-6)
        assert weights["B"] == pytest.approx(1 / 3, abs=1e-6)
        assert weights["C"] == pytest.approx(1 / 3, abs=1e-6)

    def test_weights_sum_to_one(self) -> None:
        weights = compute_inverse_vol_weights({"A": 0.05, "B": 0.40, "C": 0.12, "D": 0.25})
        assert sum(weights.values()) == pytest.approx(1.0, abs=1e-9)

    def test_zero_volatility_does_not_crash(self) -> None:
        """Zero/negative vol must fall back to a small epsilon, not raise ZeroDivisionError."""
        weights = compute_inverse_vol_weights({"A": 0.0, "B": 0.20})
        assert weights["A"] > weights["B"], "near-zero vol asset gets the largest weight"
        assert sum(weights.values()) == pytest.approx(1.0, abs=1e-9)

    def test_empty_input_returns_empty(self) -> None:
        assert compute_inverse_vol_weights({}) == {}


# ---------------------------------------------------------------------------
# Unit tests for pure math functions
# ---------------------------------------------------------------------------

class TestPureMath:

    def test_stats_from_trades_empty(self) -> None:
        stats = stats_from_trades([], min_required=10)
        assert stats.is_reliable is False
        assert stats.win_rate == 0.0
        assert stats.payoff_ratio == 0.0

    def test_stats_from_trades_below_minimum(self) -> None:
        trades = _trades(5, 5)
        stats = stats_from_trades(trades, min_required=30)
        assert stats.is_reliable is False
        assert stats.n_trades == 10

    def test_stats_from_trades_reliable(self) -> None:
        trades = _trades(20, 10)
        stats = stats_from_trades(trades, min_required=10)
        assert stats.is_reliable is True
        assert stats.win_rate == pytest.approx(2 / 3, abs=1e-4)
        assert stats.payoff_ratio == pytest.approx(3.0 / 1.5, abs=1e-4)  # 2.0

    def test_compute_kelly_negative_ev(self) -> None:
        """Negative expected value → kelly should return 0."""
        # win_rate=0.3, payoff=1.0 → f* = (0.3*1 - 0.7)/1 = -0.4 → clamp to 0
        k = compute_kelly(0.3, 1.0, fraction=1.0)
        assert k == pytest.approx(0.0, abs=1e-9)

    def test_compute_kelly_invalid_inputs(self) -> None:
        assert compute_kelly(0.0, 2.0) == 0.0
        assert compute_kelly(1.0, 2.0) == 0.0
        assert compute_kelly(0.6, 0.0) == 0.0

    def test_position_size_safety_fallback(self) -> None:
        result = position_size(
            capital=10_000,
            price=100.0,
            stop_loss_pct=2.0,
            take_profit_pct=3.0,
            kelly_fraction=0.0,
            max_position_pct=15.0,
            safety_size_pct=2.0,
            use_safety=True,
        )
        # 2% of 10000 = 200, shares = floor(200/100) = 2
        assert result.shares == 2
        assert result.warning is not None

    def test_position_size_fixed_fractional_risk_exact_risk_budget(self) -> None:
        """shares * risk_per_share must equal exactly the risk budget (equity * risk_pct)."""
        result = position_size_fixed_fractional_risk(
            equity=10_000.0,
            entry_price=100.0,
            stop_price=98.0,
            risk_per_trade_pct=1.0,
            max_position_pct=50.0,  # wide open — not the ceiling under test here
        )
        assert result.shares == 50
        assert result.risk_usd == pytest.approx(100.0, abs=0.01)

    def test_position_size_fixed_fractional_risk_wider_stop_smaller_size(self) -> None:
        tight = position_size_fixed_fractional_risk(10_000.0, 100.0, 99.0, 1.0, 50.0)
        wide = position_size_fixed_fractional_risk(10_000.0, 100.0, 90.0, 1.0, 50.0)
        assert wide.shares < tight.shares

    def test_position_size_fixed_fractional_risk_invalid_inputs_safe(self) -> None:
        result = position_size_fixed_fractional_risk(0.0, 100.0, 98.0, 1.0, 10.0)
        assert result.shares == 0
        assert result.warning is not None

        same_price_stop = position_size_fixed_fractional_risk(10_000.0, 100.0, 100.0, 1.0, 10.0)
        assert same_price_stop.shares == 0

    def test_resolve_stop_price_prefers_explicit_stop_price(self) -> None:
        sig = {"stop_price": 95.0, "stop_loss": 90.0, "atr14": 5.0}
        stop, source = resolve_stop_price(sig, entry_price=100.0, direction="long")
        assert stop == pytest.approx(95.0)
        assert source == "signal"

    def test_resolve_stop_price_falls_back_to_atr(self) -> None:
        sig = {"atr14": 3.0}
        stop, source = resolve_stop_price(
            sig, entry_price=100.0, direction="long", stop_atr_mult=2.0
        )
        assert stop == pytest.approx(94.0)
        assert source == "atr"

    def test_resolve_stop_price_none_when_nothing_available(self) -> None:
        stop, source = resolve_stop_price({}, entry_price=100.0, direction="long")
        assert stop is None
        assert source is None

    def test_calculate_tranches_plan_structure(self) -> None:
        plan = calculate_tranches(
            symbol="AAPL",
            entry_price=150.0,
            stop_loss=147.0,
            target_price=160.0,
            total_size_pct=9.0,
            entry_pct=40.0,
            add_pct=30.0,
            max_tranches=3,
            add_trigger_r=1.0,
        )
        assert len(plan.tranches) == 3
        assert plan.tranches[0].number == 1
        # First tranche = 40% of 9% = 3.6%
        assert plan.tranches[0].size_pct == pytest.approx(3.6, abs=0.01)
        # Trigger for tranche 2 = entry + 1 ATR
        atr = abs(150.0 - 147.0)
        assert plan.tranches[1].trigger_price == pytest.approx(150.0 + atr, abs=0.001)
