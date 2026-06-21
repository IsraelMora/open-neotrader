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
    """
    Returns the plugins/ directory (parent of all plugin folders).

    Resolution order:
      1. NEUROTRADER_PLUGINS_DIR env var (set by sandbox runtime and tests)
      2. Repo default: scripts/ → backtester/ → plugins/ (3 levels up from this file)
    """
    env = os.environ.get("NEUROTRADER_PLUGINS_DIR")
    if env:
        return Path(env)
    # Path: plugins/backtester/scripts/generate.py  →  parents[2] = plugins/
    return Path(__file__).parents[2]


def _load_strategy_module(plugin_id: str, script_name: str):
    """Load a strategy script by path using importlib — no sys.path pollution.

    The module is registered in sys.modules before exec_module so that
    dataclass field resolution works correctly under Python 3.14+ (which
    looks up the defining module via sys.modules[cls.__module__]).
    """
    import sys as _sys

    module_name = f"strategy_{plugin_id.replace('-', '_')}"
    script_path = _plugins_root() / plugin_id / "scripts" / script_name
    if not script_path.exists():
        raise FileNotFoundError(f"Strategy script not found: {script_path}")
    spec = importlib.util.spec_from_file_location(module_name, str(script_path))
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    # Register BEFORE exec so dataclass annotations resolve correctly (Python 3.14+)
    _sys.modules[module_name] = mod
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


# ---------------------------------------------------------------------------
# Strategy adapter registry
# ---------------------------------------------------------------------------

# Minimum bars required before we can call each strategy's analyze().
# Below this threshold the strategy returns a neutral result; we skip early.
_EMA_MIN_BARS = 48   # slow_period(21) * 2 + confirmation_bars(1) + 5
_RSI_MIN_BARS = 17   # period(14) + 1 delta + confirmation_bars(2)


def _ema_adapter(bars: list[dict], config: dict, symbol: str) -> list[dict]:
    """
    Slide over bars bar-by-bar; call analyze(bars[:i+1]) for each bar.
    Strictly NO lookahead: strategy sees only closes[0..i] at step i.

    Returns engine-compatible signal dicts.
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

        # EmaResult is a dataclass — access via attribute notation
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

    Signal mapping (RSIResult is a TypedDict — access via key notation):
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
    # Need at least period+1 closes (for 1 delta) + confirmation_bars bars in zone
    min_bars: int = period + 1 + confirmation_bars

    signals: list[dict] = []

    for i in range(len(bars)):
        if i + 1 < min_bars:
            continue  # not enough history yet

        window = bars[: i + 1]  # STRICTLY no future bars
        closes = [b["close"] for b in window]

        # RSIResult is a TypedDict — access via key notation
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
