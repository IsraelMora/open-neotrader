"""
Paper Trading — motor de simulación de portafolio virtual.

Mantiene estado de posiciones abiertas, historial de trades y métricas PnL.
El estado se persiste via store (ctx['portfolio']) entre ciclos.
"""

from dataclasses import dataclass
from datetime import date, datetime


@dataclass
class PaperPosition:
    symbol: str
    direction: str  # long | short
    entry_date: str
    entry_price: float
    shares: float
    cost: float  # incluye comisión
    current_price: float = 0.0
    unrealized_pnl: float = 0.0
    unrealized_pct: float = 0.0


@dataclass
class PaperTrade:
    symbol: str
    direction: str
    entry_date: str
    exit_date: str
    entry_price: float
    exit_price: float
    shares: float
    pnl: float
    pnl_pct: float
    commission: float


@dataclass
class PaperPortfolio:
    cash: float
    initial_capital: float
    positions: dict[str, dict]  # symbol → PaperPosition as dict
    trades: list[dict]  # PaperTrade as dict
    created_at: str
    updated_at: str


def load_portfolio(ctx: dict, initial_capital: float) -> PaperPortfolio:
    """Carga el portafolio paper del ctx o crea uno nuevo."""
    raw = ctx.get("paper_portfolio")
    if raw and isinstance(raw, dict):
        return PaperPortfolio(
            cash=float(raw.get("cash", initial_capital)),
            initial_capital=float(raw.get("initial_capital", initial_capital)),
            positions=raw.get("positions", {}),
            trades=raw.get("trades", []),
            created_at=raw.get("created_at", datetime.utcnow().isoformat()),
            updated_at=raw.get("updated_at", datetime.utcnow().isoformat()),
        )
    return PaperPortfolio(
        cash=initial_capital,
        initial_capital=initial_capital,
        positions={},
        trades=[],
        created_at=datetime.utcnow().isoformat(),
        updated_at=datetime.utcnow().isoformat(),
    )


def execute_signal(
    portfolio: PaperPortfolio,
    signal: dict,
    current_prices: dict[str, float],
    commission: float,
    slippage: float,
    max_pos_pct: float,
) -> tuple[PaperPortfolio, str]:
    """
    Ejecuta una señal en el portafolio paper.
    Retorna (portfolio_actualizado, log_message).
    """
    symbol = signal.get("symbol", "")
    action = signal.get("action", "")
    today = date.today().isoformat()

    price = current_prices.get(symbol)
    if not price:
        return portfolio, f"{symbol}: precio no disponible, señal ignorada"

    # Aplicar slippage
    if action == "long":
        exec_price = price * (1 + slippage)
    elif action == "short":
        exec_price = price * (1 - slippage)
    else:
        exec_price = price

    total_value = portfolio.cash + sum(
        float(pos.get("cost", 0)) for pos in portfolio.positions.values()
    )

    if action in ("long", "short"):
        if symbol in portfolio.positions:
            return portfolio, f"{symbol}: ya tiene posición abierta"

        # Tamaño: respeta max_position_pct del portafolio total
        max_position_value = total_value * (max_pos_pct / 100)
        capital_to_use = min(portfolio.cash * 0.95, max_position_value)

        if capital_to_use < 10:
            return portfolio, f"{symbol}: capital insuficiente (${portfolio.cash:.2f})"

        cost_per_share = exec_price * (1 + commission)
        shares = capital_to_use / cost_per_share
        total_cost = shares * cost_per_share

        portfolio.cash -= total_cost
        portfolio.positions[symbol] = {
            "symbol": symbol,
            "direction": action,
            "entry_date": today,
            "entry_price": round(exec_price, 4),
            "shares": round(shares, 4),
            "cost": round(total_cost, 2),
            "current_price": round(price, 4),
            "unrealized_pnl": 0.0,
            "unrealized_pct": 0.0,
        }
        return portfolio, (
            f"PAPER {action.upper()} {symbol}: "
            f"{shares:.2f} shares @ ${exec_price:.2f} "
            f"(coste: ${total_cost:.2f}, cash restante: ${portfolio.cash:.2f})"
        )

    elif action == "exit":
        pos = portfolio.positions.get(symbol)
        if not pos:
            return portfolio, f"{symbol}: sin posición paper abierta"

        shares = float(pos["shares"])
        entry_p = float(pos["entry_price"])
        direction = pos["direction"]

        gross = shares * exec_price
        comm = gross * commission
        proceeds = gross - comm

        if direction == "long":
            pnl = proceeds - float(pos["cost"])
        else:  # short
            pnl = float(pos["cost"]) - proceeds

        pnl_pct = pnl / float(pos["cost"]) * 100

        portfolio.cash += float(pos["cost"]) + pnl
        del portfolio.positions[symbol]

        portfolio.trades.append(
            {
                "symbol": symbol,
                "direction": direction,
                "entry_date": pos["entry_date"],
                "exit_date": today,
                "entry_price": round(entry_p, 4),
                "exit_price": round(exec_price, 4),
                "shares": round(shares, 4),
                "pnl": round(pnl, 2),
                "pnl_pct": round(pnl_pct, 2),
                "commission": round(comm, 2),
            }
        )

        return portfolio, (
            f"PAPER EXIT {symbol}: "
            f"PnL ${pnl:+.2f} ({pnl_pct:+.2f}%) "
            f"| cash total: ${portfolio.cash:.2f}"
        )

    return portfolio, f"{symbol}: acción '{action}' no reconocida"


