"""
Risk Envelope (AI-First)
========================
Veto duro matemático sobre propuestas de la IA.

Principio: La IA propone, el envelope dispone.
Ningún trade puede pasar si viola los límites de riesgo, sin importar la convicción
del LLM. Los frenos son matemáticamente inviolables y se aplican ANTES de la ejecución.

Inspirado en: trading-test/domain/ai_first.py (arquitectura hexagonal)
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict, dataclass, field

# ── Tipos ────────────────────────────────────────────────────────────────────


@dataclass
class Position:
    symbol: str
    qty: float
    current_price: float
    market_value: float  # qty * current_price


@dataclass
class TradeProposal:
    symbol: str
    action: str  # "buy" | "sell" | "short" | "cover"
    qty: float
    price: float
    notional: float  # qty * price


@dataclass
class VetoResult:
    proposal: TradeProposal
    approved: bool
    veto_reason: str | None
    adjusted_qty: float | None  # qty ajustada si se reescaló (None si no)
    adjusted_notional: float | None


@dataclass
class EnvelopeResult:
    portfolio_value: float
    total_exposure_before: float
    total_exposure_after: float
    n_open_positions_before: int
    proposals: list[VetoResult] = field(default_factory=list)
    vetoed: int = 0
    approved: int = 0
    rescaled: int = 0
    summary: str = ""


# ── Risk Envelope ────────────────────────────────────────────────────────────


def apply_risk_envelope(
    proposals: list[dict],
    portfolio_value: float,
    positions: list[dict],
    config: dict,
) -> EnvelopeResult:
    """
    Aplica los frenos de riesgo a una lista de propuestas de trade.

    Reglas (en orden de aplicación):
    1. Cortos prohibidos (si allow_shorts=false)
    2. Máximo por operación individual (max_single_trade_pct)
    3. Máximo por activo (max_position_pct) — reescala si supera
    4. Máximo de posiciones abiertas (max_open_positions)
    5. Exposición total máxima (max_total_exposure) — reescala si supera
    """
    cfg_max_pos_pct = float(config.get("max_position_pct", 0.40))
    cfg_max_exposure = float(config.get("max_total_exposure", 0.95))
    cfg_allow_shorts = bool(config.get("allow_shorts", False))
    cfg_max_trade_pct = float(config.get("max_single_trade_pct", 0.10))
    cfg_max_open = int(config.get("max_open_positions", 10))

    # Posiciones actuales: exposición por símbolo
    existing: dict[str, float] = {}
    for p in positions:
        sym = p.get("symbol", "")
        mv = float(p.get("market_value", p.get("qty", 0) * p.get("current_price", 0)))
        existing[sym] = mv

    total_exposure_before = sum(existing.values())
    n_open_before = len(existing)

    # Procesar propuestas
    results: list[VetoResult] = []
    current_exposure = total_exposure_before
    current_positions = dict(existing)  # copia mutable

    for raw in proposals:
        trade = TradeProposal(
            symbol=raw.get("symbol", ""),
            action=raw.get("action", "buy").lower(),
            qty=float(raw.get("qty", 0)),
            price=float(raw.get("price", 0)),
            notional=float(raw.get("qty", 0)) * float(raw.get("price", 0)),
        )

        # Regla 1: Cortos prohibidos
        if not cfg_allow_shorts and trade.action in ("short", "sell_short"):
            results.append(
                VetoResult(
                    proposal=trade,
                    approved=False,
                    veto_reason="Cortos prohibidos (allow_shorts=false)",
                    adjusted_qty=None,
                    adjusted_notional=None,
                )
            )
            continue

        # Regla 2: Tamaño máximo por trade individual
        max_notional_per_trade = portfolio_value * cfg_max_trade_pct
        if trade.notional > max_notional_per_trade:
            # Reescalar al máximo permitido
            factor = max_notional_per_trade / trade.notional
            trade = _rescale(trade, factor)

        # Regla 3: Máximo por activo
        current_pos_in_symbol = current_positions.get(trade.symbol, 0.0)
        projected_pos = current_pos_in_symbol + (
            trade.notional if trade.action == "buy" else -trade.notional
        )
        max_allowed = portfolio_value * cfg_max_pos_pct

        if projected_pos > max_allowed:
            available = max_allowed - current_pos_in_symbol
            if available <= 0:
                results.append(
                    VetoResult(
                        proposal=trade,
                        approved=False,
                        veto_reason=(
                            f"Posición en {trade.symbol} ya alcanzó el límite"
                            f" ({cfg_max_pos_pct * 100:.0f}% del portafolio)"
                        ),
                        adjusted_qty=None,
                        adjusted_notional=None,
                    )
                )
                continue
            factor = available / trade.notional
            trade = _rescale(trade, factor)

        # Regla 4: Número máximo de posiciones
        is_new_position = (
            trade.symbol not in current_positions or current_positions[trade.symbol] == 0
        )
        if is_new_position and trade.action == "buy":
            active_count = sum(1 for v in current_positions.values() if v > 0)
            if active_count >= cfg_max_open:
                results.append(
                    VetoResult(
                        proposal=trade,
                        approved=False,
                        veto_reason=f"Límite de {cfg_max_open} posiciones abiertas alcanzado",
                        adjusted_qty=None,
                        adjusted_notional=None,
                    )
                )
                continue

        # Regla 5: Exposición total máxima
        projected_exposure = current_exposure + (
            trade.notional if trade.action == "buy" else -trade.notional
        )
        max_exposure = portfolio_value * cfg_max_exposure

        if projected_exposure > max_exposure:
            available = max_exposure - current_exposure
            if available <= 0:
                results.append(
                    VetoResult(
                        proposal=trade,
                        approved=False,
                        veto_reason=(
                            f"Exposición total máxima alcanzada"
                            f" ({cfg_max_exposure * 100:.0f}%)"
                        ),
                        adjusted_qty=None,
                        adjusted_notional=None,
                    )
                )
                continue
            factor = available / trade.notional
            trade = _rescale(trade, factor)

        # Trade aprobado (posiblemente reescalado)
        original = TradeProposal(
            symbol=raw.get("symbol", ""),
            action=raw.get("action", "buy").lower(),
            qty=float(raw.get("qty", 0)),
            price=float(raw.get("price", 0)),
            notional=float(raw.get("qty", 0)) * float(raw.get("price", 0)),
        )
        was_rescaled = abs(trade.qty - original.qty) > 1e-8

        results.append(
            VetoResult(
                proposal=trade,
                approved=True,
                veto_reason=None,
                adjusted_qty=round(trade.qty, 6) if was_rescaled else None,
                adjusted_notional=round(trade.notional, 2) if was_rescaled else None,
            )
        )

        # Actualizar estado del portafolio simulado
        if trade.action == "buy":
            current_positions[trade.symbol] = (
                current_positions.get(trade.symbol, 0.0) + trade.notional
            )
            current_exposure += trade.notional
        elif trade.action in ("sell", "close"):
            current_positions[trade.symbol] = max(
                0.0, current_positions.get(trade.symbol, 0.0) - trade.notional
            )
            current_exposure = max(0.0, current_exposure - trade.notional)

    vetoed = sum(1 for r in results if not r.approved)
    approved = sum(1 for r in results if r.approved)
    rescaled = sum(1 for r in results if r.approved and r.adjusted_qty is not None)

    return EnvelopeResult(
        portfolio_value=portfolio_value,
        total_exposure_before=round(total_exposure_before, 2),
        total_exposure_after=round(current_exposure, 2),
        n_open_positions_before=n_open_before,
        proposals=results,
        vetoed=vetoed,
        approved=approved,
        rescaled=rescaled,
        summary=(
            f"{approved} aprobadas ({rescaled} reescaladas), "
            f"{vetoed} vetadas de {len(proposals)} propuestas"
        ),
    )


def _rescale(trade: TradeProposal, factor: float) -> TradeProposal:
    return TradeProposal(
        symbol=trade.symbol,
        action=trade.action,
        qty=trade.qty * factor,
        price=trade.price,
        notional=trade.notional * factor,
    )


def check_portfolio_health(portfolio_value: float, positions: list[dict], config: dict) -> dict:
    """Diagnóstico del estado actual del portafolio contra los límites del envelope."""
    cfg_max_pos_pct = float(config.get("max_position_pct", 0.40))
    cfg_max_exposure = float(config.get("max_total_exposure", 0.95))
    cfg_max_open = int(config.get("max_open_positions", 10))

    alerts = []
    by_symbol = {}
    total_exposure = 0.0

    for p in positions:
        sym = p.get("symbol", "")
        mv = float(p.get("market_value", p.get("qty", 0) * p.get("current_price", 0)))
        by_symbol[sym] = mv
        total_exposure += mv
        pct = mv / portfolio_value if portfolio_value > 0 else 0
        if pct > cfg_max_pos_pct:
            alerts.append(f"ALERTA: {sym} = {pct:.1%} supera el límite de {cfg_max_pos_pct:.0%}")

    exposure_pct = total_exposure / portfolio_value if portfolio_value > 0 else 0
    if exposure_pct > cfg_max_exposure:
        alerts.append(
            f"ALERTA: Exposición total {exposure_pct:.1%}"
            f" supera el límite de {cfg_max_exposure:.0%}"
        )

    if len(by_symbol) > cfg_max_open:
        alerts.append(
            f"ALERTA: {len(by_symbol)} posiciones abiertas superan el límite de {cfg_max_open}"
        )

    return {
        "healthy": len(alerts) == 0,
        "total_exposure": round(total_exposure, 2),
        "total_exposure_pct": round(exposure_pct, 3),
        "n_positions": len(by_symbol),
        "by_symbol": {sym: round(mv / portfolio_value, 3) for sym, mv in by_symbol.items()},
        "alerts": alerts,
    }


# ── Main ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    data = json.loads(sys.stdin.read())
    fn = data.get("function", "apply_risk_envelope")
    args = data.get("args", {})

    if fn == "apply_risk_envelope":
        result = apply_risk_envelope(
            proposals=args.get("proposals", []),
            portfolio_value=float(args.get("portfolio_value", 0)),
            positions=args.get("positions", []),
            config=args.get("config", {}),
        )
        out = asdict(result)
    elif fn == "check_portfolio_health":
        out = check_portfolio_health(
            portfolio_value=float(args.get("portfolio_value", 0)),
            positions=args.get("positions", []),
            config=args.get("config", {}),
        )
    else:
        out = {"error": f"Función desconocida: {fn}"}

    print(json.dumps(out))
