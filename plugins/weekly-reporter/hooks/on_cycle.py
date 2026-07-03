"""
Hook on_cycle del Weekly Reporter.
Verifica si es dia de reporte (semanal o mensual) y genera el resumen.
Emite notify_intents para que el kernel's NotifierBridge despache el mensaje
a Telegram — este hook no realiza llamadas de red directamente.
"""

from __future__ import annotations

import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from reporter import format_telegram_message, generate_report  # type: ignore[import]

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

    equity_curve = ctx.get("equity_curve")
    closed_trades = ctx.get("closed_trades")

    # Graceful degradation: missing context data → return without intent
    if equity_curve is None or closed_trades is None:
        return {
            "ok": False,
            "reason": "missing context: equity_curve or closed_trades not available",
        }

    should_run = _is_weekly_report_day(config) or _is_monthly_report_day(config)

    if not should_run:
        # Not a report day — still return without intent but without error
        return {}

    period = "monthly" if _is_monthly_report_day(config) else "weekly"

    report = generate_report(closed_trades, equity_curve, period, config)
    message = format_telegram_message(report)

    result: dict = {
        "weekly_report": report,
        "log": [
            f"[weekly-reporter] Reporte {period} generado — emitiendo notify_intent para Telegram"
        ],
    }

    if report.get("ok") and message:
        intents = ctx.get("notify_intents", [])
        intents.append({"channel": "telegram", "text": message})
        result["notify_intents"] = intents
    else:
        result["ok"] = False
        result["reason"] = report.get("reason", "report generation failed")

    return result


if __name__ == "__main__":
    raw = sys.stdin.read()
    ctx = json.loads(raw)
    out = on_cycle(ctx)
    print(json.dumps(out))
