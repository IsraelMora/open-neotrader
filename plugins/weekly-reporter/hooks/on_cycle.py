"""
Hook on_cycle del Weekly Reporter.
Verifica si es día de reporte (semanal o mensual) y genera el resumen.
"""

from __future__ import annotations

import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from reporter import generate_and_send  # type: ignore[import]


class _HookContext:
    """Minimal context object compatible with _SdkContext expected by inner scripts."""

    def __init__(self, metadata: dict) -> None:
        self.metadata = metadata

WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


def _is_weekly_report_day(config: dict) -> bool:
    target = config.get("weekly_report_day", "monday").lower()
    today = WEEKDAYS[time.gmtime().tm_wday]
    return today == target


def _is_monthly_report_day(config: dict) -> bool:
    target = int(config.get("monthly_report_day", 1))
    today = time.gmtime().tm_mday
    return today == target


def on_cycle(ctx: dict) -> dict:
    config = ctx.get("plugin_config", {})
    should_run = _is_weekly_report_day(config) or _is_monthly_report_day(config)

    if not should_run:
        return ctx

    period = "monthly" if _is_monthly_report_day(config) else "weekly"

    trades = ctx.get("closed_trades", [])
    equity_curve = ctx.get("equity_curve", [1.0])

    result = generate_and_send(
        {
            "trades": trades,
            "equity_curve": equity_curve,
            "period": period,
            "config": config,
        },
        _context=_HookContext(metadata=ctx),
    )

    ctx["weekly_report"] = result
    ctx.setdefault("log", []).append(
        f"[weekly-reporter] Reporte {period} generado: "
        + ("enviado vía Telegram" if result.get("telegram_sent") else "sin Telegram configurado")
    )

    return ctx


if __name__ == "__main__":
    raw = sys.stdin.read()
    ctx = json.loads(raw)
    out = on_cycle(ctx)
    print(json.dumps(out))
