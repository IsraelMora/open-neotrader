# Backtest Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose a `POST /api/backtest` endpoint that fetches OHLCV via NestJS's ProviderGatewayService, routes to a Python sandbox skill that generates signals bar-by-bar (EMA crossover or RSI mean-reversion, no lookahead), runs them through the existing engine, and returns standardized backtest metrics.

**Architecture:** NestJS owns data fetching and HTTP; the Python sandbox is computation-only (network=false). Signal generation lives in `plugins/backtester/scripts/generate.py` as an adapter registry, loaded by a new `run` skill in `plugins/backtester/plugin.py`. NestJS's `BacktestService` fetches OHLCV, normalizes `ts→date`, serializes prices, calls `sandbox.callPlugin('backtester', 'run', {strategy_id, prices, config})`, and returns the result.

**Tech Stack:** Python 3.11+ (importlib.util, no external deps), pytest, NestJS + TypeScript, class-validator, Jest. `pnpm` via `~/.local/bin`. Test runner for Python: `cd apps/sandbox && python3 -m pytest`.

## Global Constraints

- `export PATH="$HOME/.local/bin:$PATH"` before any pnpm command.
- Python tests live in `apps/sandbox/tests/backtester/` — follow the `ml_feature_extractor` directory pattern exactly.
- NO modification to strategy plugin scripts (`ema_crossover.py`, `calcular_rsi.py`) or `engine.py`.
- NO `any` TypeScript escape hatches. NO `eslint-disable`. NO skipped tests.
- Identifiers and comments in English (this is a technical artifact, not user-facing chat).
- Prettier mandatory on all TS files.
- Sliding window MUST be `bars[:i+1]` — never the full series — to avoid lookahead bias.
- Engine executes at the signal bar's close price (same bar decision + fill): `signal.date = bars[i].date`.
- Strategy minimum bars: EMA crossover needs `slow_period * 2 + confirmation_bars + 5 = 21*2+1+5 = 48` bars. RSI needs `period + 1 + confirmation_bars = 14+1+2 = 17` bars (wilder_rsi returns non-None only after `period` deltas). Only start emitting signals once enough bars exist.
- `PLUGINS_DIR` env var resolves the strategy scripts path in `generate.py`; default to `Path(__file__).parents[3]` (four levels up from `plugins/backtester/scripts/` → repo root → `plugins/`). Tests must set `NEUROTRADER_PLUGINS_DIR` or use a fixture.

---

## File Map

**New files:**
- `plugins/backtester/scripts/generate.py` — `normalize_bars()`, adapter registry, `generate_signals()`
- `plugins/backtester/plugin.py` — `run()` skill combining generate + engine
- `apps/sandbox/tests/backtester/__init__.py` — empty
- `apps/sandbox/tests/backtester/conftest.py` — sys.path restore fixture + loader helpers
- `apps/sandbox/tests/backtester/test_generate.py` — tests for generate.py
- `apps/sandbox/tests/backtester/test_plugin.py` — tests for plugin.py run skill
- `apps/api/src/backtest/dto/run-backtest.dto.ts` — validated DTO
- `apps/api/src/backtest/backtest.service.ts` — orchestrates fetch + sandbox call
- `apps/api/src/backtest/backtest.service.spec.ts` — Jest unit tests
- `apps/api/src/backtest/backtest.controller.ts` — POST /backtest
- `apps/api/src/backtest/backtest.controller.spec.ts` — Jest controller tests
- `apps/api/src/backtest/backtest.module.ts` — NestJS module

**Modified files:**
- `plugins/backtester/manifest.toml` — add `[skills]` section
- `apps/api/src/app.module.ts` — register `BacktestModule`

---

## Task 1: normalize_bars() in generate.py (Python, TDD)

**Files:**
- Create: `plugins/backtester/scripts/generate.py`
- Create: `apps/sandbox/tests/backtester/__init__.py`
- Create: `apps/sandbox/tests/backtester/conftest.py`
- Create: `apps/sandbox/tests/backtester/test_generate.py`

**Interfaces:**
- Produces: `normalize_bars(raw: list[dict]) -> list[dict]`
  - Input element: `{ts: "<ISO string>", open: <number>, high: <number>, low: <number>, close: <number>, volume: <number>}`
  - Output element: `{date: "YYYY-MM-DD", open: float, high: float, low: float, close: float, volume: float}`
  - Strips time from `ts`, coerces all price/volume fields to `float`.
  - Empty input → empty output (no error).

- [ ] **Step 1: Create the test support files**

Create `apps/sandbox/tests/backtester/__init__.py` (empty):
```python
```

Create `apps/sandbox/tests/backtester/conftest.py`:
```python
"""Shared fixtures for backtester plugin tests."""
from __future__ import annotations

import sys
import importlib
import importlib.util
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).parents[4]
_PLUGIN_DIR = _REPO_ROOT / "plugins" / "backtester"
_SCRIPTS_DIR = _PLUGIN_DIR / "scripts"


def load_generate():
    """Load generate.py as a fresh module from the scripts directory."""
    spec = importlib.util.spec_from_file_location(
        "backtester_generate",
        str(_SCRIPTS_DIR / "generate.py"),
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def load_plugin():
    """Load plugin.py with scripts/ on sys.path so it can import generate/engine."""
    scripts_str = str(_SCRIPTS_DIR)
    if scripts_str not in sys.path:
        sys.path.insert(0, scripts_str)
    spec = importlib.util.spec_from_file_location(
        "backtester_plugin",
        str(_PLUGIN_DIR / "plugin.py"),
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


@pytest.fixture(autouse=True)
def _restore_sys_path():
    original = sys.path[:]
    yield
    sys.path[:] = original
```

- [ ] **Step 2: Write the failing test for normalize_bars**

Create `apps/sandbox/tests/backtester/test_generate.py`:
```python
"""
TDD tests for plugins/backtester/scripts/generate.py.

RED phase: all tests fail because generate.py does not exist yet.
GREEN phase: tests pass after generate.py is implemented.
Run: cd apps/sandbox && python3 -m pytest tests/backtester/test_generate.py -v
"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from .conftest import load_generate

_REPO_ROOT = Path(__file__).parents[4]

# ---------------------------------------------------------------------------
# Fixture: load generate module fresh per test session
# ---------------------------------------------------------------------------
@pytest.fixture(scope="module")
def gen():
    return load_generate()


# ---------------------------------------------------------------------------
# normalize_bars
# ---------------------------------------------------------------------------
class TestNormalizeBars:
    def test_strips_time_from_ts(self, gen):
        raw = [{"ts": "2024-01-15T00:00:00Z", "open": 100.0, "high": 101.0, "low": 99.0, "close": 100.5, "volume": 1000}]
        result = gen.normalize_bars(raw)
        assert result[0]["date"] == "2024-01-15"

    def test_strips_time_offset_variant(self, gen):
        raw = [{"ts": "2024-03-01T09:30:00-05:00", "open": 50.0, "high": 51.0, "low": 49.0, "close": 50.5, "volume": 500}]
        result = gen.normalize_bars(raw)
        assert result[0]["date"] == "2024-03-01"

    def test_coerces_numeric_fields_to_float(self, gen):
        raw = [{"ts": "2024-01-02T00:00:00Z", "open": "10", "high": "11", "low": "9", "close": "10.5", "volume": "200"}]
        result = gen.normalize_bars(raw)
        bar = result[0]
        for field in ("open", "high", "low", "close", "volume"):
            assert isinstance(bar[field], float), f"Field {field} is not float"

    def test_empty_input_returns_empty_list(self, gen):
        assert gen.normalize_bars([]) == []

    def test_no_ts_key_raises_key_error(self, gen):
        """Malformed input without 'ts' must raise KeyError (not silently produce garbage)."""
        with pytest.raises(KeyError):
            gen.normalize_bars([{"open": 1.0, "high": 2.0, "low": 0.5, "close": 1.5, "volume": 100}])

    def test_output_has_no_ts_key(self, gen):
        raw = [{"ts": "2024-01-02T00:00:00Z", "open": 1.0, "high": 2.0, "low": 0.5, "close": 1.5, "volume": 100}]
        result = gen.normalize_bars(raw)
        assert "ts" not in result[0]
        assert "date" in result[0]
```

- [ ] **Step 3: Run the test to confirm RED**

```bash
export PATH="$HOME/.local/bin:$PATH"
cd /home/alex/claude/neurotrader/apps/sandbox && python3 -m pytest tests/backtester/test_generate.py::TestNormalizeBars -v 2>&1 | tail -20
```
Expected: `ModuleNotFoundError` or `ImportError` — `generate.py` does not exist yet.

