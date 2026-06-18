"""
Kelly Criterion position sizing — implementación de referencia.

Referencia: Kelly (1956), Thorp (2006).
"""

from __future__ import annotations

import json
import math
import sys
from dataclasses import asdict, dataclass


@dataclass
class KellyStats:
    n_trades: int
    win_rate: float  # fracción [0, 1]
    payoff_ratio: float  # avg_win / avg_loss
    kelly_full: float  # Kelly completo [0, 1]
    kelly_half: float  # Half-Kelly recomendado
    is_reliable: bool  # True si n_trades >= umbral mínimo
    avg_win_pct: float
    avg_loss_pct: float
    expectancy: float  # ganancia esperada por trade como fracción


@dataclass
class PositionResult:
    shares: int
    position_usd: float
    position_pct_capital: float
    kelly_fraction_used: float
    risk_usd: float  # pérdida máxima si salta el stop loss
    reward_usd: float  # ganancia esperada si alcanza take profit
    risk_reward_ratio: float
    warning: str | None


def compute_kelly(
    win_rate: float,
    payoff_ratio: float,
    fraction: float = 0.5,
) -> float:
    """
    Calcula la fracción Kelly ajustada.

    f* = (p * b - q) / b  donde b = payoff_ratio, p = win_rate, q = 1 - p

    Args:
        win_rate:     probabilidad de ganar [0, 1]
        payoff_ratio: avg_win / avg_loss
        fraction:     fracción del Kelly completo a usar (0.5 = Half-Kelly)

    Returns:
        fracción del capital a arriesgar [0, 1]
    """
    if payoff_ratio <= 0 or win_rate <= 0 or win_rate >= 1:
        return 0.0

    p = win_rate
    q = 1.0 - win_rate
    b = payoff_ratio

    kelly_full = (p * b - q) / b
    kelly_full = max(0.0, min(1.0, kelly_full))  # clamp [0, 1]
    return kelly_full * fraction


def stats_from_trades(
    trades: list[dict],
    min_required: int = 30,
) -> KellyStats:
    """
    Calcula estadísticas Kelly desde historial de trades.

    Args:
        trades: lista de dicts con 'pnl_pct' (ganancia/pérdida como %)
        min_required: mínimo de trades para considerar las stats fiables

    Returns:
        KellyStats
    """
    if not trades:
        return KellyStats(
            n_trades=0,
            win_rate=0.0,
            payoff_ratio=0.0,
            kelly_full=0.0,
            kelly_half=0.0,
            is_reliable=False,
            avg_win_pct=0.0,
            avg_loss_pct=0.0,
            expectancy=0.0,
        )

    pnls = [t.get("pnl_pct", 0.0) for t in trades]
    wins = [p for p in pnls if p > 0]
    losses = [abs(p) for p in pnls if p < 0]

    win_rate = len(wins) / len(pnls)
    avg_win = sum(wins) / len(wins) if wins else 0.0
    avg_loss = sum(losses) / len(losses) if losses else 0.001  # evitar div/0

    payoff_ratio = avg_win / avg_loss
    kelly_full = compute_kelly(win_rate, payoff_ratio, fraction=1.0)
    kelly_half = kelly_full * 0.5

    # Expectancy = (win_rate × avg_win) - (loss_rate × avg_loss)
    expectancy = win_rate * avg_win - (1 - win_rate) * avg_loss

    return KellyStats(
        n_trades=len(pnls),
        win_rate=round(win_rate, 4),
        payoff_ratio=round(payoff_ratio, 4),
        kelly_full=round(kelly_full, 4),
        kelly_half=round(kelly_half, 4),
        is_reliable=len(pnls) >= min_required,
        avg_win_pct=round(avg_win, 4),
        avg_loss_pct=round(avg_loss, 4),
        expectancy=round(expectancy, 4),
    )


def position_size(
    capital: float,
    price: float,
    stop_loss_pct: float,
    take_profit_pct: float,
    kelly_fraction: float,
    max_position_pct: float = 10.0,
    safety_size_pct: float = 2.0,
    use_safety: bool = False,
) -> PositionResult:
    """
    Calcula el tamaño de posición con Kelly.

    La lógica: Kelly indica qué fracción del capital arriesgar.
    La pérdida en caso de stop loss = (stop_loss_pct / 100) × posición.
    Por tanto: posición = capital × kelly_fraction / (stop_loss_pct / 100)

    Args:
        capital:          capital total disponible
        price:            precio actual del activo
        stop_loss_pct:    % de pérdida si salta el stop (ej. 2.0 = 2%)
        take_profit_pct:  % de ganancia esperada (ej. 3.0 = 3%)
        kelly_fraction:   fracción Kelly a aplicar (ej. 0.125 = 12.5%)
        max_position_pct: límite superior de posición como % del capital
        safety_size_pct:  tamaño de seguridad si kelly no es fiable
        use_safety:       si True, usa safety_size_pct en vez de kelly

    Returns:
        PositionResult
    """
    warning = None

    if use_safety or kelly_fraction <= 0:
        target_pct = safety_size_pct / 100.0
        warning = f"Kelly no fiable: usando tamaño de seguridad ({safety_size_pct}%)"
    else:
        sl_frac = stop_loss_pct / 100.0
        if sl_frac <= 0:
            target_pct = safety_size_pct / 100.0
            warning = "Stop loss inválido: usando tamaño de seguridad"
        else:
            # Posición = capital × kelly_fraction / stop_loss_pct
            target_pct = kelly_fraction / sl_frac
            max_pct = max_position_pct / 100.0
            if target_pct > max_pct:
                warning = (
                    f"Kelly sugiere {target_pct * 100:.1f}% pero se limita al {max_position_pct}%"
                )
                target_pct = max_pct

    position_usd = capital * target_pct
    shares = math.floor(position_usd / price) if price > 0 else 0
    actual_position_usd = shares * price

    risk_usd = actual_position_usd * (stop_loss_pct / 100.0)
    reward_usd = actual_position_usd * (take_profit_pct / 100.0)
    rr = reward_usd / risk_usd if risk_usd > 0 else 0.0

    return PositionResult(
        shares=shares,
        position_usd=round(actual_position_usd, 2),
        position_pct_capital=round(actual_position_usd / capital * 100, 2) if capital > 0 else 0.0,
        kelly_fraction_used=round(kelly_fraction, 4),
        risk_usd=round(risk_usd, 2),
        reward_usd=round(reward_usd, 2),
        risk_reward_ratio=round(rr, 2),
        warning=warning,
    )


if __name__ == "__main__":
    data = json.load(sys.stdin)
    cmd = data.get("cmd", "position_size")

    if cmd == "stats":
        result = stats_from_trades(
            trades=data.get("trades", []),
            min_required=data.get("min_required", 30),
        )
        print(json.dumps({"ok": True, "result": asdict(result)}))

    elif cmd == "position_size":
        result = position_size(
            capital=data["capital"],
            price=data["price"],
            stop_loss_pct=data.get("stop_loss_pct", 2.0),
            take_profit_pct=data.get("take_profit_pct", 3.0),
            kelly_fraction=data.get("kelly_fraction", 0.125),
            max_position_pct=data.get("max_position_pct", 10.0),
            safety_size_pct=data.get("safety_size_pct", 2.0),
            use_safety=data.get("use_safety", False),
        )
        print(json.dumps({"ok": True, "result": asdict(result)}))
    else:
        print(json.dumps({"ok": False, "error": f"cmd desconocido: {cmd}"}))
