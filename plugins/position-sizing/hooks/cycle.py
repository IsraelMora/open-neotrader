"""
on_cycle hook — unified position-sizing discipline.

Supports four modes via config["mode"]:
  "kelly"      — Kelly Criterion: sizes from win-rate / payoff ratio derived
                 from trade_history. Falls back to safety_size_pct when
                 history is thin.
  "pyramid"    — Van Tharp pyramiding: splits new signals into tranches;
                 evaluates open positions in portfolio for add opportunities.
  "fixed"      — Fixed fractional: uses fixed_pct regardless of history.
  "vol_target" — Inverse-vol / risk-parity weighting across the current
                 batch of long signals (docs/design/trading-strategy.md
                 step 4). Used by the momentum-rotation strategy: no single
                 position dominates, lower-vol assets get more weight.

No network calls. Pure computation only.
"""

from __future__ import annotations

import math
import os
import sys

# Allow running as a standalone script (python hooks/cycle.py < ctx.json)
_SCRIPTS = os.path.join(os.path.dirname(__file__), "..", "scripts")
sys.path.insert(0, _SCRIPTS)

from pyramid import calculate_tranches, evaluate_add  # noqa: E402
from sizing import (  # noqa: E402
    compute_inverse_vol_weights,
    compute_kelly,
    position_size,
    stats_from_trades,
)

_VALID_MODES = ("kelly", "pyramid", "fixed", "vol_target")


def on_cycle(ctx: dict) -> dict:
    """
    Args:
        ctx["pending_signals"]: list of signals from other plugins
        ctx["portfolio_value"]: total portfolio value in USD (needed by kelly/fixed)
        ctx["portfolio"]:       dict of open positions keyed by symbol (needed by pyramid)
        ctx["trade_history"]:   list of dicts with 'pnl_pct' (needed by kelly)
        ctx["config"]:          plugin config dict

    Returns:
        {"signals": [...], "logs": [...]}
        Signals are the enriched/filtered pending signals plus any add signals.
    """
    pending_signals: list[dict] = ctx.get("pending_signals", [])
    portfolio_value: float = ctx.get("portfolio_value", 10_000.0)
    portfolio: dict = ctx.get("portfolio", {})
    trade_history: list[dict] = ctx.get("trade_history", [])
    config: dict = ctx.get("config", {})

    mode = config.get("mode", "kelly")
    if mode not in _VALID_MODES:
        raise ValueError(
            f"Unknown position-sizing mode: {mode!r}. Valid modes: {_VALID_MODES}"
        )

    if mode == "kelly":
        return _run_kelly(pending_signals, portfolio_value, trade_history, config)
    elif mode == "pyramid":
        return _run_pyramid(pending_signals, portfolio, config)
    elif mode == "vol_target":
        return _run_vol_target(pending_signals, portfolio_value, config)
    else:  # fixed
        return _run_fixed(pending_signals, portfolio_value, config)


# ---------------------------------------------------------------------------
# Mode: kelly
# ---------------------------------------------------------------------------