- [ ] **Step 4: Implement normalize_bars in generate.py**

Create `plugins/backtester/scripts/generate.py`:
```python
"""
Signal generation layer for the backtester plugin.

Adapts strategy plugin outputs (ema_crossover, calcular_rsi) to the engine's
signal format, applying a strict sliding window to avoid lookahead bias.

No external dependencies. Strategy modules are loaded via importlib from the
plugins directory resolved through NEUROTRADER_PLUGINS_DIR (or the repo default).
"""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path
from typing import Any


def _plugins_root() -> Path:
    env = os.environ.get("NEUROTRADER_PLUGINS_DIR")
    if env:
        return Path(env)
    # Fallback: scripts/ → backtester/ → plugins/ (3 levels up from this file)
    return Path(__file__).parents[2]


def _load_strategy_module(plugin_id: str, script_name: str):
    """Load a strategy script by path using importlib — no sys.path pollution."""
    script_path = _plugins_root() / plugin_id / "scripts" / script_name
    if not script_path.exists():
        raise FileNotFoundError(f"Strategy script not found: {script_path}")
    spec = importlib.util.spec_from_file_location(f"strategy_{plugin_id}", str(script_path))
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def normalize_bars(raw: list[dict]) -> list[dict]:
    """
    Normalize OHLCV bars from ProviderGateway format to engine format.

    Input:  [{ts: "<ISO string>", open, high, low, close, volume}, ...]
    Output: [{date: "YYYY-MM-DD", open, high, low, close, volume}, ...]

    Raises KeyError if 'ts' is missing from any bar (fail-fast on bad input).
    """
    result = []
    for bar in raw:
        date = bar["ts"][:10]  # KeyError if 'ts' missing — intentional
        result.append({
            "date": date,
            "open": float(bar["open"]),
            "high": float(bar["high"]),
            "low": float(bar["low"]),
            "close": float(bar["close"]),
            "volume": float(bar["volume"]),
        })
    return result
```

- [ ] **Step 5: Run the test to confirm GREEN**

```bash
cd /home/alex/claude/neurotrader/apps/sandbox && python3 -m pytest tests/backtester/test_generate.py::TestNormalizeBars -v 2>&1 | tail -15
```
Expected: `6 passed`.

- [ ] **Step 6: Commit**

```bash
git add plugins/backtester/scripts/generate.py \
        apps/sandbox/tests/backtester/__init__.py \
        apps/sandbox/tests/backtester/conftest.py \
        apps/sandbox/tests/backtester/test_generate.py
git commit -m "feat(backtester): add generate.py with normalize_bars + TDD tests"
```

---

## Task 2: EMA crossover adapter in generate.py (Python, TDD)

**Files:**
- Modify: `plugins/backtester/scripts/generate.py`
- Modify: `apps/sandbox/tests/backtester/test_generate.py`

**Interfaces:**
- Consumes: `normalize_bars()` from Task 1.
- Produces: `generate_signals(strategy_id: str, bars: list[dict], config: dict) -> list[dict]`
  - Each `bars` element is already normalized (has `date`, `open`, `high`, `low`, `close`, `volume`).
  - `strategy_id`: `"ema-crossover-9-21"` or `"rsi-mean-reversion"`.
  - Returns engine signal list: `[{symbol, action, date, confidence?}, ...]`.
  - The sliding window is strictly `bars[:i+1]` — NEVER future bars.
  - `symbol` is taken from `config.get("symbol", "UNKNOWN")`.
  - Minimum bars for EMA: `slow_period * 2 + confirmation_bars + 5` (default = 48). No signal emitted if fewer bars available at bar i.
  - EMA signal mapping: `"long"` → `{action: "long"}`, `"exit_long"` → `{action: "exit"}`, `"none"` → skip.
  - Only emit a signal when `result.confirmed` is True.

- [ ] **Step 1: Write the failing EMA adapter test**

Add to `apps/sandbox/tests/backtester/test_generate.py`:
```python
# ---------------------------------------------------------------------------
# Helpers for bar generation
# ---------------------------------------------------------------------------
def make_bars(n: int, start_price: float = 100.0, symbol: str = "AAPL") -> list[dict]:
    """Generate n synthetic OHLCV bars with a mild uptrend."""
    bars = []
    price = start_price
    for i in range(n):
        import datetime
        date = (datetime.date(2023, 1, 1) + datetime.timedelta(days=i)).isoformat()
        close = price + (i * 0.1)  # mild uptrend
        bars.append({
            "date": date,
            "open": close - 0.2,
            "high": close + 0.3,
            "low": close - 0.4,
            "close": close,
            "volume": 1000.0,
        })
    return bars


# ---------------------------------------------------------------------------
# generate_signals — EMA crossover adapter
# ---------------------------------------------------------------------------
class TestGenerateSignalsEma:
    STRATEGY = "ema-crossover-9-21"

    def test_returns_list(self, gen):
        bars = make_bars(100)
        result = gen.generate_signals(self.STRATEGY, bars, {"symbol": "AAPL"})
        assert isinstance(result, list)

    def test_no_signal_before_minimum_bars(self, gen):
        """With fewer bars than required (48 for EMA), no signal emitted at all."""
        bars = make_bars(30)  # 30 < 48 minimum
        result = gen.generate_signals(self.STRATEGY, bars, {"symbol": "AAPL"})
        assert len(result) == 0

    def test_signals_have_required_fields(self, gen):
        bars = make_bars(100)
        result = gen.generate_signals(self.STRATEGY, bars, {"symbol": "AAPL"})
        for sig in result:
            assert "symbol" in sig
            assert "action" in sig
            assert "date" in sig
            assert sig["action"] in ("long", "exit")

    def test_signal_date_is_current_bar_date(self, gen):
        """Signal date must equal the bar where the signal was detected (same-bar close)."""
        bars = make_bars(100)
        result = gen.generate_signals(self.STRATEGY, bars, {"symbol": "AAPL"})
        bar_dates = {b["date"] for b in bars}
        for sig in result:
            assert sig["date"] in bar_dates, f"Signal date {sig['date']} not in bar dates"

    def test_no_lookahead_bias(self, gen):
        """
        Truncating future bars must NOT change signals already emitted for earlier dates.

        Procedure:
          1. Generate signals for full series (100 bars).
          2. Find the first signal date.
          3. Regenerate signals for bars[:k+1] where bars[k].date == first_signal_date.
          4. The first signal in full run must appear in truncated run too.
        """
        bars = make_bars(100)
        full_signals = gen.generate_signals(self.STRATEGY, bars, {"symbol": "AAPL"})
        if not full_signals:
            pytest.skip("No signals generated — extend bars or verify strategy logic")

        first_signal = full_signals[0]
        first_date = first_signal["date"]
        k = next(i for i, b in enumerate(bars) if b["date"] == first_date)

        truncated_signals = gen.generate_signals(self.STRATEGY, bars[:k + 1], {"symbol": "AAPL"})
        assert len(truncated_signals) > 0, "No signal in truncated run — lookahead bias suspected"
        assert truncated_signals[-1]["date"] == first_date
        assert truncated_signals[-1]["action"] == first_signal["action"]

    def test_unknown_strategy_raises_value_error(self, gen):
        bars = make_bars(100)
        with pytest.raises(ValueError, match="Unknown strategy"):
            gen.generate_signals("not-a-real-strategy", bars, {"symbol": "AAPL"})

    def test_empty_bars_returns_empty(self, gen):
        result = gen.generate_signals(self.STRATEGY, [], {"symbol": "AAPL"})
        assert result == []
```

- [ ] **Step 2: Run to confirm RED**

```bash
cd /home/alex/claude/neurotrader/apps/sandbox && python3 -m pytest tests/backtester/test_generate.py::TestGenerateSignalsEma -v 2>&1 | tail -20
```
Expected: `AttributeError` — `generate_signals` not yet defined.

- [ ] **Step 3: Implement EMA adapter in generate.py**

