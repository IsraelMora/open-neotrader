"""Hook de ciclo Stack Trend Following — consenso de 5 plugins de tendencia."""

from __future__ import annotations


def on_cycle(ctx: dict) -> dict:
    """
    El stack no ejecuta lógica propia — lee las señales ya generadas por los
    plugins individuales (macd-signal, ema-crossover-9-21, ichimoku-cloud,
    momentum-factor-12-1, volatility-regime) y genera un consenso ponderado.
    """
    config = ctx.get("config", {})
    pending_signals = ctx.get("pending_signals", [])  # señales de otros plugins en el ciclo
    portfolio = ctx.get("portfolio", {})

    required_consensus = int(config.get("required_consensus", 3))
    min_strength = float(config.get("min_signal_strength", 0.6))
    veto_on_high_vix = bool(config.get("veto_on_high_vix", True))
    exit_on_reverse = int(config.get("exit_on_reverse_consensus", 2))

    stack_plugins = [
        "macd-signal",
        "ema-crossover-9-21",
        "ichimoku-cloud",
        "momentum-factor-12-1",
        "volatility-regime",
    ]

    # Detectar veto VIX desde señales de volatility-regime
    vix_veto = False
    if veto_on_high_vix:
        for sig in pending_signals:
            if sig.get("plugin") == "volatility-regime":
                meta = sig.get("meta", {})
                if meta.get("vix_level", 0) > 30 or meta.get("regime") == "extreme_fear":
                    vix_veto = True
                    break

    # Agrupar señales por símbolo y plugin del stack
    by_symbol: dict[str, dict[str, str]] = {}
    for sig in pending_signals:
        plugin = sig.get("plugin", "")
        if plugin not in stack_plugins:
            continue
        symbol = sig.get("symbol", "")
        action = sig.get("action", "hold")
        if symbol not in by_symbol:
            by_symbol[symbol] = {}
        by_symbol[symbol][plugin] = action

    consensus_signals = []
    for symbol, plugin_votes in by_symbol.items():
        longs = sum(1 for a in plugin_votes.values() if a in ("long", "buy"))
        shorts = sum(1 for a in plugin_votes.values() if a == "short")

        # Check si hay posición abierta y señales en contra
        open_position = portfolio.get(symbol, {}).get("side")
        if open_position == "long" and shorts >= exit_on_reverse:
            consensus_signals.append(
                {
                    "symbol": symbol,
                    "action": "exit_long",
                    "strength": 0.9,
                    "plugin": "stack-trend-following",
                    "reason": f"Stack: reversión — {shorts} plugins señalan short vs posición long",
                    "meta": {"votes": plugin_votes, "vix_veto": vix_veto},
                }
            )
            continue

        if open_position == "short" and longs >= exit_on_reverse:
            consensus_signals.append(
                {
                    "symbol": symbol,
                    "action": "exit_short",
                    "strength": 0.9,
                    "plugin": "stack-trend-following",
                    "reason": f"Stack: reversión — {longs} plugins señalan long vs posición short",
                    "meta": {"votes": plugin_votes, "vix_veto": vix_veto},
                }
            )
            continue

        # VIX veto: no abrir nuevas posiciones
        if vix_veto:
            continue

        if longs >= required_consensus:
            strength = longs / len(stack_plugins)
            if strength >= min_strength:
                consensus_signals.append(
                    {
                        "symbol": symbol,
                        "action": "long",
                        "strength": strength,
                        "plugin": "stack-trend-following",
                        "reason": (
                            f"Stack consenso alcista:"
                            f" {longs}/{len(stack_plugins)} plugins de acuerdo"
                        ),
                        "meta": {"votes": plugin_votes, "longs": longs, "shorts": shorts},
                    }
                )
        elif shorts >= required_consensus:
            strength = shorts / len(stack_plugins)
            if strength >= min_strength:
                consensus_signals.append(
                    {
                        "symbol": symbol,
                        "action": "short",
                        "strength": strength,
                        "plugin": "stack-trend-following",
                        "reason": (
                            f"Stack consenso bajista:"
                            f" {shorts}/{len(stack_plugins)} plugins de acuerdo"
                        ),
                        "meta": {"votes": plugin_votes, "longs": longs, "shorts": shorts},
                    }
                )

    return {
        "signals": consensus_signals,
        "meta": {
            "vix_veto_active": vix_veto,
            "symbols_evaluated": len(by_symbol),
            "consensus_signals": len(consensus_signals),
            "required_consensus": required_consensus,
        },
    }
