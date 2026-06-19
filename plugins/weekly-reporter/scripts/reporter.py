"""
Weekly/Monthly Reporter
========================
Genera resúmenes de rendimiento y los envía vía Telegram.

Métricas calculadas:
  - P&L total y por símbolo
  - Sharpe ratio anualizado
  - Maximum drawdown
  - Win rate y profit factor
  - Top 5 señales por ganancia

Basado en las mismas fórmulas que el backtester:
  - Sharpe = (E[r] - rf) / σ(r) × √252 (rf=0 para simplificar)
  - MaxDD = max(peak - trough) / peak
  - Profit Factor = Σ(ganancias) / Σ(pérdidas)
"""

from __future__ import annotations

import json
import math
import os
import sys
import urllib.request
from dataclasses import dataclass
from typing import Any

# ── Cálculos de rendimiento ──────────────────────────────────────────────────


@dataclass
class Trade:
    symbol: str
    action: str  # buy | sell
    pnl: float
    ts: str


def _sharpe(returns: list[float]) -> float:
    if len(returns) < 2:
        return 0.0
    n = len(returns)
    mean = sum(returns) / n
    var = sum((r - mean) ** 2 for r in returns) / (n - 1)
    std = math.sqrt(var)
    if std < 1e-10:
        return 0.0
    return (mean / std) * math.sqrt(252)


def _max_drawdown(equity_curve: list[float]) -> float:
    if len(equity_curve) < 2:
        return 0.0
    peak = equity_curve[0]
    max_dd = 0.0
    for v in equity_curve[1:]:
        if v > peak:
            peak = v
        dd = (peak - v) / peak if peak > 0 else 0.0
        if dd > max_dd:
            max_dd = dd
    return max_dd


def _profit_factor(trades: list[Trade]) -> float:
    gains = sum(t.pnl for t in trades if t.pnl > 0)
    losses = abs(sum(t.pnl for t in trades if t.pnl < 0))
    if losses < 1e-10:
        return float("inf") if gains > 0 else 1.0
    return gains / losses


def generate_report(
    trades: list[dict],
    equity_curve: list[float],
    period: str,
    config: dict[str, Any],
) -> dict:
    """
    Genera métricas de rendimiento para un período.

    Args:
        trades: Lista de trades [{"symbol", "action", "pnl", "ts"}]
        equity_curve: Serie de valores de cartera (cronológica)
        period: "weekly" | "monthly"
        config: Configuración del plugin
    """
    min_trades = int(config.get("min_trades", 5))

    if len(trades) < min_trades:
        return {
            "ok": False,
            "reason": f"Insuficientes trades: {len(trades)} (mínimo {min_trades})",
            "period": period,
        }

    trade_objs = [
        Trade(
            symbol=t["symbol"],
            action=t.get("action", ""),
            pnl=float(t.get("pnl", 0.0)),
            ts=t.get("ts", ""),
        )
        for t in trades
    ]

    total_pnl = sum(t.pnl for t in trade_objs)
    wins = [t for t in trade_objs if t.pnl > 0]
    losses = [t for t in trade_objs if t.pnl < 0]
    win_rate = len(wins) / len(trade_objs) if trade_objs else 0.0

    # Retornos diarios (de la equity curve)
    returns = []
    for i in range(1, len(equity_curve)):
        prev = equity_curve[i - 1]
        if prev > 0:
            returns.append((equity_curve[i] - prev) / prev)

    sharpe = _sharpe(returns)
    max_dd = _max_drawdown(equity_curve)
    pf = _profit_factor(trade_objs)

    # Top 5 por P&L
    top5 = sorted(trade_objs, key=lambda t: t.pnl, reverse=True)[:5]

    # Por símbolo
    by_symbol: dict[str, float] = {}
    for t in trade_objs:
        by_symbol[t.symbol] = by_symbol.get(t.symbol, 0.0) + t.pnl

    return {
        "ok": True,
        "period": period,
        "total_pnl": round(total_pnl, 4),
        "win_rate": round(win_rate, 3),
        "profit_factor": round(pf, 2) if pf != float("inf") else None,
        "sharpe": round(sharpe, 3),
        "max_drawdown": round(max_dd, 3),
        "trades_total": len(trade_objs),
        "trades_win": len(wins),
        "trades_loss": len(losses),
        "top5": [{"symbol": t.symbol, "pnl": round(t.pnl, 4)} for t in top5],
        "by_symbol": {
            k: round(v, 4) for k, v in sorted(by_symbol.items(), key=lambda x: x[1], reverse=True)
        },
    }