def _run_kelly(
    pending_signals: list[dict],
    portfolio_value: float,
    trade_history: list[dict],
    config: dict,
) -> dict:
    kelly_fraction_cap = config.get("kelly_fraction_cap", 0.5)
    max_position_pct = config.get("max_position_pct", 10.0)
    min_trades_required = config.get("min_trades_required", 30)
    safety_size_pct = config.get("safety_size_pct", 2.0)

    signals: list[dict] = []
    logs: list[dict] = []

    stats = stats_from_trades(trade_history, min_required=min_trades_required)
    use_safety = not stats.is_reliable

    if use_safety:
        logs.append(
            {
                "level": "info",
                "msg": (
                    f"Kelly safety mode: {stats.n_trades} trades"
                    f" (minimum {min_trades_required}). Using {safety_size_pct}% per trade."
                ),
            }
        )
        effective_kelly = 0.0  # position_size will use safety_size_pct
    else:
        effective_kelly = compute_kelly(
            stats.win_rate, stats.payoff_ratio, fraction=kelly_fraction_cap
        )
        logs.append(
            {
                "level": "info",
                "msg": (
                    f"Kelly stats | win_rate={stats.win_rate:.1%}"
                    f" | payoff={stats.payoff_ratio:.2f}"
                    f" | kelly_full={stats.kelly_full:.1%}"
                    f" | kelly_cap={kelly_fraction_cap}"
                    f" | using={effective_kelly:.1%}"
                ),
            }
        )

    for sig in pending_signals:
        if sig.get("action") != "long":
            signals.append(sig)
            continue

        symbol = sig.get("symbol", "?")
        price = sig.get("price", 0.0)
        stop_loss_pct = sig.get("stop_loss_pct", 2.0)
        take_profit_pct = sig.get("take_profit_pct", 3.0)

        if price <= 0:
            logs.append(
                {"level": "warning", "msg": f"{symbol}: invalid price ({price}), skipped"}
            )
            continue

        sizing = position_size(
            capital=portfolio_value,
            price=price,
            stop_loss_pct=stop_loss_pct,
            take_profit_pct=take_profit_pct,
            kelly_fraction=effective_kelly,
            max_position_pct=max_position_pct,
            safety_size_pct=safety_size_pct,
            use_safety=use_safety,
        )

        signals.append(
            {
                **sig,
                "kelly": {
                    "shares": sizing.shares,
                    "position_usd": sizing.position_usd,
                    "position_pct": sizing.position_pct_capital,
                    "risk_usd": sizing.risk_usd,
                    "reward_usd": sizing.reward_usd,
                    "rr_ratio": sizing.risk_reward_ratio,
                    "warning": sizing.warning,
                },
            }
        )

    sized_count = sum(1 for s in signals if "kelly" in s)
    logs.append(
        {
            "level": "info",
            "msg": (
                f"Kelly sizing done: {sized_count} signals sized"
                f" out of {len(pending_signals)} received."
            ),
        }
    )
    return {"signals": signals, "logs": logs}


# ---------------------------------------------------------------------------
# Mode: pyramid
# ---------------------------------------------------------------------------