def update_prices(
    portfolio: PaperPortfolio,
    current_prices: dict[str, float],
) -> PaperPortfolio:
    """Actualiza precios actuales y unrealized PnL de posiciones abiertas."""
    for symbol, pos in portfolio.positions.items():
        price = current_prices.get(symbol)
        if not price:
            continue
        pos["current_price"] = round(price, 4)
        direction = pos["direction"]
        entry_p = float(pos["entry_price"])
        shares = float(pos["shares"])
        cost = float(pos["cost"])

        upnl = (price - entry_p) * shares if direction == "long" else (entry_p - price) * shares

        pos["unrealized_pnl"] = round(upnl, 2)
        pos["unrealized_pct"] = round(upnl / cost * 100, 2) if cost > 0 else 0

    portfolio.updated_at = datetime.utcnow().isoformat()
    return portfolio


def portfolio_summary(portfolio: PaperPortfolio) -> dict:
    """Resumen del portafolio para reporte."""
    positions_value = sum(
        float(pos["cost"]) + float(pos.get("unrealized_pnl", 0))
        for pos in portfolio.positions.values()
    )
    total_value = portfolio.cash + positions_value
    total_return = total_value - portfolio.initial_capital
    total_return_pct = (
        total_return / portfolio.initial_capital * 100 if portfolio.initial_capital > 0 else 0
    )

    completed = portfolio.trades
    wins = [t for t in completed if t.get("pnl", 0) > 0]
    losses = [t for t in completed if t.get("pnl", 0) <= 0]
    win_rate = len(wins) / len(completed) * 100 if completed else 0

    total_wins = sum(t["pnl"] for t in wins)
    total_losses = abs(sum(t["pnl"] for t in losses))
    profit_factor = total_wins / total_losses if total_losses > 0 else 0

    unrealized_total = sum(float(p.get("unrealized_pnl", 0)) for p in portfolio.positions.values())

    return {
        "cash": round(portfolio.cash, 2),
        "positions_value": round(positions_value, 2),
        "total_value": round(total_value, 2),
        "total_return": round(total_return, 2),
        "total_return_pct": round(total_return_pct, 2),
        "unrealized_pnl": round(unrealized_total, 2),
        "open_positions": len(portfolio.positions),
        "completed_trades": len(completed),
        "win_rate_pct": round(win_rate, 1),
        "profit_factor": round(profit_factor, 2),
    }
