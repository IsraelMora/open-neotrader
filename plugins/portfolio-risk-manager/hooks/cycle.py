"""
on_cycle hook — Portfolio Risk Manager.

Evalúa la cartera actual, registra el estado de riesgo como log,
y ajusta las señales pendientes para cumplir los límites globales.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from risk_manager import assess_portfolio, filter_signals_by_risk  # noqa: E402


def on_cycle(ctx: dict) -> dict:
    pending_signals: list[dict] = ctx.get("pending_signals", [])
    portfolio: dict = ctx.get("portfolio", {})
    config: dict = ctx.get("config", {})

    max_exposure = config.get("max_total_exposure_pct", 80.0)
    max_single = config.get("max_single_position_pct", 15.0)
    max_pos = config.get("max_positions", 10)
    max_sector = config.get("max_sector_exposure_pct", 30.0)
    min_cash = config.get("min_cash_pct", 20.0)
    warn_only = config.get("warn_only", False)

    logs = []

    # Evaluar estado actual de la cartera
    assessment = assess_portfolio(
        portfolio=portfolio,
        max_total_exposure_pct=max_exposure,
        max_positions=max_pos,
        max_sector_exposure_pct=max_sector,
        min_cash_pct=min_cash,
    )

    for v in assessment.violations:
        logs.append({"level": "error" if not warn_only else "warning", "msg": f"⚠️ RIESGO: {v}"})
    for w in assessment.warnings:
        logs.append({"level": "warning", "msg": f"⚡ {w}"})

    if assessment.ok:
        logs.append(
            {
                "level": "info",
                "msg": f"Portfolio Risk: OK | exposición={assessment.total_exposure_pct:.1f}% | "
                f"posiciones={assessment.n_positions}/{max_pos}",
            }
        )
    else:
        logs.append(
            {
                "level": "warning",
                "msg": f"Portfolio Risk: {len(assessment.violations)} violaciones | "
                f"exposición={assessment.total_exposure_pct:.1f}%",
            }
        )

    # Si no hay señales pendientes, devolver solo el assessment
    if not pending_signals:
        return {"signals": [], "logs": logs}

    # Filtrar y ajustar señales según límites
    filtered, adjustments = filter_signals_by_risk(
        signals=pending_signals,
        portfolio=portfolio,
        max_total_exposure_pct=max_exposure,
        max_single_position_pct=max_single,
        max_positions=max_pos,
        min_cash_pct=min_cash,
        warn_only=warn_only,
    )

    for adj in adjustments:
        if adj.adjusted_action == "cancelled":
            logs.append(
                {
                    "level": "warning",
                    "msg": f"🚫 Risk Manager canceló señal {adj.symbol}: {adj.reason}",
                }
            )
        elif adj.original_size_pct != adj.adjusted_size_pct:
            logs.append(
                {
                    "level": "info",
                    "msg": (
                        f"📉 Risk Manager ajustó {adj.symbol}:"
                        f" {adj.original_size_pct:.1f}%"
                        f" → {adj.adjusted_size_pct:.1f}% ({adj.reason})"
                    ),
                }
            )

    cancelled = sum(1 for a in adjustments if a.adjusted_action == "cancelled")
    adjusted = sum(
        1
        for a in adjustments
        if a.adjusted_action != "cancelled" and a.original_size_pct != a.adjusted_size_pct
    )

    logs.append(
        {
            "level": "info",
            "msg": f"Portfolio Risk Manager: {len(pending_signals)} señales → {len(filtered)} "
            f"({cancelled} canceladas, {adjusted} ajustadas)",
        }
    )

    return {"signals": filtered, "logs": logs}


if __name__ == "__main__":
    ctx = json.load(sys.stdin)
    print(json.dumps(on_cycle(ctx)))