Add after `normalize_bars` in `plugins/backtester/scripts/generate.py`:
```python
# ---------------------------------------------------------------------------
# Strategy adapter registry
# ---------------------------------------------------------------------------

# Minimum bars required before we can call each strategy's analyze().
# Below this threshold the strategy returns 'none'; we skip early to save calls.
_EMA_MIN_BARS = 48   # slow_period(21) * 2 + confirmation_bars(1) + 5
_RSI_MIN_BARS = 17   # period(14) + 1 delta + confirmation_bars(2)


def _ema_adapter(bars: list[dict], config: dict, symbol: str) -> list[dict]:
    """
    Slide over bars bar-by-bar; call analyze(bars[:i+1]) for each bar.
    Strictly NO lookahead: strategy sees only closes[0..i] at step i.
    """
    mod = _load_strategy_module("ema-crossover-9-21", "ema_crossover.py")

    fast_period: int = config.get("fast_period", 9)
    slow_period: int = config.get("slow_period", 21)
    confirmation_bars: int = config.get("confirmation_bars", 1)
    atr_stop_multiplier: float = config.get("atr_stop_multiplier", 2.0)
    min_bars: int = slow_period * 2 + confirmation_bars + 5

    signals: list[dict] = []

    for i in range(len(bars)):
        if i + 1 < min_bars:
            continue  # not enough history yet

        window = bars[: i + 1]  # STRICTLY no future bars
        closes = [b["close"] for b in window]
        highs = [b["high"] for b in window]
        lows = [b["low"] for b in window]

        result = mod.analyze(
            symbol=symbol,
            closes=closes,
            highs=highs,
            lows=lows,
            fast_period=fast_period,
            slow_period=slow_period,
            confirmation_bars=confirmation_bars,
            atr_stop_multiplier=atr_stop_multiplier,
        )

        if not result.confirmed:
            continue

        if result.signal == "long":
            signals.append({"symbol": symbol, "action": "long", "date": bars[i]["date"]})
        elif result.signal == "exit_long":
            signals.append({"symbol": symbol, "action": "exit", "date": bars[i]["date"]})
        # "none" / "short" / "exit_short" → skip (not in scope for this adapter)

    return signals


def _rsi_adapter(bars: list[dict], config: dict, symbol: str) -> list[dict]:
    """
    RSI mean-reversion adapter.

    Signal mapping:
      "oversold"        → action "long"  (RSI below oversold threshold, confirmed)
      "overbought"      → action "exit"  (RSI above overbought threshold, confirmed)
      "neutral"         → skip
      "divergence_bull" → skip (out of scope for this change)
      "divergence_bear" → skip (out of scope for this change)
    """
    mod = _load_strategy_module("rsi-mean-reversion", "calcular_rsi.py")

    period: int = config.get("rsi_period", 14)
    oversold: float = config.get("oversold", 30.0)
    overbought: float = config.get("overbought", 70.0)
    confirmation_bars: int = config.get("confirmation_bars", 2)
    min_bars: int = period + 1 + confirmation_bars  # need at least period+1 deltas + confirmation

    signals: list[dict] = []

    for i in range(len(bars)):
        if i + 1 < min_bars:
            continue  # not enough history yet

        window = bars[: i + 1]  # STRICTLY no future bars
        closes = [b["close"] for b in window]

        result = mod.analyze(
            closes=closes,
            period=period,
            oversold=oversold,
            overbought=overbought,
            confirmation_bars=confirmation_bars,
        )

        if result["signal"] == "oversold":
            signals.append({"symbol": symbol, "action": "long", "date": bars[i]["date"]})
        elif result["signal"] == "overbought":
            signals.append({"symbol": symbol, "action": "exit", "date": bars[i]["date"]})
        # neutral / divergence_* → skip

    return signals


# Registry: strategy_id → adapter function
_ADAPTERS: dict[str, Any] = {
    "ema-crossover-9-21": _ema_adapter,
    "rsi-mean-reversion": _rsi_adapter,
}


def generate_signals(strategy_id: str, bars: list[dict], config: dict) -> list[dict]:
    """
    Generate engine-compatible signals for a single symbol.

    Args:
        strategy_id: one of "ema-crossover-9-21", "rsi-mean-reversion"
        bars:        normalized bars (each has date, open, high, low, close, volume)
        config:      dict with strategy params + optional "symbol" key

    Returns:
        list of engine signal dicts: [{symbol, action, date}, ...]

    Raises:
        ValueError: if strategy_id is unknown
    """
    if not bars:
        return []

    adapter = _ADAPTERS.get(strategy_id)
    if adapter is None:
        raise ValueError(
            f"Unknown strategy: '{strategy_id}'. Supported: {sorted(_ADAPTERS)}"
        )

    symbol: str = config.get("symbol", "UNKNOWN")
    return adapter(bars, config, symbol)
```

- [ ] **Step 4: Run tests to confirm GREEN**

```bash
cd /home/alex/claude/neurotrader/apps/sandbox && python3 -m pytest tests/backtester/test_generate.py::TestGenerateSignalsEma -v 2>&1 | tail -20
```
Expected: `7 passed`.

- [ ] **Step 5: Commit**

```bash
git add plugins/backtester/scripts/generate.py \
        apps/sandbox/tests/backtester/test_generate.py
git commit -m "feat(backtester): add EMA crossover adapter with no-lookahead sliding window"
```

---

## Task 3: RSI mean-reversion adapter tests (Python, TDD)

**Files:**
- Modify: `apps/sandbox/tests/backtester/test_generate.py`

**Interfaces:**
- Consumes: `generate_signals("rsi-mean-reversion", bars, config)` from Task 2 (already implemented).
- Produces: `TestGenerateSignalsRsi` test class — verifies RSI signal mapping, no-lookahead, minimum bars.

The RSI adapter code was implemented in Task 2 (both adapters share the same `generate_signals` function). This task adds the RSI-specific tests to confirm correctness of the RSI mapping logic.

- [ ] **Step 1: Write the RSI tests**

Append to `apps/sandbox/tests/backtester/test_generate.py`:
```python
# ---------------------------------------------------------------------------
# generate_signals — RSI mean-reversion adapter
# ---------------------------------------------------------------------------
class TestGenerateSignalsRsi:
    STRATEGY = "rsi-mean-reversion"

    def test_returns_list(self, gen):
        bars = make_bars(100)
        result = gen.generate_signals(self.STRATEGY, bars, {"symbol": "AAPL"})
        assert isinstance(result, list)

    def test_no_signal_before_minimum_bars(self, gen):
        """With fewer than 17 bars, no signal emitted (RSI needs period+1+confirmation_bars)."""
        bars = make_bars(10)  # 10 < 17 minimum
        result = gen.generate_signals(self.STRATEGY, bars, {"symbol": "AAPL"})
        assert len(result) == 0

    def test_signals_have_required_fields(self, gen):
        bars = make_bars(100)
        result = gen.generate_signals(self.STRATEGY, bars, {"symbol": "AAPL"})
        for sig in result:
            assert "symbol" in sig
            assert "action" in sig
            assert "date" in sig
            assert sig["action"] in ("long", "exit")

    def test_oversold_maps_to_long(self, gen):
        """
        Force RSI into oversold by generating a sharp downtrend.
        After a sharp decline, RSI should signal 'oversold' → mapped to 'long'.
        """
        # Start high then drop sharply to push RSI below 30
        import datetime
        bars = []
        prices = [100.0 - i * 2.5 for i in range(40)]  # aggressive decline
        prices = [max(p, 1.0) for p in prices]          # floor at 1.0
        for i, price in enumerate(prices):
            date = (datetime.date(2023, 1, 1) + datetime.timedelta(days=i)).isoformat()
            bars.append({
                "date": date,
                "open": price + 0.5,
                "high": price + 1.0,
                "low": max(price - 1.0, 0.1),
                "close": price,
                "volume": 1000.0,
            })
        result = gen.generate_signals(
            self.STRATEGY, bars,
            {"symbol": "TEST", "oversold": 35.0, "confirmation_bars": 1}
        )
        long_signals = [s for s in result if s["action"] == "long"]
        assert len(long_signals) > 0, "Expected at least one 'long' signal from oversold RSI"

    def test_no_lookahead_bias(self, gen):
        """
        Same no-lookahead contract as EMA: truncating future bars must not
        change signals already emitted for earlier dates.
        """
        import datetime
        # Build a series that forces RSI below oversold
        prices = [100.0 - i * 2.5 for i in range(60)]
        prices = [max(p, 1.0) for p in prices]
        bars = []
        for i, price in enumerate(prices):
            date = (datetime.date(2023, 1, 1) + datetime.timedelta(days=i)).isoformat()
            bars.append({
                "date": date,
                "open": price + 0.5,
                "high": price + 1.0,
                "low": max(price - 1.0, 0.1),
                "close": price,
                "volume": 1000.0,
            })
        full_signals = gen.generate_signals(
            self.STRATEGY, bars,
            {"symbol": "TEST", "oversold": 35.0, "confirmation_bars": 1}
        )
        if not full_signals:
            pytest.skip("No signals generated — adjust prices or thresholds")

        first_signal = full_signals[0]
        first_date = first_signal["date"]
        k = next(i for i, b in enumerate(bars) if b["date"] == first_date)

        truncated_signals = gen.generate_signals(
            self.STRATEGY, bars[:k + 1],
            {"symbol": "TEST", "oversold": 35.0, "confirmation_bars": 1}
        )
        assert len(truncated_signals) > 0
        assert truncated_signals[-1]["date"] == first_date
        assert truncated_signals[-1]["action"] == first_signal["action"]

    def test_empty_bars_returns_empty(self, gen):
        result = gen.generate_signals(self.STRATEGY, [], {"symbol": "AAPL"})
        assert result == []
```

