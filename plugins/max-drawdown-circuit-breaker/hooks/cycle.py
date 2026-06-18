"""
on_cycle hook — Max Drawdown Circuit Breaker.

Lee el historial de equity del portfolio y evalúa el circuit breaker.
Modifica las señales pendientes según el estado (reducir/cancelar).
Emite evento crítico si el circuit se activa.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from circuit_breaker import CircuitState, apply_circuit_to_signals, evaluate_circuit  # noqa: E402


def on_cycle(ctx: dict) -> dict:
    pending_signals: list[dict] = ctx.get("pending_signals", [])
    portfolio: dict = ctx.get("portfolio", {})
    config: dict = ctx.get("config", {})

    # Historial de equity — debe venir del portfolio o del contexto
    equity_history: list[float] = ctx.get("equity_history", [])
    equity_open_today: float = ctx.get("equity_open_today", portfolio.get("value_open_today", 0.0))
    previous_state: str = ctx.get("circuit_state", CircuitState.NORMAL)
    worst_drawdown: float = ctx.get("worst_drawdown_in_state", 0.0)

    # Si no hay historial de equity, usar el valor actual del portfolio como único punto
    if not equity_history and portfolio.get("value"):
        equity_history = [portfolio["value"]]

    signals = []
    logs = []

    if not equity_history:
        logs.append(
            {
                "level": "warning",
                "msg": "Circuit breaker: sin historial de equity, saltando evaluación",
            }
        )
        return {"signals": pending_signals, "logs": logs}

    status = evaluate_circuit(
        equity_history=equity_history,
        equity_open_today=equity_open_today if equity_open_today > 0 else equity_history[0],
        warning_pct=config.get("warning_drawdown_pct", 5.0),
        danger_pct=config.get("danger_drawdown_pct", 10.0),
        breaker_pct=config.get("circuit_breaker_pct", 15.0),
        recovery_pct=config.get("recovery_threshold_pct", 3.0),
        daily_limit_pct=config.get("daily_loss_limit_pct", 3.0),
        previous_state=previous_state,
        worst_drawdown_in_state=worst_drawdown,
    )

    # Aplicar estado a las señales
    signals = apply_circuit_to_signals(pending_signals, status)

    # Log según severidad
    level = "info"
    if status.state in (CircuitState.BREAKER, CircuitState.DAILY):
        level = "critical"
    elif status.state == CircuitState.DANGER:
        level = "warning"

    logs.append(
        {
            "level": level,
            "msg": (
                f"Circuit Breaker | estado={status.state} | "
                f"drawdown={status.current_drawdown_pct:.1f}% | "
                f"pérdida_hoy={status.daily_loss_pct:.1f}% | "
                f"size_multiplier={status.size_multiplier:.0%} | "
                f"trading={'✓' if status.trading_allowed else '✗ DETENIDO'}"
            ),
        }
    )

    if status.action_required:
        logs.append({"level": level, "msg": f"Acción requerida: {status.action_required}"})

    cancelled = sum(1 for s in signals if s.get("action") == "cancelled")
    reduced = sum(1 for s in signals if s.get("circuit_reduced"))
    if cancelled:
        logs.append({"level": level, "msg": f"{cancelled} señales canceladas por circuit breaker"})
    if reduced:
        logs.append(
            {
                "level": "info",
                "msg": f"{reduced} señales con tamaño reducido al {status.size_multiplier:.0%}",
            }
        )

    return {
        "signals": signals,
        "logs": logs,
        "circuit_status": {
            "state": status.state,
            "drawdown_pct": status.current_drawdown_pct,
            "daily_loss_pct": status.daily_loss_pct,
            "trading_allowed": status.trading_allowed,
            "size_multiplier": status.size_multiplier,
        },
    }


if __name__ == "__main__":
    ctx = json.load(sys.stdin)
    print(json.dumps(on_cycle(ctx)))
