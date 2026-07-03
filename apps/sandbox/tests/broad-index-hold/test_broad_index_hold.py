"""
Tests for the broad-index-hold plugin — a minimal, no-ranking buy-and-hold
skill used as the base book for the vol-managed-exposure strategy (batch 6
research: "vol-managed SPY" — Sharpe 0.96 vs SPY buy-hold's 0.78). This
plugin intentionally does NOTHING clever: it emits a single long/buy signal
per configured symbol, once, the first cycle it's not already held. No
ranking, no periodic rebalance, no exits — the actual exposure discipline
(vol-target scaling) lives in risk-manager's exposure_scalar output and is
applied by the pipeline, not by this plugin.

Strict TDD: written BEFORE implementation.
"""

from __future__ import annotations

import importlib.util as _ilu
import os


def _load_on_cycle(plugin: str):
    root = os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "plugins", plugin)
    spec = _ilu.spec_from_file_location(
        "_cycle_" + plugin.replace("-", "_"), os.path.join(root, "hooks", "cycle.py")
    )
    mod = _ilu.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.on_cycle


on_cycle = _load_on_cycle("broad-index-hold")


def _ctx(**overrides) -> dict:
    base = {
        "universe": ["SPY", "QQQ", "AAPL"],
        "portfolio": {},
        "config": {},
        "provider_tools": {},
    }
    base.update(overrides)
    return base


class TestBroadIndexHold:
    def test_a1_default_symbols_is_spy_only(self) -> None:
        """Default config emits exactly one long signal for SPY."""
        result = on_cycle(_ctx())
        assert len(result["signals"]) == 1
        assert result["signals"][0]["symbol"] == "SPY"
        assert result["signals"][0]["action"] == "long"

    def test_a2_already_held_symbol_is_not_re_signaled(self) -> None:
        """If SPY is already in the portfolio, no new signal is emitted (no pyramiding)."""
        result = on_cycle(_ctx(portfolio={"SPY": {"quantity": 10, "avg_price": 400.0}}))
        assert result["signals"] == []

    def test_a3_configurable_equal_weight_basket(self) -> None:
        """config.symbols lets the book hold an equal-weight basket instead of SPY-only."""
        result = on_cycle(_ctx(config={"symbols": ["SPY", "QQQ", "IWM"]}))
        symbols = {s["symbol"] for s in result["signals"]}
        assert symbols == {"SPY", "QQQ", "IWM"}
        assert all(s["action"] == "long" for s in result["signals"])

    def test_a4_no_ranking_no_conditional_logic_all_configured_symbols_signal(self) -> None:
        """Unlike momentum/mean-reversion, there is no ranking or threshold — every
        configured symbol not already held gets a signal, unconditionally."""
        result = on_cycle(_ctx(config={"symbols": ["AAPL", "MSFT"]}, universe=[]))
        assert {s["symbol"] for s in result["signals"]} == {"AAPL", "MSFT"}

    def test_a5_returns_required_keys(self) -> None:
        result = on_cycle(_ctx())
        assert "signals" in result
        assert "logs" in result
        assert isinstance(result["logs"], list)

    def test_a7_comma_separated_string_symbols_supported(self) -> None:
        """manifest config stores symbols as a comma-separated string; parsed and
        uppercased identically to a list."""
        result = on_cycle(_ctx(config={"symbols": "spy, qqq"}))
        assert {s["symbol"] for s in result["signals"]} == {"SPY", "QQQ"}

    def test_a6_partial_holding_only_signals_missing_symbols(self) -> None:
        result = on_cycle(
            _ctx(
                config={"symbols": ["SPY", "QQQ"]},
                portfolio={"SPY": {"quantity": 5, "avg_price": 400.0}},
            )
        )
        assert {s["symbol"] for s in result["signals"]} == {"QQQ"}