def _run_pyramid(
    pending_signals: list[dict],
    portfolio: dict,
    config: dict,
) -> dict:
    entry_pct = config.get("entry_pct", 40.0)
    add_pct = config.get("add_pct", 30.0)
    max_tranches = config.get("max_tranches", 3)
    add_trigger_r = config.get("add_trigger_r", 1.0)
    trail_stop = config.get("trail_stop_after_add", True)

    signals: list[dict] = []
    logs: list[dict] = []

    # Process new entry signals
    for sig in pending_signals:
        if sig.get("action") != "long":
            signals.append(sig)
            continue

        symbol = sig.get("symbol", "?")
        entry_price = sig.get("entry_price") or sig.get("price", 0.0)
        stop_loss = sig.get("stop_loss", 0.0)
        target = sig.get("target_price", entry_price * 1.1 if entry_price else 0.0)
        total_size = sig.get("size_pct", 10.0)

        if not entry_price or not stop_loss:
            signals.append(sig)
            continue

        plan = calculate_tranches(
            symbol=symbol,
            entry_price=entry_price,
            stop_loss=stop_loss,
            target_price=target,
            total_size_pct=total_size,
            entry_pct=entry_pct,
            add_pct=add_pct,
            max_tranches=max_tranches,
            add_trigger_r=add_trigger_r,
        )

        first_tranche = plan.tranches[0]
        signals.append(
            {
                **sig,
                "size_pct": first_tranche.size_pct,
                "pyramid_plan": {
                    "total_tranches": len(plan.tranches),
                    "executed_tranches": 1,
                    "remaining_tranches": [
                        {
                            "number": t.number,
                            "size_pct": t.size_pct,
                            "trigger_price": t.trigger_price,
                        }
                        for t in plan.tranches[1:]
                    ],
                },
            }
        )
        logs.append(
            {
                "level": "info",
                "msg": (
                    f"Pyramid {symbol}: entry {first_tranche.size_pct:.1f}%"
                    f" @ {entry_price} | {len(plan.tranches) - 1} add(s) pending"
                ),
            }
        )

    # Evaluate open positions for adds
    for symbol, position in portfolio.items():
        meta = position.get("meta", {})
        pyramid = meta.get("pyramid_plan")
        if not pyramid:
            continue

        executed = pyramid.get("executed_tranches", 1)
        if executed >= max_tranches:
            continue

        current_price = position.get("current_price", 0.0)
        entry_price = position.get("entry_price", 0.0)
        stop_loss = position.get("stop_loss", 0.0)
        total_size = position.get("target_size_pct", 10.0)

        if not current_price or not entry_price:
            continue

        add_sig = evaluate_add(
            symbol=symbol,
            current_price=current_price,
            entry_price=entry_price,
            stop_loss=stop_loss,
            tranches_executed=executed,
            max_tranches=max_tranches,
            add_trigger_r=add_trigger_r,
            add_pct=add_pct,
            total_size_pct=total_size,
            trail_stop_after_add=trail_stop,
        )

        if add_sig.add_now:
            signals.append(
                {
                    "type": "pyramid_add",
                    "symbol": symbol,
                    "action": "long",
                    "size_pct": add_sig.size_pct,
                    "tranche_number": add_sig.tranche_number,
                    "new_stop": add_sig.new_stop,
                    "reason": add_sig.reason,
                    "confidence": 0.80,
                }
            )
            logs.append(
                {
                    "level": "info",
                    "msg": (
                        f"Pyramid {symbol}: add #{add_sig.tranche_number - 1}"
                        f" @ {current_price} (+{add_sig.size_pct:.1f}%)"
                    ),
                }
            )
        else:
            logs.append(
                {
                    "level": "debug",
                    "msg": (
                        f"Pyramid {symbol}: {add_sig.reason}"
                        f" ({add_sig.progress_pct:.0f}% of the way)"
                    ),
                }
            )

    return {"signals": signals, "logs": logs}


# ---------------------------------------------------------------------------
# Mode: fixed
# ---------------------------------------------------------------------------

def _run_fixed(
    pending_signals: list[dict],
    portfolio_value: float,
    config: dict,
) -> dict:
    fixed_pct = config.get("fixed_pct", 5.0)
    max_position_pct = config.get("max_position_pct", 15.0)

    signals: list[dict] = []
    logs: list[dict] = []

    for sig in pending_signals:
        if sig.get("action") != "long":
            signals.append(sig)
            continue

        symbol = sig.get("symbol", "?")
        price = sig.get("price", 0.0)
        stop_loss_pct = sig.get("stop_loss_pct", 2.0)
        take_profit_pct = sig.get("take_profit_pct", 3.0)

        if price <= 0:
            logs.append(
                {"level": "warning", "msg": f"{symbol}: invalid price ({price}), skipped"}
            )
            continue

        # Fixed fractional: position = capital * fixed_pct%
        capped_pct = min(fixed_pct, max_position_pct)
        position_usd = portfolio_value * (capped_pct / 100.0)
        shares = math.floor(position_usd / price) if price > 0 else 0
        actual_usd = shares * price
        actual_pct = (actual_usd / portfolio_value * 100) if portfolio_value > 0 else 0.0
        risk_usd = actual_usd * (stop_loss_pct / 100.0)
        reward_usd = actual_usd * (take_profit_pct / 100.0)
        rr = reward_usd / risk_usd if risk_usd > 0 else 0.0

        signals.append(
            {
                **sig,
                "fixed": {
                    "shares": shares,
                    "position_usd": round(actual_usd, 2),
                    "position_pct": round(actual_pct, 2),
                    "risk_usd": round(risk_usd, 2),
                    "reward_usd": round(reward_usd, 2),
                    "rr_ratio": round(rr, 2),
                },
            }
        )

    sized_count = sum(1 for s in signals if "fixed" in s)
    logs.append(
        {
            "level": "info",
            "msg": (
                f"Fixed sizing ({fixed_pct}%): {sized_count} signals sized"
                f" out of {len(pending_signals)} received."
            ),
        }
    )
    return {"signals": signals, "logs": logs}