# ── Formato Telegram ──────────────────────────────────────────────────────────


def _emoji_pnl(pnl: float) -> str:
    if pnl > 0:
        return "🟢"
    if pnl < 0:
        return "🔴"
    return "⚪"


def format_telegram_message(report: dict) -> str:
    if not report.get("ok"):
        return f"⚠️ Reporte no disponible: {report.get('reason', 'sin datos')}"

    period_label = "📅 Semanal" if report["period"] == "weekly" else "📆 Mensual"
    pnl_emoji = _emoji_pnl(report["total_pnl"])
    pnl_sign = "+" if report["total_pnl"] >= 0 else ""

    lines = [
        f"{period_label} — Resumen de Rendimiento",
        "",
        f"{pnl_emoji} P&L: {pnl_sign}{report['total_pnl']:.4f}",
        f"📊 Sharpe: {report['sharpe']:.2f}",
        f"📉 Max Drawdown: {report['max_drawdown']:.1%}",
        f"🎯 Win Rate: {report['win_rate']:.1%} ({report['trades_win']}/{report['trades_total']})",
    ]

    pf = report.get("profit_factor")
    if pf is not None:
        lines.append(f"⚖️ Profit Factor: {pf:.2f}x")

    if report.get("top5"):
        lines.append("")
        lines.append("🏆 Top señales:")
        for t in report["top5"]:
            sign = "+" if t["pnl"] >= 0 else ""
            lines.append(f"  • {t['symbol']}: {sign}{t['pnl']:.4f}")

    return "\n".join(lines)


# ── Envío Telegram ────────────────────────────────────────────────────────────


def send_telegram(token: str, chat_id: str, text: str) -> bool:
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    data = json.dumps({"chat_id": chat_id, "text": text, "parse_mode": "HTML"}).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status == 200
    except Exception:
        return False


# ── Entrypoint ────────────────────────────────────────────────────────────────


def generate_and_send(args: dict[str, Any], _context: Any = None) -> dict:
    """Generate and optionally send a report via Telegram.

    When called by the sandbox runner, ``_context`` carries the per-call
    credentials injected by the kernel (F1). In bare-metal dev (no runner),
    the function falls back to os.environ so existing dev workflows are
    unaffected.
    """
    trades = args.get("trades", [])
    equity_curve = args.get("equity_curve", [1.0])
    period = args.get("period", "weekly")
    config = args.get("config", {})

    report = generate_report(trades, equity_curve, period, config)

    message = format_telegram_message(report)
    report["telegram_message"] = message

    # Credentials are injected by the kernel via context['credentials'] (F1).
    # When _context is provided (sandbox runner path), read from it.
    # Fallback to os.environ for bare-metal dev (SANDBOX_STRICT=false).
    ctx_credentials: dict = {}
    if _context is not None and hasattr(_context, "metadata"):
        ctx_credentials = _context.metadata.get("credentials", {})
    token = ctx_credentials.get("TELEGRAM_BOT_TOKEN") or os.environ.get("TELEGRAM_BOT_TOKEN", "")
    chat_id = ctx_credentials.get("TELEGRAM_CHAT_ID") or os.environ.get("TELEGRAM_CHAT_ID", "")

    if token and chat_id:
        sent = send_telegram(token, chat_id, message)
        report["telegram_sent"] = sent
    else:
        report["telegram_sent"] = False
        report["telegram_note"] = (
            "Credenciales TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID no configuradas"
        )

    return report


if __name__ == "__main__":
    data = json.loads(sys.stdin.read())
    fn = data.get("function", "generate_and_send")
    args = data.get("args", {})

    if fn == "generate_and_send":
        out = generate_and_send(args)
    elif fn == "generate_report":
        out = generate_report(
            args.get("trades", []),
            args.get("equity_curve", [1.0]),
            args.get("period", "weekly"),
            args.get("config", {}),
        )
    else:
        out = {"error": f"Función desconocida: {fn}"}

    print(json.dumps(out))
