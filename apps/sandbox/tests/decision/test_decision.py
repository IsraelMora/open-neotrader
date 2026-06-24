"""
TDD tests for plugins/decision/plugin.py — the LLM's trade-intent action tool.

The LLM calls emit_trade_intent(symbol, action, confidence, rationale) to express
ONE decision after reasoning over context. It NEVER receives prices. The function
is invoked by runner.cmd_call_plugin as fn(**args, _context=ctx).

Run: cd apps/sandbox && python3 -m pytest tests/decision/ -v
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_PLUGIN = Path(__file__).parents[4] / "plugins" / "decision" / "plugin.py"


def _load():
    spec = importlib.util.spec_from_file_location("_decision_plugin_under_test", str(_PLUGIN))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


@pytest.fixture(scope="module")
def plugin():
    return _load()


class TestEmitTradeIntent:
    def test_valid_long_returns_ok_structured(self, plugin):
        r = plugin.emit_trade_intent(
            symbol="aapl", action="long", confidence=0.8,
            rationale="Breadth bullish + earnings beat", _context=None,
        )
        assert r["ok"] is True
        res = r["result"]
        assert res["symbol"] == "AAPL"  # normalized upper
        assert res["action"] == "long"
        assert res["confidence"] == pytest.approx(0.8)
        assert res["rationale"] == "Breadth bullish + earnings beat"
        assert res["status"] == "recorded"
        assert res["timeframe"] == "1d"  # default

    @pytest.mark.parametrize("action", ["long", "short", "exit", "hold"])
    def test_all_valid_actions_accepted(self, plugin, action):
        r = plugin.emit_trade_intent(symbol="SPY", action=action, confidence=0.5,
                                     rationale="x", _context=None)
        assert r["ok"] is True

    def test_invalid_action_rejected(self, plugin):
        r = plugin.emit_trade_intent(symbol="SPY", action="moon", confidence=0.5,
                                     rationale="x", _context=None)
        assert r["ok"] is False
        assert "action" in r["error"]

    def test_confidence_out_of_range_rejected(self, plugin):
        r = plugin.emit_trade_intent(symbol="SPY", action="long", confidence=1.5,
                                     rationale="x", _context=None)
        assert r["ok"] is False
        assert "confidence" in r["error"]

    def test_confidence_non_numeric_rejected(self, plugin):
        r = plugin.emit_trade_intent(symbol="SPY", action="long", confidence="high",
                                     rationale="x", _context=None)
        assert r["ok"] is False

    def test_empty_symbol_rejected(self, plugin):
        r = plugin.emit_trade_intent(symbol="  ", action="long", confidence=0.5,
                                     rationale="x", _context=None)
        assert r["ok"] is False
        assert "symbol" in r["error"]

    def test_missing_rationale_rejected(self, plugin):
        r = plugin.emit_trade_intent(symbol="SPY", action="long", confidence=0.5,
                                     rationale="", _context=None)
        assert r["ok"] is False
        assert "rationale" in r["error"]

    def test_unexpected_price_args_are_ignored_not_crash(self, plugin):
        """The LLM must not pass prices, but if extra args slip in, ignore them."""
        r = plugin.emit_trade_intent(
            symbol="SPY", action="long", confidence=0.6, rationale="x",
            prices=[1, 2, 3], closes=[1.0], _context=None,
        )
        assert r["ok"] is True
        assert "prices" not in r["result"]

    def test_custom_timeframe_preserved(self, plugin):
        r = plugin.emit_trade_intent(symbol="SPY", action="long", confidence=0.6,
                                     rationale="x", timeframe="1h", _context=None)
        assert r["result"]["timeframe"] == "1h"
