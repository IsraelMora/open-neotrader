"""
Risk Envelope — hook de ciclo.
Intercepta las señales pendientes del contexto y aplica los frenos de riesgo.
"""

import json
import sys

from scripts.risk_envelope import apply_risk_envelope, check_portfolio_health


def run(ctx: dict) -> None:
    config = ctx.get("config", {})
    portfolio_value = float(ctx.get("portfolio_value", 0))
    positions = ctx.get("positions", [])
    pending_signals = ctx.get("pending_signals", [])

    if not pending_signals:
        emit_signal({"type": "risk_envelope", "status": "no_proposals", "vetoed": 0, "approved": 0})
        return

    # Convertir señales del bus de eventos al formato de propuesta
    proposals = []
    for sig in pending_signals:
        action = sig.get("action", "")
        if action not in ("long", "short", "exit", "buy", "sell"):
            continue
        mapped_action = {"long": "buy", "exit": "sell", "short": "short"}.get(action, action)
        price = sig.get("price", sig.get("entry_price", 0))
        qty = sig.get("qty", 0)
        if price <= 0 or qty <= 0:
            continue
        proposals.append(
            {"symbol": sig.get("symbol", ""), "action": mapped_action, "qty": qty, "price": price}
        )

    if not proposals:
        emit_signal({"type": "risk_envelope", "status": "no_actionable_proposals"})
        return

    result = apply_risk_envelope(proposals, portfolio_value, positions, config)

    # Emitir resumen de riesgo
    emit_signal(
        {
            "type": "risk_envelope",
            "approved": result.approved,
            "vetoed": result.vetoed,
            "rescaled": result.rescaled,
            "summary": result.summary,
            "total_exposure_pct": round(result.total_exposure_after / portfolio_value, 3)
            if portfolio_value > 0
            else 0,
        }
    )

    # Emitir vetos individuales como señales de disciplina
    for vr in result.proposals:
        if not vr.approved:
            emit_signal(
                {
                    "type": "risk_veto",
                    "symbol": vr.proposal.symbol,
                    "action": vr.proposal.action,
                    "reason": vr.veto_reason,
                }
            )

    # Diagnóstico del portafolio
    health = check_portfolio_health(portfolio_value, positions, config)
    if not health["healthy"]:
        for alert in health["alerts"]:
            emit_signal({"type": "risk_alert", "message": alert})


def emit_signal(payload: dict) -> None:
    print(json.dumps({"__signal__": True, **payload}))


if __name__ == "__main__":
    ctx = json.loads(sys.stdin.read())
    run(ctx)
