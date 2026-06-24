"""
on_cycle hook — Risk Manager (unified layered discipline).

Applies four risk layers IN ORDER to ctx['pending_signals']:
  1. Exposure         — hard veto + qty rescale
  2. Concentration    — sector cap + max positions
  3. Correlation      — Pearson correlation guard
  4. Drawdown Breaker — graduated circuit breaker

Each layer can be independently disabled via config flags.

ctx keys consumed:
  pending_signals         list[dict]   — signals to filter/rescale
  portfolio               dict         — { symbol: { size_pct, sector, ... } }
  positions               list[dict]   — [{ symbol, market_value, qty, current_price }]
  portfolio_value         float        — total portfolio value in USD
  equity_history          list[float]  — chronological equity values (for drawdown)
  equity_open_today       float        — equity value at start of today (for daily loss)
  circuit_state           str          — previous circuit state (for recovery lock)
  worst_drawdown_in_state float        — worst drawdown recorded in current state
  config                  dict         — per-layer thresholds and toggle flags
  provider_tools          dict         — { get_ohlcv: callable } for correlation data

Returns:
  dict with keys:
    signals  list[dict]  — signals after all enabled layers applied
    logs     list[dict]  — [{ level, msg }] audit trail from each layer
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from risk_manager_core import (  # noqa: E402
    apply_concentration_layer,
    apply_correlation_layer,
    apply_drawdown_layer,
    apply_exposure_layer,
)


def on_cycle(ctx: dict) -> dict:
    pending_signals: list[dict] = ctx.get("pending_signals", [])
    portfolio: dict = ctx.get("portfolio", {})
    positions: list[dict] = ctx.get("positions", [])
    portfolio_value: float = float(ctx.get("portfolio_value", 0.0))
    equity_history: list[float] = ctx.get("equity_history", [])
    equity_open_today: float = float(ctx.get("equity_open_today", 0.0))
    circuit_state: str = ctx.get("circuit_state", "normal")
    worst_drawdown_in_state: float = float(ctx.get("worst_drawdown_in_state", 0.0))
    config: dict = ctx.get("config", {})
    provider_tools: dict = ctx.get("provider_tools", {})

    logs: list[dict] = []
    signals = list(pending_signals)

    if not signals:
        return {"signals": [], "logs": logs}

    # ── Layer 1: Exposure ────────────────────────────────────────────────────
    if config.get("enable_exposure", True):
        before = len(signals)
        signals = apply_exposure_layer(
            signals=signals,
            portfolio_value=portfolio_value,
            positions=positions,
            config=config,
        )
        cancelled = sum(1 for s in signals if s.get("action") == "cancelled")
        rescaled = _count_rescaled(pending_signals, signals)
        logs.append({
            "level": "info" if not cancelled else "warning",
            "msg": (
                f"[exposure] {before} signals → {len(signals)} "
                f"({cancelled} cancelled, {rescaled} rescaled)"
            ),
        })
    else:
        logs.append({"level": "debug", "msg": "[exposure] layer disabled"})

    # ── Layer 2: Concentration ───────────────────────────────────────────────
    if config.get("enable_concentration", True):
        active = [s for s in signals if s.get("action") != "cancelled"]
        inactive = [s for s in signals if s.get("action") == "cancelled"]
        active_filtered = apply_concentration_layer(
            signals=active,
            portfolio=portfolio,
            config=config,
        )
        signals = inactive + active_filtered
        newly_cancelled = sum(1 for s in active_filtered if s.get("action") == "cancelled")
        logs.append({
            "level": "info" if not newly_cancelled else "warning",
            "msg": (
                f"[concentration] {newly_cancelled} cancelled by sector/position limits"
            ),
        })
    else:
        logs.append({"level": "debug", "msg": "[concentration] layer disabled"})

    # ── Layer 3: Correlation ─────────────────────────────────────────────────
    if config.get("enable_correlation", True):
        active = [s for s in signals if s.get("action") != "cancelled"]
        inactive = [s for s in signals if s.get("action") == "cancelled"]

        # Gather price data from provider_tools if available
        price_series: dict[str, list[float]] = {}
        get_ohlcv = provider_tools.get("get_ohlcv")
        lookback = int(config.get("lookback_days", 60))

        if callable(get_ohlcv):
            open_positions = list(portfolio.keys())
            candidates = [s["symbol"] for s in active if s.get("action") == "long"]
            all_symbols = list(set(candidates + open_positions))
            for symbol in all_symbols:
                try:
                    bars = get_ohlcv(symbol=symbol, timeframe="1d", limit=lookback + 5)
                    if bars and len(bars) >= 10:
                        price_series[symbol] = [b["close"] for b in bars]
                except Exception:
                    pass

        open_positions = list(portfolio.keys())
        active_filtered = apply_correlation_layer(
            signals=active,
            open_positions=open_positions,
            price_series=price_series,
            config=config,
        )
        signals = inactive + active_filtered
        newly_cancelled = sum(1 for s in active_filtered if s.get("action") == "cancelled")
        logs.append({
            "level": "info" if not newly_cancelled else "warning",
            "msg": f"[correlation] {newly_cancelled} cancelled by correlation guard",
        })
    else:
        logs.append({"level": "debug", "msg": "[correlation] layer disabled"})

    # ── Layer 4: Drawdown Breaker ────────────────────────────────────────────
    if config.get("enable_drawdown_breaker", True):
        # Use portfolio value as fallback equity point if history is empty
        if not equity_history and portfolio_value > 0:
            equity_history = [portfolio_value]

        active = [s for s in signals if s.get("action") != "cancelled"]
        inactive = [s for s in signals if s.get("action") == "cancelled"]
        active_filtered = apply_drawdown_layer(
            signals=active,
            equity_history=equity_history,
            equity_open_today=equity_open_today if equity_open_today > 0 else (equity_history[0] if equity_history else 0.0),
            circuit_state=circuit_state,
            worst_drawdown_in_state=worst_drawdown_in_state,
            config=config,
        )
        signals = inactive + active_filtered
        newly_cancelled = sum(1 for s in active_filtered if s.get("action") == "cancelled")
        reduced = sum(1 for s in active_filtered if s.get("circuit_reduced"))
        logs.append({
            "level": "info" if not newly_cancelled else "critical",
            "msg": (
                f"[drawdown] {newly_cancelled} cancelled, {reduced} size-reduced"
                " by circuit breaker"
            ),
        })
    else:
        logs.append({"level": "debug", "msg": "[drawdown] layer disabled"})

    total_cancelled = sum(1 for s in signals if s.get("action") == "cancelled")
    logs.append({
        "level": "info",
        "msg": (
            f"[risk-manager] {len(pending_signals)} in → {len(signals)} out "
            f"({total_cancelled} total cancelled)"
        ),
    })

    return {"signals": signals, "logs": logs}


def _count_rescaled(original: list[dict], result: list[dict]) -> int:
    """Count signals whose qty changed (rescale detection)."""
    orig_qty = {s.get("symbol", ""): float(s.get("qty", 0)) for s in original}
    count = 0
    for s in result:
        if s.get("action") == "cancelled":
            continue
        sym = s.get("symbol", "")
        if sym in orig_qty:
            new_qty = float(s.get("qty", 0))
            if abs(new_qty - orig_qty[sym]) > 1e-8:
                count += 1
    return count


if __name__ == "__main__":
    ctx = json.loads(sys.stdin.read())
    print(json.dumps(on_cycle(ctx)))
