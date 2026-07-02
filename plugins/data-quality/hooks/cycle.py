"""
Cycle hook — Data Quality discipline (entrypoint: main()).

Lee prices/price_history del contexto, valida la calidad de cada símbolo,
filtra las pending_signals de símbolos con datos sospechosos, y emite
alertas para los problemas encontrados.

Claves leídas del contexto:
  prices            → dict[symbol, float]
  price_timestamps  → dict[symbol, float]   (epoch segundos, opcional)
  price_history     → dict[symbol, list[float]]  (opcional)
  alt_prices        → dict[symbol, float]   (segundo provider, opcional)
  pending_signals   → list[dict]

Claves escritas:
  pending_signals   → filtrado (símbolos con veto eliminados)
  data_quality      → dict[symbol, {"passed": bool, "issues": [...]}]
  data_quality_flags→ list[symbol]  (símbolos que fallaron)
  veto_reasons      → list[str]     (acumulativo con otros disciplines)
  emit_alerts       → list[dict]    (alertas para AlertsService)
"""

import json
import sys


def main():
    raw = sys.stdin.read().strip()
    ctx: dict = json.loads(raw) if raw else {}

    config: dict = ctx.get("__plugin_config__", {})

    prices: dict = ctx.get("prices", {})
    price_timestamps: dict = ctx.get("price_timestamps", {})
    price_history: dict = ctx.get("price_history", {})
    alt_prices: dict = ctx.get("alt_prices", {})
    pending_signals: list = ctx.get("pending_signals", [])

    if not prices:
        ctx["data_quality"] = {}
        ctx["data_quality_flags"] = []
        print(json.dumps(ctx))
        return

    from data_quality import validate_batch

    reports = validate_batch(
        prices=prices,
        price_timestamps=price_timestamps if price_timestamps else None,
        price_history=price_history if price_history else None,
        alt_prices=alt_prices if alt_prices else None,
        config=config,
    )

    quality_out: dict = {}
    flagged: list[str] = []
    veto_reasons: list[str] = list(ctx.get("veto_reasons", []))
    emit_alerts: list[dict] = list(ctx.get("emit_alerts", []))

    for symbol, report in reports.items():
        quality_out[symbol] = {
            "passed": report.passed,
            "issues": [
                {
                    "check": i.check,
                    "severity": i.severity,
                    "detail": i.detail,
                    "should_veto": i.should_veto,
                }
                for i in report.issues
            ],
        }
        if not report.passed:
            flagged.append(symbol)
            for issue in report.issues:
                if issue.should_veto:
                    veto_reasons.append(f"DataQuality:{symbol}:{issue.check} — {issue.detail}")
                # Emitir alerta para cada problema MEDIUM o superior
                if issue.severity in ("MEDIUM", "HIGH", "CRITICAL"):
                    emit_alerts.append(
                        {
                            "type": "VOLUME_ANOMALY"
                            if issue.check == "HISTORY_GAP"
                            else "FLASH_CRASH",
                            "severity": issue.severity,
                            "symbol": symbol,
                            "message": f"[DataQuality] {issue.check}: {issue.detail}",
                            "meta": {"check": issue.check},
                        }
                    )

    # Filtrar señales de símbolos con mala calidad
    approved_signals = []
    for sig in pending_signals:
        sym = sig.get("symbol", "")
        if sym in flagged:
            # El símbolo tiene veto-worthy issues
            report = reports.get(sym)
            has_veto = report and any(i.should_veto for i in report.issues)
            if not has_veto:
                approved_signals.append(sig)  # issues no veteable (ej: INSUFFICIENT) → pasa
        else:
            approved_signals.append(sig)

    ctx["pending_signals"] = approved_signals
    ctx["data_quality"] = quality_out
    ctx["data_quality_flags"] = flagged
    ctx["veto_reasons"] = veto_reasons
    ctx["emit_alerts"] = emit_alerts

    print(json.dumps(ctx))


if __name__ == "__main__":
    main()
