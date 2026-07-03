"""
Tests for the trend-following on_cycle hook — long-only v1 guarantee.

STRICT TDD — written before verifying the hook.

The design doc (docs/design/trading-strategy.md) mandates long-only v1: this
plugin's analyze() can vote "short" internally (three-indicator consensus),
but the hook MUST NEVER open a short position. A "short"/"exit" vote must
only ever close an existing long (action="exit"), and must be a no-op when
there is no open position. A "long" vote must never fire if already in
position (no re-entry pyramiding here — that's position-sizing's job).
"""

from __future__ import annotations

import math
import os
import sys

_PLUGIN_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "plugins", "trend-following")
)


def _load_on_cycle(plugin_root: str):
    """
    Load this plugin's hooks/cycle.py under a unique module name.

    Every plugin's hook file is named cycle.py — a bare `from cycle import`
    collides via sys.modules across the full pytest session. See
    tests/market-context/test_market_context.py for the same pattern.
    """
    import importlib.util as _ilu

    spec = _ilu.spec_from_file_location(
        "_cycle_trend_following", os.path.join(plugin_root, "hooks", "cycle.py")
    )
    module = _ilu.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.on_cycle


on_cycle = _load_on_cycle(_PLUGIN_ROOT)


def _bars_trending_up(n: int = 120, start: float = 100.0) -> list[dict]:
    bars = []
    for i in range(n):
        price = start + 0.5 * i + 0.02 * i * i
        noise = 0.1 * math.sin(i * 1.7)
        close = price + noise
        bars.append(
            {
                "date": f"2023-UP-{i:04d}",
                "open": close - 0.3,
                "high": close + 0.5,
                "low": close - 0.5,
                "close": close,
                "volume": 1_000_000,
            }
        )
    return bars


def _bars_trending_down(n: int = 120, start: float = 300.0) -> list[dict]:
    bars = []
    for i in range(n):
        price = start - 0.5 * i - 0.02 * i * i
        noise = 0.1 * math.sin(i * 1.7)
        close = price + noise
        bars.append(
            {
                "date": f"2023-DW-{i:04d}",
                "open": close + 0.3,
                "high": close + 0.5,
                "low": close - 0.5,
                "close": close,
                "volume": 1_000_000,
            }
        )
    return bars


def _get_ohlcv_factory(bars_by_symbol: dict[str, list[dict]]):
    def _get_ohlcv(symbol: str, timeframe: str = "1d", limit: int = 88):
        bars = bars_by_symbol.get(symbol, [])
        return bars[-limit:] if limit else bars

    return _get_ohlcv


class TestLongEntry:
    def test_uptrend_not_in_position_emits_long(self) -> None:
        ctx = {
            "universe": ["AAA"],
            "config": {},
            "portfolio": {},
            "provider_tools": {"get_ohlcv": _get_ohlcv_factory({"AAA": _bars_trending_up()})},
        }
        result = on_cycle(ctx)
        actions = {s["symbol"]: s["action"] for s in result["signals"]}
        assert actions.get("AAA") == "long"

    def test_uptrend_already_in_position_does_not_re_enter(self) -> None:
        ctx = {
            "universe": ["AAA"],
            "config": {},
            "portfolio": {"AAA": {"qty": 10}},
            "provider_tools": {"get_ohlcv": _get_ohlcv_factory({"AAA": _bars_trending_up()})},
        }
        result = on_cycle(ctx)
        symbols = {s["symbol"] for s in result["signals"]}
        assert "AAA" not in symbols


class TestExitOnDowntrend:
    def test_downtrend_in_position_emits_exit_never_short(self) -> None:
        ctx = {
            "universe": ["AAA"],
            "config": {},
            "portfolio": {"AAA": {"qty": 10}},
            "provider_tools": {"get_ohlcv": _get_ohlcv_factory({"AAA": _bars_trending_down()})},
        }
        result = on_cycle(ctx)
        actions = {s["symbol"]: s["action"] for s in result["signals"]}
        assert actions.get("AAA") == "exit"
        assert "short" not in actions.values(), "long-only v1 must never emit a short action"

    def test_downtrend_not_in_position_is_a_no_op(self) -> None:
        """No open long to close — the hook must not emit anything (and never short)."""
        ctx = {
            "universe": ["AAA"],
            "config": {},
            "portfolio": {},
            "provider_tools": {"get_ohlcv": _get_ohlcv_factory({"AAA": _bars_trending_down()})},
        }
        result = on_cycle(ctx)
        symbols = {s["symbol"] for s in result["signals"]}
        assert "AAA" not in symbols


class TestNeverShort:
    def test_no_signal_in_this_plugin_ever_has_action_short(self) -> None:
        ctx = {
            "universe": ["UP", "DOWN"],
            "config": {},
            "portfolio": {"UP": {"qty": 1}, "DOWN": {"qty": 1}},
            "provider_tools": {
                "get_ohlcv": _get_ohlcv_factory(
                    {"UP": _bars_trending_up(), "DOWN": _bars_trending_down()}
                )
            },
        }
        result = on_cycle(ctx)
        actions = [s["action"] for s in result["signals"]]
        assert "short" not in actions
        assert set(actions) <= {"long", "exit"}
