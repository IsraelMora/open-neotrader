"""
Max Drawdown Circuit Breaker — implementación de referencia.

Monitorea drawdown del portfolio y aplica restricciones progresivas:
  - Normal:   drawdown < warning_pct     → trading completo
  - Warning:  drawdown >= warning_pct    → tamaño al 50%
  - Danger:   drawdown >= danger_pct     → tamaño al 25%
  - Breaker:  drawdown >= breaker_pct    → trading DETENIDO
  - Daily:    pérdida diaria >= daily_pct→ trading detenido hasta mañana
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict, dataclass
from enum import StrEnum


class CircuitState(StrEnum):
    NORMAL = "normal"
    WARNING = "warning"
    DANGER = "danger"
    BREAKER = "breaker"  # circuit abierto: no trading
    DAILY = "daily"  # pérdida diaria alcanzada


@dataclass
class CircuitStatus:
    state: str  # CircuitState value
    current_drawdown_pct: float  # drawdown actual desde máximo de equity
    daily_loss_pct: float  # pérdida hoy
    equity_peak: float
    equity_current: float
    size_multiplier: float  # 1.0 | 0.5 | 0.25 | 0.0
    trading_allowed: bool
    reason: str | None
    action_required: str | None


def compute_drawdown(equity_history: list[float]) -> tuple[float, float]:
    """
    Retorna (drawdown_pct_desde_peak, peak_value).
    equity_history: lista cronológica de valores del portfolio.
    """
    if not equity_history:
        return 0.0, 0.0
    peak = max(equity_history)
    current = equity_history[-1]
    drawdown = (peak - current) / peak * 100 if peak > 0 else 0.0
    return round(drawdown, 4), peak


def evaluate_circuit(
    equity_history: list[float],
    equity_open_today: float,
    warning_pct: float = 5.0,
    danger_pct: float = 10.0,
    breaker_pct: float = 15.0,
    recovery_pct: float = 3.0,
    daily_limit_pct: float = 3.0,
    previous_state: str = CircuitState.NORMAL,
    worst_drawdown_in_state: float = 0.0,
) -> CircuitStatus:
    """
    Evalúa el estado del circuit breaker.

    Args:
        equity_history:          historial de valores del portfolio (cronológico)
        equity_open_today:       valor del portfolio al inicio de hoy
        warning_pct:             umbral de aviso
        danger_pct:              umbral de peligro
        breaker_pct:             umbral de circuit breaker
        recovery_pct:            recuperación necesaria para resetear
        daily_limit_pct:         límite de pérdida diaria
        previous_state:          estado anterior del circuit
        worst_drawdown_in_state: peor drawdown mientras estaba en WARNING/DANGER

    Returns:
        CircuitStatus
    """
    if not equity_history:
        return CircuitStatus(
            state=CircuitState.NORMAL,
            current_drawdown_pct=0.0,
            daily_loss_pct=0.0,
            equity_peak=0.0,
            equity_current=0.0,
            size_multiplier=1.0,
            trading_allowed=True,
            reason=None,
            action_required=None,
        )

    drawdown_pct, peak = compute_drawdown(equity_history)
    current = equity_history[-1]

    # Pérdida diaria
    daily_loss = (
        (equity_open_today - current) / equity_open_today * 100 if equity_open_today > 0 else 0.0
    )
    daily_loss = max(0.0, daily_loss)  # solo pérdidas

    # Determinar estado
    if daily_loss >= daily_limit_pct:
        state = CircuitState.DAILY
        size_multiplier = 0.0
        trading_allowed = False
        reason = f"Pérdida diaria del {daily_loss:.1f}% supera el límite del {daily_limit_pct:.1f}%"
        action = "Trading suspendido hasta el próximo día de trading. Revisar causa de pérdida."

    elif drawdown_pct >= breaker_pct:
        state = CircuitState.BREAKER
        size_multiplier = 0.0
        trading_allowed = False
        reason = (
            f"Drawdown del {drawdown_pct:.1f}% supera el circuit breaker del {breaker_pct:.1f}%"
        )
        action = (
            f"TRADING DETENIDO. Recuperar {recovery_pct:.1f}% antes de reanudar. "
            "Análisis post-mortem requerido."
        )

    elif drawdown_pct >= danger_pct:
        # Recovery check: si veníamos de BREAKER, esperar recuperación
        if previous_state == CircuitState.BREAKER:
            recovery_from_worst = worst_drawdown_in_state - drawdown_pct
            if recovery_from_worst < recovery_pct:
                state = CircuitState.BREAKER
                size_multiplier = 0.0
                trading_allowed = False
                reason = (
                    f"En recuperación desde circuit breaker. "
                    f"Recuperado {recovery_from_worst:.1f}% de {recovery_pct:.1f}% requerido"
                )
                action = f"Esperar {recovery_pct - recovery_from_worst:.1f}% más de recuperación."
            else:
                state = CircuitState.DANGER
                size_multiplier = 0.25
                trading_allowed = True
                reason = f"Drawdown alto del {drawdown_pct:.1f}%"
                action = (
                    "Tamaño reducido al 25%. Revisar estrategias activas. "
                    "Considerar cerrar posiciones."
                )
        else:
            state = CircuitState.DANGER
            size_multiplier = 0.25
            trading_allowed = True
            reason = f"Drawdown del {drawdown_pct:.1f}% en zona de peligro"
            action = "Tamaño reducido al 25%. Solo estrategias defensivas."

    elif drawdown_pct >= warning_pct:
        state = CircuitState.WARNING
        size_multiplier = 0.50
        trading_allowed = True
        reason = f"Drawdown del {drawdown_pct:.1f}% en zona de aviso"
        action = "Tamaño reducido al 50%. Aumentar disciplina de stop loss."

    else:
        state = CircuitState.NORMAL
        size_multiplier = 1.0
        trading_allowed = True
        reason = None
        action = None

    return CircuitStatus(
        state=state,
        current_drawdown_pct=round(drawdown_pct, 4),
        daily_loss_pct=round(daily_loss, 4),
        equity_peak=round(peak, 2),
        equity_current=round(current, 2),
        size_multiplier=size_multiplier,
        trading_allowed=trading_allowed,
        reason=reason,
        action_required=action,
    )


def apply_circuit_to_signals(
    signals: list[dict],
    status: CircuitStatus,
) -> list[dict]:
    """
    Aplica el estado del circuit breaker a las señales pendientes.
    - Si trading no permitido: cancela todas las señales de nueva entrada
    - Si size_multiplier < 1: reduce el tamaño indicado en cada señal
    """
    modified = []
    for sig in signals:
        if sig.get("action") not in ("long", "short"):
            modified.append(sig)  # pasar exit/neutral sin modificar
            continue

        if not status.trading_allowed:
            sig = {**sig, "action": "cancelled", "cancel_reason": status.reason}
        elif status.size_multiplier < 1.0:
            if "kelly" in sig and "position_usd" in sig["kelly"]:
                kelly = dict(sig["kelly"])
                kelly["position_usd"] = round(kelly["position_usd"] * status.size_multiplier, 2)
                kelly["shares"] = int(kelly.get("shares", 0) * status.size_multiplier)
                sig = {
                    **sig,
                    "kelly": kelly,
                    "circuit_reduced": True,
                    "size_multiplier": status.size_multiplier,
                }
            elif "position_usd" in sig:
                sig = {
                    **sig,
                    "position_usd": round(sig["position_usd"] * status.size_multiplier, 2),
                    "circuit_reduced": True,
                    "size_multiplier": status.size_multiplier,
                }

        modified.append(sig)
    return modified


if __name__ == "__main__":
    data = json.load(sys.stdin)
    status = evaluate_circuit(
        equity_history=data.get("equity_history", []),
        equity_open_today=data.get("equity_open_today", 0.0),
        warning_pct=data.get("warning_pct", 5.0),
        danger_pct=data.get("danger_pct", 10.0),
        breaker_pct=data.get("breaker_pct", 15.0),
        recovery_pct=data.get("recovery_pct", 3.0),
        daily_limit_pct=data.get("daily_limit_pct", 3.0),
        previous_state=data.get("previous_state", CircuitState.NORMAL),
        worst_drawdown_in_state=data.get("worst_drawdown_in_state", 0.0),
    )
    print(json.dumps({"ok": True, "result": asdict(status)}))