# ---------------------------------------------------------------------------
# Mode: vol_target (inverse-vol / risk-parity)
# ---------------------------------------------------------------------------

def _run_vol_target(
    pending_signals: list[dict],
    portfolio_value: float,
    config: dict,
) -> dict:
    """
    Weight each long candidate inversely to its own volatility so lower-vol
    assets get more capital and no single position dominates the sleeve.

    Reads volatility from sig["volatility_12m"] (emitted by
    momentum-factor-12-1) with a fallback of sig["volatility"], and finally
    config["default_volatility_pct"] if neither is present.
    """
    max_position_pct = config.get("max_position_pct", 10.0)
    default_volatility_pct = config.get("default_volatility_pct", 20.0)

    signals: list[dict] = []
    logs: list[dict] = []

    long_signals = [s for s in pending_signals if s.get("action") == "long"]
    other_signals = [s for s in pending_signals if s.get("action") != "long"]
    signals.extend(other_signals)

    if not long_signals:
        return {"signals": signals, "logs": logs}

    volatilities: dict[str, float] = {}
    for sig in long_signals:
        symbol = sig.get("symbol", "?")
        vol = sig.get("volatility_12m")
        if vol is None:
            vol = sig.get("volatility")
        if vol is None:
            vol = default_volatility_pct / 100.0
            logs.append(
                {
                    "level": "warning",
                    "msg": (
                        f"{symbol}: no volatility on signal, using default "
                        f"volatility ({default_volatility_pct}%)"
                    ),
                }
            )
        volatilities[symbol] = float(vol)

    weights = compute_inverse_vol_weights(volatilities)

    for sig in long_signals:
        symbol = sig.get("symbol", "?")
        price = sig.get("price", 0.0)
        weight = weights.get(symbol, 0.0)

        if price <= 0:
            logs.append(
                {"level": "warning", "msg": f"{symbol}: invalid price ({price}), skipped"}
            )
            continue

        target_pct = weight
        capped_at_max = False
        max_pct_frac = max_position_pct / 100.0
        if target_pct > max_pct_frac:
            target_pct = max_pct_frac
            capped_at_max = True

        position_usd = portfolio_value * target_pct
        shares = math.floor(position_usd / price) if price > 0 else 0
        actual_usd = shares * price
        actual_pct = (actual_usd / portfolio_value * 100) if portfolio_value > 0 else 0.0

        signals.append(
            {
                **sig,
                "vol_target": {
                    "weight": round(weight, 4),
                    "volatility_used": round(volatilities[symbol], 4),
                    "shares": shares,
                    "position_usd": round(actual_usd, 2),
                    "position_pct": round(actual_pct, 2),
                    "capped_at_max": capped_at_max,
                },
            }
        )

    sized_count = sum(1 for s in signals if "vol_target" in s)
    logs.append(
        {
            "level": "info",
            "msg": (
                f"Vol-target sizing done: {sized_count} signals sized"
                f" out of {len(long_signals)} long candidates."
            ),
        }
    )
    return {"signals": signals, "logs": logs}


if __name__ == "__main__":
    import json as _json
    import sys as _sys

    _ctx = _json.load(_sys.stdin)
    _result = on_cycle(_ctx)
    print(_json.dumps(_result))
