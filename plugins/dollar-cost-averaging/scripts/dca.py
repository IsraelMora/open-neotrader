"""Dollar Cost Averaging — compras periódicas de importe fijo (Vanguard 2012)."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date


@dataclass
class DcaPosition:
    symbol: str
    total_invested: float
    shares: float
    avg_cost: float
    last_buy_date: str | None
    buy_count: int


@dataclass
class DcaSignal:
    symbol: str
    action: str  # "buy" | "skip"
    amount: float  # USD a invertir
    reason: str
    days_since_last: int


def load_dca_state(state_path: str) -> dict[str, DcaPosition]:
    """Lee estado DCA desde archivo JSON."""
    try:
        with open(state_path) as f:
            raw = json.load(f)
        return {sym: DcaPosition(**data) for sym, data in raw.items()}
    except (FileNotFoundError, json.JSONDecodeError, TypeError):
        return {}


def save_dca_state(positions: dict[str, DcaPosition], state_path: str) -> None:
    import dataclasses

    data = {sym: dataclasses.asdict(pos) for sym, pos in positions.items()}
    with open(state_path, "w") as f:
        json.dump(data, f, indent=2)


def days_since(date_str: str | None) -> int:
    """Días desde la última compra. Retorna 9999 si nunca se compró."""
    if not date_str:
        return 9999
    try:
        last = date.fromisoformat(date_str)
        return (date.today() - last).days
    except ValueError:
        return 9999


def compute_dca_signals(
    universe: list[str],
    current_prices: dict[str, float],
    dca_positions: dict[str, DcaPosition],
    amount_per_cycle: float = 100.0,
    frequency_days: int = 7,
    max_positions: int = 5,
    min_dip_pct: float = 0.0,
    volatility_boost: bool = False,
    volatility_multiplier: float = 2.0,
    recent_returns: dict[str, float] | None = None,
) -> list[DcaSignal]:
    """
    Genera señales DCA para el universo activo.

    La estrategia es matemáticamente ventajosa porque:
    - Compra más participaciones cuando el precio es bajo
    - Compra menos participaciones cuando el precio es alto
    - El precio medio de adquisición siempre < precio medio del mercado en períodos volátiles
    - Elimina el timing risk (market timing is 0% success in long horizons)
    """
    signals: list[DcaSignal] = []
    active_positions = len(dca_positions)

    for symbol in universe:
        price = current_prices.get(symbol)
        if price is None or price <= 0:
            continue

        pos = dca_positions.get(symbol)
        last_buy_str = pos.last_buy_date if pos else None
        elapsed_days = days_since(last_buy_str)

        # No es momento de comprar aún
        if elapsed_days < frequency_days:
            signals.append(
                DcaSignal(
                    symbol=symbol,
                    action="skip",
                    amount=0.0,
                    reason=f"próxima compra en {frequency_days - elapsed_days}d",
                    days_since_last=elapsed_days,
                )
            )
            continue

        # Límite de posiciones activas (solo si nunca hemos comprado este activo)
        if pos is None and active_positions >= max_positions:
            signals.append(
                DcaSignal(
                    symbol=symbol,
                    action="skip",
                    amount=0.0,
                    reason=f"máximo de posiciones alcanzado ({max_positions})",
                    days_since_last=elapsed_days,
                )
            )
            continue

        # Filtro de caída mínima
        recent_ret = recent_returns.get(symbol, 0.0) if recent_returns else 0.0
        if min_dip_pct > 0 and recent_ret > -min_dip_pct / 100:
            signals.append(
                DcaSignal(
                    symbol=symbol,
                    action="skip",
                    amount=0.0,
                    reason=(
                        f"sin caída suficiente"
                        f" (mín {min_dip_pct:.1f}%, actual {recent_ret * 100:.1f}%)"
                    ),
                    days_since_last=elapsed_days,
                )
            )
            continue

        # Calcular importe — boost si cayó más del 5%
        invest_amount = amount_per_cycle
        if volatility_boost and recent_ret < -0.05:
            invest_amount *= volatility_multiplier

        reason_parts = [f"DCA periódico ({elapsed_days}d desde última compra)"]
        if volatility_boost and invest_amount > amount_per_cycle:
            reason_parts.append(f"boost ×{volatility_multiplier} por caída {recent_ret * 100:.1f}%")

        signals.append(
            DcaSignal(
                symbol=symbol,
                action="buy",
                amount=invest_amount,
                reason="; ".join(reason_parts),
                days_since_last=elapsed_days,
            )
        )

        if pos is None:
            active_positions += 1

    return signals


def update_position(
    pos: DcaPosition | None,
    symbol: str,
    amount: float,
    price: float,
) -> DcaPosition:
    """Actualiza posición DCA con nueva compra."""
    today = date.today().isoformat()
    if pos is None:
        shares = amount / price
        return DcaPosition(
            symbol=symbol,
            total_invested=amount,
            shares=shares,
            avg_cost=price,
            last_buy_date=today,
            buy_count=1,
        )
    new_shares = amount / price
    total_shares = pos.shares + new_shares
    total_invested = pos.total_invested + amount
    avg_cost = total_invested / total_shares if total_shares > 0 else price
    return DcaPosition(
        symbol=symbol,
        total_invested=total_invested,
        shares=total_shares,
        avg_cost=avg_cost,
        last_buy_date=today,
        buy_count=pos.buy_count + 1,
    )


def portfolio_summary(positions: dict[str, DcaPosition], current_prices: dict[str, float]) -> dict:
    total_invested = sum(p.total_invested for p in positions.values())
    total_value = sum(
        p.shares * current_prices.get(p.symbol, p.avg_cost) for p in positions.values()
    )
    pnl = total_value - total_invested
    pnl_pct = pnl / total_invested * 100 if total_invested > 0 else 0.0
    return {
        "total_invested": total_invested,
        "total_value": total_value,
        "unrealized_pnl": pnl,
        "unrealized_pnl_pct": pnl_pct,
        "positions": len(positions),
        "average_buy_count": sum(p.buy_count for p in positions.values()) / max(1, len(positions)),
    }
