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
# Every curated strategy plugin exposes the SAME pure contract:
#
#     analyze(bars: list[dict], config: dict) -> dict
#         bars  = the window [0..now] of OHLCV dicts (STRICTLY no future bars)
#         return at least {"signal": "long"|"short"|"exit"|"none", ...}
#
# so a single sliding-window adapter works for all of them. Each registry entry
# supplies the plugin id, its script module, and a min_bars(config) function that
# guarantees analyze() never receives a window shorter than it needs.


def _slide_adapter(plugin_id: str, script_name: str, min_bars_fn):
    """Build an adapter that slides over bars and calls the plugin's analyze().

    Mapping: result["signal"] in {long, short, exit} → engine action of the same
    name; anything else (none/missing) is skipped. Strict no-lookahead: at step i
    the strategy only ever sees bars[: i + 1].
    """

    def adapter(bars: list[dict], config: dict, symbol: str) -> list[dict]:
        mod = _load_strategy_module(plugin_id, script_name)
        min_bars = max(1, int(min_bars_fn(config)))
        # Optional fast mode: cap the look-back window so generate is O(n·W) instead of
        # O(n²) — useful for parameter sweeps over long histories. Indicators (EMA/RSI…)
        # have bounded effective memory, so a generous cap is numerically ~equivalent.
        # Clamped to >= min_bars so the strategy always has the history it needs.
        raw_lb = config.get("max_lookback")
        max_lookback = max(int(raw_lb), min_bars) if raw_lb else None
        signals: list[dict] = []
        for i in range(len(bars)):
            if i + 1 < min_bars:
                continue  # not enough history yet
            start = max(0, i + 1 - max_lookback) if max_lookback is not None else 0
            window = bars[start : i + 1]  # STRICTLY no future bars (bounded when max_lookback set)
            result = mod.analyze(window, config)
            signal = result.get("signal", "none")
            if signal in ("long", "short", "exit"):
                signals.append({"symbol": symbol, "action": signal, "date": bars[i]["date"]})
        return signals

    return adapter


def _trend_following_min_bars(config: dict) -> int:
    # Ichimoku needs senkou_b + kijun bars before the cloud is defined.
    return config.get("senkou_b", 52) + config.get("kijun", 26)


def _mean_reversion_min_bars(config: dict) -> int:
    lookback = config.get("lookback", 20)
    rsi_period = config.get("rsi_period", 14)
    # OU half-life estimation wants a healthy sample; RSI wants period+1 deltas.
    return max(lookback * 3 + 20, lookback + rsi_period + 10)


def _session_breakout_min_bars(config: dict) -> int:
    # Needs the previous close to measure the overnight gap.
    return max(3, config.get("or_bars", 5))


# Registry: strategy_id → sliding-window adapter over the plugin's analyze()
_ADAPTERS: dict[str, Any] = {
    "trend-following": _slide_adapter(
        "trend-following", "trend_following.py", _trend_following_min_bars
    ),
    "mean-reversion": _slide_adapter(
        "mean-reversion", "mean_reversion.py", _mean_reversion_min_bars
    ),
    "session-breakout": _slide_adapter(
        "session-breakout", "session_breakout.py", _session_breakout_min_bars
    ),
}


def generate_signals(strategy_id: str, bars: list[dict], config: dict) -> list[dict]:
    """
    Generate engine-compatible signals for a single symbol.

    Args:
        strategy_id: one of the curated strategies in _ADAPTERS
                     ("trend-following", "mean-reversion", "session-breakout")
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