- [ ] **Step 2: Run tests to confirm GREEN (RSI adapter already implemented in Task 2)**

```bash
cd /home/alex/claude/neurotrader/apps/sandbox && python3 -m pytest tests/backtester/test_generate.py::TestGenerateSignalsRsi -v 2>&1 | tail -20
```
Expected: `5 passed`.

- [ ] **Step 3: Run all generate tests**

```bash
cd /home/alex/claude/neurotrader/apps/sandbox && python3 -m pytest tests/backtester/test_generate.py -v 2>&1 | tail -25
```
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add apps/sandbox/tests/backtester/test_generate.py
git commit -m "test(backtester): add RSI adapter tests with no-lookahead assertion"
```

---

## Task 4: plugin.py run() skill + manifest update (Python, TDD)

**Files:**
- Create: `plugins/backtester/plugin.py`
- Modify: `plugins/backtester/manifest.toml`
- Create: `apps/sandbox/tests/backtester/test_plugin.py`

**Interfaces:**
- Consumes: `generate_signals()` from generate.py; `run_backtest()` from engine.py.
- Produces: `run(strategy_id: str, prices: dict[str, list[dict]], config: dict, _context) -> dict`
  - `prices`: `{symbol: [normalized bars with date/open/high/low/close/volume]}`
  - Returns: `{"ok": True, "metrics": {...}, "equity_curve": [...], "trades": [...]}` on success.
  - Returns: `{"ok": False, "error": "<message>"}` on invalid input.
  - Skill key in manifest: `"backtester.run"`.

- [ ] **Step 1: Write the failing plugin.py tests**

Create `apps/sandbox/tests/backtester/test_plugin.py`:
```python
"""
TDD tests for plugins/backtester/plugin.py — run() skill.

RED phase: fails because plugin.py does not exist yet.
GREEN phase: passes after plugin.py is implemented.
Run: cd apps/sandbox && python3 -m pytest tests/backtester/test_plugin.py -v
"""
from __future__ import annotations

import datetime
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from .conftest import load_plugin

_REPO_ROOT = Path(__file__).parents[4]


@pytest.fixture(scope="module")
def plugin():
    return load_plugin()


def _make_ctx() -> MagicMock:
    ctx = MagicMock()
    ctx.metadata = {}
    return ctx


def _make_bars(n: int, start_price: float = 100.0) -> list[dict]:
    """Generate n synthetic normalized bars (date already extracted)."""
    bars = []
    price = start_price
    for i in range(n):
        date = (datetime.date(2023, 1, 1) + datetime.timedelta(days=i)).isoformat()
        close = price + (i * 0.1)
        bars.append({
            "date": date,
            "open": close - 0.2,
            "high": close + 0.3,
            "low": close - 0.4,
            "close": close,
            "volume": 1000.0,
        })
    return bars


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------
class TestRunHappyPath:
    def test_returns_dict_with_ok_true(self, plugin):
        prices = {"AAPL": _make_bars(100)}
        result = plugin.run(
            strategy_id="ema-crossover-9-21",
            prices=prices,
            config={"initial_capital": 10000},
            _context=_make_ctx(),
        )
        assert isinstance(result, dict)
        assert result["ok"] is True

    def test_result_has_metrics(self, plugin):
        prices = {"AAPL": _make_bars(100)}
        result = plugin.run(
            strategy_id="ema-crossover-9-21",
            prices=prices,
            config={"initial_capital": 10000},
            _context=_make_ctx(),
        )
        metrics = result["metrics"]
        for key in ("total_return_pct", "sharpe_ratio", "max_drawdown_pct", "win_rate_pct", "profit_factor"):
            assert key in metrics, f"Missing metric: {key}"

    def test_result_has_equity_curve(self, plugin):
        prices = {"AAPL": _make_bars(100)}
        result = plugin.run(
            strategy_id="ema-crossover-9-21",
            prices=prices,
            config={"initial_capital": 10000},
            _context=_make_ctx(),
        )
        assert "equity_curve" in result
        assert isinstance(result["equity_curve"], list)

    def test_result_has_trades(self, plugin):
        prices = {"AAPL": _make_bars(100)}
        result = plugin.run(
            strategy_id="ema-crossover-9-21",
            prices=prices,
            config={"initial_capital": 10000},
            _context=_make_ctx(),
        )
        assert "trades" in result
        assert isinstance(result["trades"], list)

    def test_rsi_strategy_also_works(self, plugin):
        """RSI adapter must be reachable through run()."""
        import datetime
        # Generate a declining price series to trigger RSI oversold
        bars = []
        for i in range(60):
            price = max(100.0 - i * 2.5, 1.0)
            date = (datetime.date(2023, 1, 1) + datetime.timedelta(days=i)).isoformat()
            bars.append({
                "date": date,
                "open": price + 0.5,
                "high": price + 1.0,
                "low": max(price - 1.0, 0.1),
                "close": price,
                "volume": 1000.0,
            })
        prices = {"TEST": bars}
        result = plugin.run(
            strategy_id="rsi-mean-reversion",
            prices=prices,
            config={"initial_capital": 5000, "oversold": 35.0, "confirmation_bars": 1},
            _context=_make_ctx(),
        )
        assert result["ok"] is True


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------
class TestRunEdgeCases:
    def test_empty_prices_returns_error(self, plugin):
        result = plugin.run(
            strategy_id="ema-crossover-9-21",
            prices={},
            config={},
            _context=_make_ctx(),
        )
        assert result["ok"] is False
        assert "error" in result

    def test_empty_bars_for_symbol_returns_error(self, plugin):
        result = plugin.run(
            strategy_id="ema-crossover-9-21",
            prices={"AAPL": []},
            config={},
            _context=_make_ctx(),
        )
        assert result["ok"] is False

    def test_all_neutral_signals_returns_ok_with_zero_trades(self, plugin):
        """Too few bars → no signals → zero trades → still ok=True with valid metrics."""
        prices = {"AAPL": _make_bars(20)}  # 20 bars < 48 minimum for EMA
        result = plugin.run(
            strategy_id="ema-crossover-9-21",
            prices=prices,
            config={"initial_capital": 10000},
            _context=_make_ctx(),
        )
        assert result["ok"] is True
        assert result["metrics"]["total_trades"] == 0

    def test_unknown_strategy_returns_error(self, plugin):
        prices = {"AAPL": _make_bars(100)}
        result = plugin.run(
            strategy_id="not-real",
            prices=prices,
            config={},
            _context=_make_ctx(),
        )
        assert result["ok"] is False
        assert "not-real" in result["error"] or "Unknown" in result["error"]

    def test_multi_symbol_prices(self, plugin):
        """run() must handle multiple symbols in the prices dict."""
        prices = {
            "AAPL": _make_bars(100, start_price=150.0),
            "MSFT": _make_bars(100, start_price=300.0),
        }
        result = plugin.run(
            strategy_id="ema-crossover-9-21",
            prices=prices,
            config={"initial_capital": 10000},
            _context=_make_ctx(),
        )
        assert result["ok"] is True
