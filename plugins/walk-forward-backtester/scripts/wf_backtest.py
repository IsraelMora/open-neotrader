"""
Walk-Forward Backtester
=======================
Validación out-of-sample con ventanas rodantes. Divide la historia en N ventanas,
optimiza en in-sample (IS) y valida en out-of-sample (OOS). Detecta overfitting
cuando el ratio Sharpe_OOS / Sharpe_IS cae por debajo de 0.5.

Basado en: Pardo (2008) "The Evaluation and Optimization of Trading Strategies"
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict, dataclass, field
from typing import Any

# ── Tipos ────────────────────────────────────────────────────────────────────


@dataclass
class WindowResult:
    window_idx: int
    is_start: int  # índice en prices
    is_end: int
    oos_start: int
    oos_end: int
    is_sharpe: float
    oos_sharpe: float
    is_trades: int
    oos_trades: int
    oos_win_rate: float
    oos_profit_factor: float
    oos_max_drawdown: float
    robustness_ratio: float  # OOS_Sharpe / IS_Sharpe (>0.5 = robusto)


@dataclass
class WalkForwardResult:
    n_windows: int
    avg_oos_sharpe: float
    avg_robustness_ratio: float
    robust_windows: int  # ventanas con robustness_ratio > 0.5
    total_windows: int
    verdict: str  # "ROBUSTO" | "SOBREAJUSTADO" | "INSUFICIENTE_DATOS"
    windows: list[WindowResult] = field(default_factory=list)
    summary: dict = field(default_factory=dict)


# ── Backtest de ventana ───────────────────────────────────────────────────────


def _returns_to_equity(returns: list[float]) -> list[float]:
    equity = [1.0]
    for r in returns:
        equity.append(equity[-1] * (1 + r))
    return equity


def _sharpe(returns: list[float], annual_factor: float = 252.0) -> float:
    if len(returns) < 2:
        return 0.0
    n = len(returns)
    mean = sum(returns) / n
    variance = sum((r - mean) ** 2 for r in returns) / (n - 1)
    std = variance**0.5
    if std < 1e-10:
        return 0.0
    return (mean / std) * (annual_factor**0.5)


def _max_drawdown(equity: list[float]) -> float:
    if not equity:
        return 0.0
    peak = equity[0]
    max_dd = 0.0
    for v in equity:
        if v > peak:
            peak = v
        dd = (peak - v) / peak if peak > 0 else 0.0
        if dd > max_dd:
            max_dd = dd
    return max_dd


def _run_simple_backtest(
    prices: list[float],
    signals: list[int],  # +1=long, -1=short, 0=flat
    commission: float,
    slippage: float,
) -> dict:
    """Simula un backtest con señales precomputadas. Devuelve métricas."""
    trades = []
    returns = []
    position = 0
    entry_price = 0.0

    for i in range(1, len(prices)):
        curr_price = prices[i]
        prev_price = prices[i - 1]

        # Cerrar posición si la señal cambia
        if position != 0 and signals[i] != position:
            cost = commission + slippage
            ret = position * (curr_price / entry_price - 1) - cost
            trades.append(ret)
            returns.append(ret)
            position = 0
        else:
            if position != 0:
                # Rendimiento diario en posición abierta
                daily = position * (curr_price / prev_price - 1)
                returns.append(daily)

        # Abrir nueva posición
        if position == 0 and signals[i] != 0:
            position = signals[i]
            entry_price = curr_price * (1 + slippage * signals[i])

    # Cerrar posición final
    if position != 0 and len(prices) > 0:
        ret = position * (prices[-1] / entry_price - 1) - commission - slippage
        trades.append(ret)
        returns.append(ret)

    equity = _returns_to_equity(returns)
    wins = [t for t in trades if t > 0]
    losses = [t for t in trades if t <= 0]
    gross_profit = sum(wins)
    gross_loss = abs(sum(losses))

    return {
        "n_trades": len(trades),
        "sharpe": _sharpe(returns),
        "win_rate": len(wins) / len(trades) if trades else 0.0,
        "profit_factor": gross_profit / gross_loss if gross_loss > 0 else float("inf"),
        "max_drawdown": _max_drawdown(equity),
        "total_return": (equity[-1] - 1) if equity else 0.0,
    }


# ── Señales de ejemplo (momentum simple) ─────────────────────────────────────


def _simple_momentum_signals(prices: list[float], lookback: int = 20) -> list[int]:
    """Señal de momentum: long si precio > MA(lookback), short si precio < MA."""
    signals = [0] * len(prices)
    for i in range(lookback, len(prices)):
        ma = sum(prices[i - lookback : i]) / lookback
        signals[i] = 1 if prices[i] > ma else -1
    return signals


# ── Walk-Forward ──────────────────────────────────────────────────────────────


def run_walk_forward(
    prices: list[float],
    n_windows: int = 5,
    in_sample_pct: float = 0.7,
    min_trades: int = 10,
    commission_pct: float = 0.001,
    slippage_pct: float = 0.0005,
) -> WalkForwardResult:
    """
    Ejecuta walk-forward sobre una serie de precios.
    Divide la historia total en n_windows ventanas solapadas (ancored walk-forward).
    Cada ventana = IS (70%) + OOS (30%).
    """
    n = len(prices)
    if n < 60:
        return WalkForwardResult(
            n_windows=0,
            avg_oos_sharpe=0.0,
            avg_robustness_ratio=0.0,
            robust_windows=0,
            total_windows=0,
            verdict="INSUFICIENTE_DATOS",
            summary={"error": f"Se necesitan al menos 60 precios, se recibieron {n}"},
        )

    # Ancored walk-forward: IS siempre empieza desde el inicio
    # El OOS avanza en cada ventana
    oos_total = n - int(n * in_sample_pct)
    oos_per_window = max(1, oos_total // n_windows)

    results: list[WindowResult] = []

    for w in range(n_windows):
        oos_end = n - (n_windows - 1 - w) * oos_per_window
        oos_start = oos_end - oos_per_window
        is_end = oos_start

        if is_end < 20 or oos_end > n:
            continue

        is_prices = prices[:is_end]
        oos_prices = prices[oos_start:oos_end]

        is_signals = _simple_momentum_signals(is_prices)
        oos_signals = _simple_momentum_signals(oos_prices)

        is_metrics = _run_simple_backtest(is_prices, is_signals, commission_pct, slippage_pct)
        oos_metrics = _run_simple_backtest(oos_prices, oos_signals, commission_pct, slippage_pct)

        is_sharpe = is_metrics["sharpe"]
        oos_sharpe = oos_metrics["sharpe"]

        # Robustness ratio: cuánto del IS performance se preserva en OOS
        robustness = oos_sharpe / is_sharpe if abs(is_sharpe) > 0.01 else 0.0

        results.append(
            WindowResult(
                window_idx=w,
                is_start=0,
                is_end=is_end,
                oos_start=oos_start,
                oos_end=oos_end,
                is_sharpe=round(is_sharpe, 3),
                oos_sharpe=round(oos_sharpe, 3),
                is_trades=is_metrics["n_trades"],
                oos_trades=oos_metrics["n_trades"],
                oos_win_rate=round(oos_metrics["win_rate"], 3),
                oos_profit_factor=round(oos_metrics["profit_factor"], 3),
                oos_max_drawdown=round(oos_metrics["max_drawdown"], 3),
                robustness_ratio=round(robustness, 3),
            )
        )

    if not results:
        return WalkForwardResult(
            n_windows=0,
            avg_oos_sharpe=0.0,
            avg_robustness_ratio=0.0,
            robust_windows=0,
            total_windows=0,
            verdict="INSUFICIENTE_DATOS",
        )

    valid = [r for r in results if r.oos_trades >= min_trades]
    avg_oos_sharpe = sum(r.oos_sharpe for r in valid) / len(valid) if valid else 0.0
    avg_robustness = sum(r.robustness_ratio for r in valid) / len(valid) if valid else 0.0
    robust_count = sum(1 for r in valid if r.robustness_ratio >= 0.5)

    # Veredicto: robusto si ≥50% de ventanas tienen robustness_ratio ≥ 0.5
    if len(valid) < 2:
        verdict = "INSUFICIENTE_DATOS"
    elif robust_count / len(valid) >= 0.5:
        verdict = "ROBUSTO"
    else:
        verdict = "SOBREAJUSTADO"

    return WalkForwardResult(
        n_windows=len(results),
        avg_oos_sharpe=round(avg_oos_sharpe, 3),
        avg_robustness_ratio=round(avg_robustness, 3),
        robust_windows=robust_count,
        total_windows=len(valid),
        verdict=verdict,
        windows=results,
        summary={
            "avg_oos_win_rate": round(sum(r.oos_win_rate for r in valid) / len(valid), 3)
            if valid
            else 0.0,
            "avg_oos_profit_factor": round(sum(r.oos_profit_factor for r in valid) / len(valid), 3)
            if valid
            else 0.0,
            "avg_oos_max_drawdown": round(sum(r.oos_max_drawdown for r in valid) / len(valid), 3)
            if valid
            else 0.0,
            "pct_robust_windows": round(robust_count / len(valid), 3) if valid else 0.0,
        },
    )


def analyze_strategy(prices: list[float], config: dict[str, Any]) -> dict:
    """Punto de entrada principal para el LLM via tools."""
    result = run_walk_forward(
        prices=prices,
        n_windows=int(config.get("n_windows", 5)),
        in_sample_pct=float(config.get("in_sample_pct", 0.7)),
        min_trades=int(config.get("min_trades", 10)),
        commission_pct=float(config.get("commission_pct", 0.001)),
        slippage_pct=float(config.get("slippage_pct", 0.0005)),
    )
    return asdict(result)


if __name__ == "__main__":
    data = json.loads(sys.stdin.read())
    fn = data.get("function", "analyze_strategy")
    args = data.get("args", {})

    if fn == "analyze_strategy":
        out = analyze_strategy(args["prices"], args.get("config", {}))
    else:
        out = {"error": f"Función desconocida: {fn}"}

    print(json.dumps(out))
