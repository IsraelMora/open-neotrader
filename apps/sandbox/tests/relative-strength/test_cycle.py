"""
Bug B regression: relative-strength/hooks/cycle.py must read ctx["ohlcv"][symbol]
as a LIST of bar dicts ({open,high,low,close,volume,date}, oldest→newest) — the
same shape momentum-factor-12-1 and trend-following read — instead of treating it
as a dict with a "closes" key. The old `.get("closes", [])` call raised an
AttributeError on every symbol (list has no .get), which on_cycle swallowed via
compute_composite_rs/analyze_relative_strength returning None, so the plugin
silently emitted zero signals forever.

STRICT TDD: these tests build realistic ctx["ohlcv"] (list-of-bar-dicts) and assert
the hook now returns non-empty RS signals, while empty/missing symbol data still
safely yields no signal (no crash, no AttributeError).
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

HOOK_PATH = (
    Path(__file__).parent.parent.parent.parent.parent
    / "plugins"
    / "relative-strength"
    / "hooks"
    / "cycle.py"
)


def _load_cycle_module():
    """Load hooks/cycle.py the same way runner.py's _load_cycle_hook does: put the
    plugin's scripts/ dir on sys.path first so `from rs import ...` resolves."""
    scripts_dir = HOOK_PATH.parent.parent / "scripts"
    scripts_str = str(scripts_dir)
    if scripts_str not in sys.path:
        sys.path.insert(0, scripts_str)

    spec = importlib.util.spec_from_file_location("_rs_cycle_test", HOOK_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def _bar(close: float, i: int) -> dict:
    return {
        "date": f"2024-01-{(i % 28) + 1:02d}",
        "open": close - 0.1,
        "high": close + 0.2,
        "low": close - 0.2,
        "close": close,
        "volume": 1_000,
    }


def _flat_series(price: float, n: int) -> list[dict]:
    return [_bar(price, i) for i in range(n)]


def _rally_series(base: float, flat_n: int, rally_n: int, rally_price: float) -> list[dict]:
    return [_bar(base, i) for i in range(flat_n)] + [
        _bar(rally_price, flat_n + i) for i in range(rally_n)
    ]


class TestRelativeStrengthCycleHook:
    def setup_method(self) -> None:
        self.mod = _load_cycle_module()

    def test_returns_non_empty_rs_signals_with_realistic_list_of_bar_dicts_ohlcv(self) -> None:
        """ctx["ohlcv"] is a dict of symbol -> LIST of bar dicts (the real shape).
        A symbol that genuinely outperforms the benchmark must get a 'long' signal —
        proving closes are actually extracted (not silently swallowed by an
        AttributeError from treating the list as a dict)."""
        benchmark_bars = _flat_series(100.0, 260)
        outperformer_bars = _rally_series(100.0, 200, 60, 200.0)
        laggard_bars = _flat_series(100.0, 260)

        ctx = {
            "universe": ["AAA", "BBB", "SPY"],
            "ohlcv": {
                "SPY": benchmark_bars,
                "AAA": outperformer_bars,
                "BBB": laggard_bars,
            },
            "config": {
                "periods": [63],
                "weights": [1.0],
                "benchmark": "SPY",
                "rs_threshold": 1.05,
                "top_percentile": 50.0,
            },
        }

        result = self.mod.on_cycle(ctx)

        assert result["signals"], f"Expected non-empty RS signals, got {result}"
        by_symbol = {s["symbol"]: s for s in result["signals"]}
        assert "AAA" in by_symbol, f"Expected AAA (outperformer) to get a signal; got {by_symbol}"
        assert by_symbol["AAA"]["action"] == "long"
        assert by_symbol["AAA"]["meta"]["composite_rs"] > 1.05

    def test_missing_symbol_data_is_skipped_without_crashing(self) -> None:
        """A symbol absent from ctx["ohlcv"] (or with an empty bar list) must be
        safely skipped — no AttributeError, no signal for it."""
        benchmark_bars = _flat_series(100.0, 260)

        ctx = {
            "universe": ["AAA", "MISSING", "SPY"],
            "ohlcv": {
                "SPY": benchmark_bars,
                "AAA": _flat_series(100.0, 260),
                # "MISSING" intentionally absent from ohlcv
            },
            "config": {
                "periods": [63],
                "weights": [1.0],
                "benchmark": "SPY",
                "rs_threshold": 1.05,
                "top_percentile": 50.0,
            },
        }

        result = self.mod.on_cycle(ctx)  # must not raise

        assert "MISSING" in result["meta"]["skipped"]
        assert all(s["symbol"] != "MISSING" for s in result["signals"])

    def test_empty_bar_list_for_symbol_is_skipped_without_crashing(self) -> None:
        """A symbol present in ohlcv but with an EMPTY bar list ([]) must also be
        safely skipped, not raise."""
        benchmark_bars = _flat_series(100.0, 260)

        ctx = {
            "universe": ["AAA", "EMPTY", "SPY"],
            "ohlcv": {
                "SPY": benchmark_bars,
                "AAA": _flat_series(100.0, 260),
                "EMPTY": [],
            },
            "config": {
                "periods": [63],
                "weights": [1.0],
                "benchmark": "SPY",
                "rs_threshold": 1.05,
                "top_percentile": 50.0,
            },
        }

        result = self.mod.on_cycle(ctx)  # must not raise

        assert "EMPTY" in result["meta"]["skipped"]
        assert all(s["symbol"] != "EMPTY" for s in result["signals"])

    def test_missing_benchmark_data_returns_empty_signals_with_error_meta(self) -> None:
        """No crash when the benchmark itself has no OHLCV data — fails soft with an
        explanatory meta.error, not an AttributeError."""
        ctx = {
            "universe": ["AAA", "SPY"],
            "ohlcv": {"AAA": _flat_series(100.0, 260)},  # SPY absent
            "config": {"benchmark": "SPY"},
        }

        result = self.mod.on_cycle(ctx)  # must not raise

        assert result["signals"] == []
        assert "error" in result["meta"]