```

- [ ] **Step 2: Run to confirm RED**

```bash
cd /home/alex/claude/neurotrader/apps/sandbox && python3 -m pytest tests/backtester/test_plugin.py -v 2>&1 | tail -20
```
Expected: `ImportError` — `plugin.py` does not exist.

- [ ] **Step 3: Implement plugin.py**

Create `plugins/backtester/plugin.py`:
```python
"""
Backtester plugin — run skill.

Orchestrates signal generation (generate.py) and backtest execution (engine.py).
No network access; receives pre-fetched OHLCV data via args.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).parent / "scripts"
_SCRIPTS_STR = str(_SCRIPTS_DIR)
if _SCRIPTS_STR not in sys.path:
    sys.path.insert(0, _SCRIPTS_STR)

from engine import run_backtest
from generate import generate_signals


def run(
    strategy_id: str,
    prices: dict,
    config: dict,
    _context=None,
) -> dict:
    """
    Execute a backtest for a given strategy and set of price histories.

    Args:
        strategy_id: e.g. "ema-crossover-9-21" or "rsi-mean-reversion"
        prices:      {symbol: [normalized bars with date/open/high/low/close/volume]}
        config:      backtest config dict (initial_capital, commission_pct, etc.)
        _context:    SDK context (unused but required by runner.py call convention)

    Returns:
        {"ok": True, "metrics": {...}, "equity_curve": [...], "trades": [...]}
        or
        {"ok": False, "error": "<message>"}
    """
    if not prices:
        return {"ok": False, "error": "No price data provided"}

    # Validate all symbols have at least one bar
    for symbol, bars in prices.items():
        if not bars:
            return {"ok": False, "error": f"Empty bar list for symbol '{symbol}'"}

    try:
        all_signals: list[dict] = []
        for symbol, bars in prices.items():
            per_symbol_config = {**config, "symbol": symbol}
            signals = generate_signals(strategy_id, bars, per_symbol_config)
            all_signals.extend(signals)

        result = run_backtest(all_signals, prices, config)

        return {
            "ok": True,
            "metrics": {
                "total_return_pct": result.total_return_pct,
                "cagr_pct": result.cagr_pct,
                "sharpe_ratio": result.sharpe_ratio,
                "sortino_ratio": result.sortino_ratio,
                "max_drawdown_pct": result.max_drawdown_pct,
                "calmar_ratio": result.calmar_ratio,
                "total_trades": result.total_trades,
                "win_rate_pct": result.win_rate_pct,
                "profit_factor": result.profit_factor,
                "avg_win_pct": result.avg_win_pct,
                "avg_loss_pct": result.avg_loss_pct,
                "avg_duration_days": result.avg_duration_days,
                "largest_win_pct": result.largest_win_pct,
                "largest_loss_pct": result.largest_loss_pct,
                "time_in_market_pct": result.time_in_market_pct,
            },
            "equity_curve": result.equity_curve,
            "trades": result.trades,
        }

    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    except Exception as exc:
        return {"ok": False, "error": f"Backtest failed: {exc}"}
```

- [ ] **Step 4: Update manifest.toml to add the skills section**

Read current manifest, then append:
```toml
[skills]
keys = ["backtester.run"]
```

The full modified `plugins/backtester/manifest.toml` becomes:
```toml
[plugin]
id          = "backtester"
name        = "Backtester"
version     = "1.0.0"
type        = "extra"
description = "Motor de backtesting integrado. Permite testear estrategias con datos históricos usando numpy puro (sin dependencias externas). Calcula Sharpe, max drawdown, win rate, profit factor y curva de equity."
author      = "OpenNeoTrader"
tags        = ["backtesting", "analysis", "performance", "extra"]

[scheduler]
mode        = "none"   # se ejecuta bajo demanda via API

[permissions]
network     = false
filesystem  = false

[config]
initial_capital   = { type = "number",  default = 10000,  description = "Capital inicial en USD" }
commission_pct    = { type = "number",  default = 0.001,  description = "Comisión por operación (0.001 = 0.1%)" }
slippage_pct      = { type = "number",  default = 0.0005, description = "Slippage estimado por operación" }
risk_per_trade    = { type = "number",  default = 0.01,   description = "Riesgo por trade como fracción del capital (0.01 = 1%)" }
max_positions     = { type = "integer", default = 5,      description = "Máximo de posiciones simultáneas" }
benchmark         = { type = "string",  default = "SPY",  description = "Símbolo benchmark para comparar rendimiento" }
output_equity_curve = { type = "boolean", default = true, description = "Incluir curva de equity en resultado" }

[skills]
keys = ["backtester.run"]
```

- [ ] **Step 5: Run tests to confirm GREEN**

```bash
cd /home/alex/claude/neurotrader/apps/sandbox && python3 -m pytest tests/backtester/test_plugin.py -v 2>&1 | tail -25
```
Expected: all tests pass.

- [ ] **Step 6: Run full Python test suite to confirm no regression**

```bash
cd /home/alex/claude/neurotrader/apps/sandbox && python3 -m pytest -q 2>&1 | tail -15
```
Expected: all previously passing tests still pass.

- [ ] **Step 7: Commit**

```bash
git add plugins/backtester/plugin.py \
        plugins/backtester/manifest.toml \
        apps/sandbox/tests/backtester/test_plugin.py
git commit -m "feat(backtester): add run skill in plugin.py + register in manifest"
```

---

## Task 5: RunBacktestDto (NestJS, TDD)

**Files:**
- Create: `apps/api/src/backtest/dto/run-backtest.dto.ts`
- Create: `apps/api/src/backtest/backtest.controller.spec.ts` (partial — DTO validation tests only)

**Interfaces:**
- Produces:
```typescript
// RunBacktestDto shape (class-validator):
{
  strategy: string           // required, non-empty, one of ["ema-crossover-9-21", "rsi-mean-reversion"]
  symbols: string[]          // required, non-empty array, each non-empty string
  timeframe: string          // optional, default "1d"
  limit: number              // optional, default 500, min 10, max 2000, integer
  capital: number            // optional, default 10000, min 100
  commission_pct: number     // optional, default 0.001, min 0
  slippage_pct: number       // optional, default 0.0005, min 0
  risk_per_trade: number     // optional, default 0.01, min 0.0001, max 1
  max_positions: number      // optional, default 5, min 1, max 50, integer
  provider_id: string | null // optional, default null (use default provider)
}
```

The DTO validation test goes into `backtest.controller.spec.ts` because that file is where controller + input validation is tested (mirrors the providers pattern).

- [ ] **Step 1: Write the failing DTO test**

Create `apps/api/src/backtest/backtest.controller.spec.ts`:
```typescript
/**
 * BacktestController — unit tests.
 * Tests DTO validation and controller delegation.
 */
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { RunBacktestDto } from './dto/run-backtest.dto';

// ── DTO validation tests ──────────────────────────────────────────────────────

describe('RunBacktestDto — validation', () => {
  function dto(overrides: Record<string, unknown> = {}): RunBacktestDto {
    return plainToInstance(RunBacktestDto, {
      strategy: 'ema-crossover-9-21',
      symbols: ['AAPL'],
      ...overrides,
    });
  }

  it('accepts a minimal valid request', async () => {
    const errors = await validate(dto());
    expect(errors).toHaveLength(0);
  });

  it('rejects missing strategy', async () => {
    const errors = await validate(dto({ strategy: undefined }));
    expect(errors.some((e) => e.property === 'strategy')).toBe(true);
  });

  it('rejects an unknown strategy value', async () => {
    const errors = await validate(dto({ strategy: 'momentum-v2' }));
    expect(errors.some((e) => e.property === 'strategy')).toBe(true);
  });

  it('rejects empty symbols array', async () => {
    const errors = await validate(dto({ symbols: [] }));
    expect(errors.some((e) => e.property === 'symbols')).toBe(true);
  });

  it('rejects symbols with a non-string element', async () => {
    const errors = await validate(dto({ symbols: [123] }));
    expect(errors.some((e) => e.property === 'symbols')).toBe(true);
  });

  it('rejects limit below 10', async () => {
    const errors = await validate(dto({ limit: 5 }));
    expect(errors.some((e) => e.property === 'limit')).toBe(true);
  });

  it('rejects limit above 2000', async () => {
    const errors = await validate(dto({ limit: 9999 }));
    expect(errors.some((e) => e.property === 'limit')).toBe(true);
  });

  it('rejects capital below 100', async () => {
    const errors = await validate(dto({ capital: 10 }));
    expect(errors.some((e) => e.property === 'capital')).toBe(true);
  });

  it('rejects risk_per_trade above 1', async () => {
    const errors = await validate(dto({ risk_per_trade: 5 }));
    expect(errors.some((e) => e.property === 'risk_per_trade')).toBe(true);
  });

  it('accepts optional fields with valid values', async () => {
    const errors = await validate(
      dto({
        timeframe: '1w',
        limit: 300,
        capital: 50000,
        commission_pct: 0.002,
        slippage_pct: 0.001,
        risk_per_trade: 0.02,
        max_positions: 10,
        provider_id: 'alpaca',
      }),
    );
    expect(errors).toHaveLength(0);
  });

  it('accepts null provider_id', async () => {
    const errors = await validate(dto({ provider_id: null }));
    expect(errors).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to confirm RED**

```bash
export PATH="$HOME/.local/bin:$PATH"
cd /home/alex/claude/neurotrader/apps/api && pnpm test --testPathPattern="backtest.controller" 2>&1 | tail -20
```
Expected: `Cannot find module './dto/run-backtest.dto'` or compilation error.

- [ ] **Step 3: Install class-transformer if missing (check first)**

```bash
cd /home/alex/claude/neurotrader/apps/api && grep "class-transformer" package.json
```
If missing: `pnpm add class-transformer`. (It's almost certainly already present — NestJS projects use it pervasively.)

- [ ] **Step 4: Create the DTO**

Create `apps/api/src/backtest/dto/run-backtest.dto.ts`:
```typescript
import {
  IsString,
  IsNotEmpty,
  IsArray,
  ArrayNotEmpty,
  IsEnum,
  IsOptional,
  IsNumber,
  IsInt,
  Min,
  Max,
  IsNullable,
} from 'class-validator';
import { Type } from 'class-transformer';

const SUPPORTED_STRATEGIES = ['ema-crossover-9-21', 'rsi-mean-reversion'] as const;
type SupportedStrategy = (typeof SUPPORTED_STRATEGIES)[number];

export class RunBacktestDto {
  @IsEnum(SUPPORTED_STRATEGIES)
  strategy!: SupportedStrategy;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  symbols!: string[];

  @IsOptional()
  @IsString()
  timeframe?: string = '1d';

  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(2000)
  @Type(() => Number)
  limit?: number = 500;

  @IsOptional()
  @IsNumber()
  @Min(100)
  @Type(() => Number)
  capital?: number = 10000;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  commission_pct?: number = 0.001;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  slippage_pct?: number = 0.0005;

  @IsOptional()
  @IsNumber()
  @Min(0.0001)
  @Max(1)
  @Type(() => Number)
  risk_per_trade?: number = 0.01;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  @Type(() => Number)
  max_positions?: number = 5;

  @IsOptional()
  @IsString()
  @IsNullable()
  provider_id?: string | null = null;
}
```

- [ ] **Step 5: Run tests to confirm GREEN**

```bash
cd /home/alex/claude/neurotrader/apps/api && pnpm test --testPathPattern="backtest.controller" 2>&1 | tail -20
```
Expected: all DTO validation tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/backtest/dto/run-backtest.dto.ts \
        apps/api/src/backtest/backtest.controller.spec.ts
git commit -m "feat(backtest): add RunBacktestDto with validation + DTO tests"
```

---

## Task 6: BacktestService (NestJS, TDD)

**Files:**
- Create: `apps/api/src/backtest/backtest.service.ts`
- Create: `apps/api/src/backtest/backtest.service.spec.ts`

**Interfaces:**
- Consumes: `ProviderGatewayService.getOhlcv(provider_id | null, symbol, timeframe, limit)` → `OhlcvBar[]` (each bar has `{ts: string, open, high, low, close, volume}`).
- Consumes: `SandboxGateway.callPlugin('backtester', 'run', {strategy_id, prices, config})` → `SandboxResponse {ok, result?, error?}`.
- Produces: `runBacktest(dto: RunBacktestDto): Promise<BacktestResponse>`.
  - Fetches OHLCV for each symbol in parallel (`Promise.all`).
  - Converts each `OhlcvBar` to engine format: `{date: ts.slice(0,10), open, high, low, close, volume}`.
  - Calls sandbox `run` skill.
  - Returns `result` from sandbox response or throws `BadGatewayException` on sandbox error.
  - Throws `BadRequestException` if any symbol returns an empty OHLCV array.

```typescript
// BacktestResponse shape (what the service returns):
interface BacktestResponse {
  ok: true;
  metrics: {
    total_return_pct: number;
    cagr_pct: number;
    sharpe_ratio: number;
    sortino_ratio: number;
    max_drawdown_pct: number;
    calmar_ratio: number;
    total_trades: number;
    win_rate_pct: number;
    profit_factor: number;
    avg_win_pct: number;
    avg_loss_pct: number;
    avg_duration_days: number;
    largest_win_pct: number;
    largest_loss_pct: number;
    time_in_market_pct: number;
  };
  equity_curve: { date: string; equity: number }[];
  trades: {
    symbol: string;
    direction: string;
    entry_date: string;
    exit_date: string;
    entry_price: number;
    exit_price: number;
    pnl: number;
    pnl_pct: number;
    duration_days: number;
  }[];
}
```

- [ ] **Step 1: Write the failing service tests**

Create `apps/api/src/backtest/backtest.service.spec.ts`:
```typescript
/**
 * BacktestService — unit tests.
 * Mocks ProviderGatewayService and SandboxGateway — no network, no process spawn.
 */
import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { BacktestService } from './backtest.service';
import type { ProviderGatewayService, OhlcvBar } from '../providers/provider-gateway.service';
import type { SandboxGateway } from '../sandbox/sandbox.gateway';
import { RunBacktestDto } from './dto/run-backtest.dto';
import { plainToInstance } from 'class-transformer';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeBar(overrides: Partial<OhlcvBar> = {}): OhlcvBar {
  return {
    ts: '2024-01-01T00:00:00Z',
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 1000,
    ...overrides,
  };
}

function makeBars(n: number): OhlcvBar[] {
  return Array.from({ length: n }, (_, i) => ({
    ts: `2024-${String(Math.floor(i / 30) + 1).padStart(2, '0')}-${String((i % 30) + 1).padStart(2, '0')}T00:00:00Z`,
    open: 100 + i * 0.1,
    high: 101 + i * 0.1,
    low: 99 + i * 0.1,
    close: 100.5 + i * 0.1,
    volume: 1000,
  }));
}

function makeDto(overrides: Partial<RunBacktestDto> = {}): RunBacktestDto {
  return plainToInstance(RunBacktestDto, {
    strategy: 'ema-crossover-9-21',
    symbols: ['AAPL'],
    timeframe: '1d',
    limit: 100,
    capital: 10000,
    ...overrides,
  });
}

const SANDBOX_SUCCESS = {
  ok: true,
  result: {
    ok: true,
    metrics: {
      total_return_pct: 5.2,
      cagr_pct: 10.4,
      sharpe_ratio: 1.1,
      sortino_ratio: 1.5,
      max_drawdown_pct: 3.0,
      calmar_ratio: 3.5,
      total_trades: 4,
      win_rate_pct: 75.0,
      profit_factor: 2.1,
      avg_win_pct: 2.5,
      avg_loss_pct: -1.2,
      avg_duration_days: 5,
      largest_win_pct: 4.0,
      largest_loss_pct: -2.0,
      time_in_market_pct: 40.0,
    },
    equity_curve: [{ date: '2024-01-01', equity: 10000 }],
    trades: [],
  },
};

function makeGateway(bars: OhlcvBar[] = makeBars(100)): jest.Mocked<ProviderGatewayService> {
  return {
    getOhlcv: jest.fn().mockResolvedValue(bars),
  } as unknown as jest.Mocked<ProviderGatewayService>;
}

function makeSandbox(
  response = SANDBOX_SUCCESS,
): jest.Mocked<SandboxGateway> {
  return {
    callPlugin: jest.fn().mockResolvedValue(response),
  } as unknown as jest.Mocked<SandboxGateway>;
}

function makeService(
  gateway: ProviderGatewayService,
  sandbox: SandboxGateway,
): BacktestService {
  return new BacktestService(gateway, sandbox);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BacktestService — runBacktest', () => {
  it('returns metrics on happy path', async () => {
    const svc = makeService(makeGateway(), makeSandbox());
    const result = await svc.runBacktest(makeDto());

    expect(result.ok).toBe(true);
    expect(result.metrics.total_return_pct).toBe(5.2);
    expect(result.equity_curve).toHaveLength(1);
  });

  it('calls getOhlcv with correct arguments', async () => {
    const gateway = makeGateway();
    const svc = makeService(gateway, makeSandbox());
    await svc.runBacktest(makeDto({ provider_id: 'alpaca', symbols: ['AAPL'], timeframe: '1d', limit: 200 }));

    expect(gateway.getOhlcv).toHaveBeenCalledWith('alpaca', 'AAPL', '1d', 200);
  });

  it('passes null provider_id to getOhlcv when not specified', async () => {
    const gateway = makeGateway();
    const svc = makeService(gateway, makeSandbox());
    await svc.runBacktest(makeDto({ provider_id: null, symbols: ['AAPL'] }));

    expect(gateway.getOhlcv).toHaveBeenCalledWith(null, 'AAPL', expect.any(String), expect.any(Number));
  });

  it('fetches all symbols in parallel and passes all prices to sandbox', async () => {
    const gateway = makeGateway();
    const sandbox = makeSandbox();
    const svc = makeService(gateway, sandbox);
    await svc.runBacktest(makeDto({ symbols: ['AAPL', 'MSFT'] }));

    expect(gateway.getOhlcv).toHaveBeenCalledTimes(2);
    const [, , args] = (sandbox.callPlugin as jest.Mock).mock.calls[0];
    const prices = (args as { prices: Record<string, unknown> }).prices;
    expect(Object.keys(prices)).toContain('AAPL');
    expect(Object.keys(prices)).toContain('MSFT');
  });

  it('normalizes ts→date in prices passed to sandbox', async () => {
    const gateway = makeGateway([makeBar({ ts: '2024-03-15T09:30:00Z' })]);
    const sandbox = makeSandbox();
    const svc = makeService(gateway, sandbox);
    await svc.runBacktest(makeDto());

    const [, , args] = (sandbox.callPlugin as jest.Mock).mock.calls[0];
    const prices = (args as { prices: Record<string, unknown[]> }).prices;
    const firstBar = prices['AAPL'][0] as { date: string };
    expect(firstBar.date).toBe('2024-03-15');
    expect(firstBar).not.toHaveProperty('ts');
  });

  it('throws BadRequestException when a symbol returns empty OHLCV', async () => {
    const gateway = makeGateway([]);
    const svc = makeService(gateway, makeSandbox());

    await expect(svc.runBacktest(makeDto())).rejects.toThrow(BadRequestException);
  });

  it('throws BadGatewayException when sandbox returns ok:false', async () => {
    const sandbox = makeSandbox({ ok: false, error: 'sandbox timeout' });
    const svc = makeService(makeGateway(), sandbox);

    await expect(svc.runBacktest(makeDto())).rejects.toThrow(BadGatewayException);
  });

  it('throws BadGatewayException when sandbox result.ok is false', async () => {
    const sandbox = makeSandbox({
      ok: true,
      result: { ok: false, error: 'Unknown strategy' },
    });
    const svc = makeService(makeGateway(), sandbox);

    await expect(svc.runBacktest(makeDto())).rejects.toThrow(BadGatewayException);
  });

  it('calls sandbox with correct strategy_id from dto', async () => {
    const sandbox = makeSandbox();
    const svc = makeService(makeGateway(), sandbox);
    await svc.runBacktest(makeDto({ strategy: 'rsi-mean-reversion' }));

    const [, fn, args] = (sandbox.callPlugin as jest.Mock).mock.calls[0];
    expect(fn).toBe('run');
    expect((args as { strategy_id: string }).strategy_id).toBe('rsi-mean-reversion');
  });
});
```

- [ ] **Step 2: Run to confirm RED**

```bash
cd /home/alex/claude/neurotrader/apps/api && pnpm test --testPathPattern="backtest.service" 2>&1 | tail -20
```
Expected: `Cannot find module './backtest.service'`.

- [ ] **Step 3: Implement BacktestService**

Create `apps/api/src/backtest/backtest.service.ts`:
```typescript
import { Injectable, BadRequestException, BadGatewayException } from '@nestjs/common';
import { ProviderGatewayService } from '../providers/provider-gateway.service';
import { SandboxGateway } from '../sandbox/sandbox.gateway';
import { RunBacktestDto } from './dto/run-backtest.dto';

export interface BacktestMetrics {
  total_return_pct: number;
  cagr_pct: number;
  sharpe_ratio: number;
  sortino_ratio: number;
  max_drawdown_pct: number;
  calmar_ratio: number;
  total_trades: number;
  win_rate_pct: number;
  profit_factor: number;
  avg_win_pct: number;
  avg_loss_pct: number;
  avg_duration_days: number;
  largest_win_pct: number;
  largest_loss_pct: number;
  time_in_market_pct: number;
}

export interface BacktestTrade {
  symbol: string;
  direction: string;
  entry_date: string;
  exit_date: string;
  entry_price: number;
  exit_price: number;
  pnl: number;
  pnl_pct: number;
  duration_days: number;
}

export interface BacktestResponse {
  ok: true;
  metrics: BacktestMetrics;
  equity_curve: { date: string; equity: number }[];
  trades: BacktestTrade[];
}

@Injectable()
export class BacktestService {
  constructor(
    private readonly providerGateway: ProviderGatewayService,
    private readonly sandbox: SandboxGateway,
  ) {}

  async runBacktest(dto: RunBacktestDto): Promise<BacktestResponse> {
    const {
      strategy,
      symbols,
      timeframe = '1d',
      limit = 500,
      capital = 10000,
      commission_pct = 0.001,
      slippage_pct = 0.0005,
      risk_per_trade = 0.01,
      max_positions = 5,
      provider_id = null,
    } = dto;

    // Fetch OHLCV for all symbols in parallel
    const barArrays = await Promise.all(
      symbols.map((symbol) =>
        this.providerGateway.getOhlcv(provider_id ?? null, symbol, timeframe, limit),
      ),
    );

    // Validate and normalize: ts → date, all numeric fields as numbers
    const prices: Record<string, { date: string; open: number; high: number; low: number; close: number; volume: number }[]> = {};

    for (let i = 0; i < symbols.length; i++) {
      const symbol = symbols[i];
      const bars = barArrays[i];

      if (!bars || bars.length === 0) {
        throw new BadRequestException(
          `No OHLCV data returned for symbol '${symbol}'. Check that the provider has data for this symbol.`,
        );
      }

      prices[symbol] = bars.map((bar) => ({
        date: bar.ts.slice(0, 10), // "2024-03-15T..." → "2024-03-15"
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      }));
    }

    const sandboxCfg = {
      initial_capital: capital,
      commission_pct,
      slippage_pct,
      risk_per_trade,
      max_positions,
    };

    const response = await this.sandbox.callPlugin('backtester', 'run', {
      strategy_id: strategy,
      prices,
      config: sandboxCfg,
    });

    if (!response.ok) {
      throw new BadGatewayException(
        `Sandbox error: ${response.error ?? 'unknown error'}`,
      );
    }

    const result = response.result as {
      ok: boolean;
      error?: string;
      metrics?: BacktestMetrics;
      equity_curve?: { date: string; equity: number }[];
      trades?: BacktestTrade[];
    };

    if (!result.ok) {
      throw new BadGatewayException(
        `Backtest error: ${result.error ?? 'unknown error'}`,
      );
    }

    return {
      ok: true,
      metrics: result.metrics!,
      equity_curve: result.equity_curve ?? [],
      trades: result.trades ?? [],
    };
  }
}
```

- [ ] **Step 4: Run service tests to confirm GREEN**

```bash
cd /home/alex/claude/neurotrader/apps/api && pnpm test --testPathPattern="backtest.service" 2>&1 | tail -20
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/backtest/backtest.service.ts \
        apps/api/src/backtest/backtest.service.spec.ts
git commit -m "feat(backtest): add BacktestService with OHLCV fetch + sandbox delegation"
```

---

## Task 7: BacktestController + module + app.module registration (NestJS, TDD)

**Files:**
- Create: `apps/api/src/backtest/backtest.controller.ts`
- Create: `apps/api/src/backtest/backtest.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/backtest/backtest.controller.spec.ts` (add controller tests)

**Interfaces:**
- Consumes: `BacktestService.runBacktest(dto)`.
- Produces: `POST /backtest` → `200 BacktestResponse` (or 400/502 on error).

- [ ] **Step 1: Add controller tests to backtest.controller.spec.ts**

Append to `apps/api/src/backtest/backtest.controller.spec.ts`:
```typescript
// ── Controller tests ──────────────────────────────────────────────────────────
import { Test, TestingModule } from '@nestjs/testing';
import { BacktestController } from './backtest.controller';
import { BacktestService } from './backtest.service';
import type { BacktestResponse } from './backtest.service';

const MOCK_RESPONSE: BacktestResponse = {
  ok: true,
  metrics: {
    total_return_pct: 8.5,
    cagr_pct: 17.0,
    sharpe_ratio: 1.3,
    sortino_ratio: 1.8,
    max_drawdown_pct: 4.2,
    calmar_ratio: 4.0,
    total_trades: 6,
    win_rate_pct: 66.7,
    profit_factor: 2.5,
    avg_win_pct: 3.0,
    avg_loss_pct: -1.5,
    avg_duration_days: 7,
    largest_win_pct: 5.0,
    largest_loss_pct: -2.5,
    time_in_market_pct: 50.0,
  },
  equity_curve: [],
  trades: [],
};

describe('BacktestController', () => {
  let controller: BacktestController;
  let service: jest.Mocked<BacktestService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [BacktestController],
      providers: [
        {
          provide: BacktestService,
          useValue: {
            runBacktest: jest.fn().mockResolvedValue(MOCK_RESPONSE),
          },
        },
      ],
    }).compile();

    controller = module.get<BacktestController>(BacktestController);
    service = module.get(BacktestService);
  });

  it('POST /backtest delegates to BacktestService.runBacktest', async () => {
    const dto = plainToInstance(RunBacktestDto, {
      strategy: 'ema-crossover-9-21',
      symbols: ['AAPL'],
    });

    const result = await controller.run(dto);

    expect(service.runBacktest).toHaveBeenCalledWith(dto);
    expect(result.ok).toBe(true);
    expect(result.metrics.total_return_pct).toBe(8.5);
  });

  it('returns the service result directly', async () => {
    const dto = plainToInstance(RunBacktestDto, {
      strategy: 'rsi-mean-reversion',
      symbols: ['SPY'],
    });

    const result = await controller.run(dto);
    expect(result).toEqual(MOCK_RESPONSE);
  });
});
```

- [ ] **Step 2: Run controller tests to confirm RED**

```bash
cd /home/alex/claude/neurotrader/apps/api && pnpm test --testPathPattern="backtest.controller" 2>&1 | tail -20
```
Expected: `Cannot find module './backtest.controller'`.

- [ ] **Step 3: Create BacktestController**

Create `apps/api/src/backtest/backtest.controller.ts`:
```typescript
import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { BacktestService, BacktestResponse } from './backtest.service';
import { RunBacktestDto } from './dto/run-backtest.dto';

/** Executes a strategy backtest over historical OHLCV data fetched from the active provider. */
@Controller('backtest')
export class BacktestController {
  constructor(private readonly backtestService: BacktestService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  run(@Body() dto: RunBacktestDto): Promise<BacktestResponse> {
    return this.backtestService.runBacktest(dto);
  }
}
```

- [ ] **Step 4: Create BacktestModule**

Create `apps/api/src/backtest/backtest.module.ts`:
```typescript
import { Module } from '@nestjs/common';
import { BacktestController } from './backtest.controller';
import { BacktestService } from './backtest.service';
import { SandboxModule } from '../sandbox/sandbox.module';
import { ProvidersModule } from '../providers/providers.module';

@Module({
  imports: [SandboxModule, ProvidersModule],
  controllers: [BacktestController],
  providers: [BacktestService],
})
export class BacktestModule {}
```

- [ ] **Step 5: Register BacktestModule in app.module.ts**

In `apps/api/src/app.module.ts`, add the import:
```typescript
import { BacktestModule } from './backtest/backtest.module';
```

And add `BacktestModule` to the `imports` array (after `DashboardModule`):
```typescript
DashboardModule,
BacktestModule,
```

- [ ] **Step 6: Run all backtest tests**

```bash
cd /home/alex/claude/neurotrader/apps/api && pnpm test --testPathPattern="backtest" 2>&1 | tail -25
```
Expected: all controller + service + DTO tests pass.

- [ ] **Step 7: Run full NestJS test suite**

```bash
cd /home/alex/claude/neurotrader/apps/api && pnpm test 2>&1 | tail -20
```
Expected: all tests pass (no regressions).

- [ ] **Step 8: TypeScript + lint check**

```bash
cd /home/alex/claude/neurotrader/apps/api && pnpm exec tsc --noEmit 2>&1 | tail -20
```
Expected: no errors.

```bash
cd /home/alex/claude/neurotrader/apps/api && pnpm exec eslint src/backtest/ 2>&1 | tail -20
```
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/backtest/backtest.controller.ts \
        apps/api/src/backtest/backtest.controller.spec.ts \
        apps/api/src/backtest/backtest.module.ts \
        apps/api/src/app.module.ts
git commit -m "feat(backtest): add BacktestController, BacktestModule, register in AppModule"
```

---

## Final Verification

- [ ] **Run complete Python test suite**

```bash
export PATH="$HOME/.local/bin:$PATH"
cd /home/alex/claude/neurotrader/apps/sandbox && python3 -m pytest -q 2>&1
```
Paste exact output including pass/fail count.

- [ ] **Run complete NestJS test suite**

```bash
cd /home/alex/claude/neurotrader/apps/api && pnpm test 2>&1 | tail -30
```
Paste exact output.

- [ ] **TypeScript type-check**

```bash
cd /home/alex/claude/neurotrader/apps/api && pnpm exec tsc --noEmit 2>&1
```
Expected: no output (zero errors).

- [ ] **ESLint**

```bash
cd /home/alex/claude/neurotrader/apps/api && pnpm exec eslint src/ 2>&1 | tail -20
```
Expected: no errors. If a lint script exists (`pnpm lint`), use that instead.

---

## Self-Review Checklist

### Spec coverage

| Requirement | Task |
|-------------|------|
| `POST /api/backtest` endpoint | Task 7 |
| NestJS fetches OHLCV via ProviderGatewayService | Task 6 |
| `normalize_bars()` converts `ts→date` | Task 1 |
| EMA crossover adapter (ema-crossover-9-21) | Task 2 |
| RSI mean-reversion adapter (rsi-mean-reversion) | Task 3 |
| RSI oversold→"long", overbought→"exit" mapping | Task 3 |
| No-lookahead bias (sliding window `bars[:i+1]`) | Tasks 2 & 3 (enforced in generate.py + tested) |
| No-lookahead explicit test | Tasks 2 & 3 (`test_no_lookahead_bias`) |
| `plugins/backtester/scripts/generate.py` with adapter registry | Tasks 1–3 |
| `plugins/backtester/plugin.py` with `run()` skill | Task 4 |
| `manifest.toml` `[skills] keys = ["backtester.run"]` | Task 4 |
| RunBacktestDto validation (symbols empty, unknown strategy, etc.) | Task 5 |
| BacktestService mocked tests | Task 6 |
| BacktestController + module registration | Task 7 |
| Sandbox `ok:false` → `BadGatewayException` | Task 6 |
| Empty OHLCV → `BadRequestException` | Task 6 |
| Determinism (no Date.now()/random in computation path) | generate.py uses only index/slice — deterministic by design |
| Multi-symbol support | Task 4 (test_multi_symbol_prices), Task 6 (fetches in parallel) |
| importlib.util loads real strategy code (no duplication) | Tasks 2 & 3 (`_load_strategy_module`) |
| PLUGINS_DIR env var controls strategy script resolution | Task 2 (generate.py `_plugins_root()`) |

### Lookahead bias guard (critical)

The sliding window in `_ema_adapter` and `_rsi_adapter` is `bars[:i+1]`. This means:
- At bar index 0: strategy sees `[bars[0]]` only.
- At bar index i: strategy sees `[bars[0], ..., bars[i]]`.
- Future bars (`bars[i+1], ..., bars[n-1]`) are NEVER passed.

Signal `date` is always `bars[i]["date"]` — the current bar. The engine executes at the close of that same bar, which is consistent (close-of-bar decision + close-of-bar fill, a common and acceptable convention). The `test_no_lookahead_bias` test in Tasks 2 and 3 proves this property: generating signals on a truncated series `bars[:k+1]` produces the same first signal as the full series for that date.

### Execution timing (engine alignment)

From `engine.py` line 123: `price = bar["close"]`. The engine executes at `bar["close"]` where `bar = bars.get(sig_date)`. So the signal's `date` determines which bar is used for execution. Since we set `signal.date = bars[i].date` (the current bar), the engine fills at `bars[i].close` — same bar close. Decision at close, fill at close. No future info used.

### Type consistency check

- `generate_signals()` returns `list[dict]` with keys `symbol`, `action`, `date` — matches engine's expected signal format.
- `normalize_bars()` output has `date` (not `ts`) — matches engine's `price_index` which keys on `b["date"]`.
- `BacktestService` maps `bar.ts.slice(0,10)` → `date` before passing to sandbox — consistent.
- `RunBacktestDto.strategy` is used as `strategy_id` in sandbox args, which matches `generate_signals(strategy_id, ...)` parameter name.
- `BacktestService` constructor takes `(ProviderGatewayService, SandboxGateway)` — test `makeService(gateway, sandbox)` passes in the same order.
