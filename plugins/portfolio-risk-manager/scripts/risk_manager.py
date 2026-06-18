"""
Portfolio Risk Manager — control de riesgo a nivel de cartera.

Diferencia vs otros plugins de disciplina:
- Kelly Criterion: dimensiona INDIVIDUALMENTE cada señal
- ATR Stop Loss: gestiona la SALIDA de posiciones individuales
- Circuit Breaker: actúa cuando el drawdown supera umbrales
- Correlation Guard: cancela señales correlacionadas
- Portfolio Risk Manager: controla la cartera GLOBALMENTE
  (exposición total, concentración, liquidez, nº posiciones)
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict, dataclass


@dataclass
class RiskAssessment:
    ok: bool
    total_exposure_pct: float  # % del capital actualmente invertido
    n_positions: int
    violations: list[str]  # límites violados
    warnings: list[str]  # advertencias (cerca del límite pero no violado)


@dataclass
class SignalAdjustment:
    symbol: str
    original_action: str
    adjusted_action: str  # puede ser "cancelled" si excede límites
    original_size_pct: float
    adjusted_size_pct: float
    reason: str


def assess_portfolio(
    portfolio: dict[str, dict],
    total_capital: float = 100.0,
    max_total_exposure_pct: float = 80.0,
    max_positions: int = 10,
    max_sector_exposure_pct: float = 30.0,
    min_cash_pct: float = 20.0,
) -> RiskAssessment:
    """
    Evalúa el estado de riesgo actual de la cartera.

    Args:
        portfolio:  { symbol: { size_pct, sector, market_value } }
        total_capital: capital total (normalmente 100 para %)
    """
    violations = []
    warnings = []

    if not portfolio:
        return RiskAssessment(
            ok=True,
            total_exposure_pct=0.0,
            n_positions=0,
            violations=[],
            warnings=[],
        )

    # Exposición total
    total_exposure = sum(float(pos.get("size_pct", 0.0)) for pos in portfolio.values())

    # Número de posiciones
    n_pos = len(portfolio)

    # Liquidez restante
    cash_pct = 100.0 - total_exposure

    if total_exposure > max_total_exposure_pct:
        violations.append(
            f"Exposición total {total_exposure:.1f}% > límite {max_total_exposure_pct:.1f}%"
        )
    elif total_exposure > max_total_exposure_pct * 0.9:
        warnings.append(
            f"Exposición total {total_exposure:.1f}% cerca del límite"
            f" ({max_total_exposure_pct:.1f}%)"
        )

    if n_pos > max_positions:
        violations.append(f"Número de posiciones {n_pos} > máximo {max_positions}")
    elif n_pos >= max_positions:
        warnings.append(f"Número de posiciones {n_pos} = máximo permitido")

    if cash_pct < min_cash_pct:
        violations.append(f"Liquidez {cash_pct:.1f}% < mínimo {min_cash_pct:.1f}%")

    # Concentración por sector
    sector_exposure: dict[str, float] = {}
    for _sym, pos in portfolio.items():
        sector = pos.get("sector", pos.get("asset_class", "unknown"))
        sector_exposure[sector] = sector_exposure.get(sector, 0.0) + float(pos.get("size_pct", 0.0))

    for sector, exposure in sector_exposure.items():
        if exposure > max_sector_exposure_pct:
            violations.append(
                f"Sector '{sector}': {exposure:.1f}% > límite {max_sector_exposure_pct:.1f}%"
            )
        elif exposure > max_sector_exposure_pct * 0.85:
            warnings.append(f"Sector '{sector}': {exposure:.1f}% cerca del límite")

    return RiskAssessment(
        ok=len(violations) == 0,
        total_exposure_pct=round(total_exposure, 2),
        n_positions=n_pos,
        violations=violations,
        warnings=warnings,
    )


def filter_signals_by_risk(
    signals: list[dict],
    portfolio: dict[str, dict],
    max_total_exposure_pct: float = 80.0,
    max_single_position_pct: float = 15.0,
    max_positions: int = 10,
    min_cash_pct: float = 20.0,
    warn_only: bool = False,
) -> tuple[list[dict], list[SignalAdjustment]]:
    """
    Filtra y ajusta señales para cumplir los límites de riesgo.

    Returns:
        (señales_ajustadas, lista_de_ajustes)
    """
    current_exposure = sum(float(p.get("size_pct", 0.0)) for p in portfolio.values())
    current_positions = len(portfolio)
    available_exposure = max_total_exposure_pct - current_exposure

    filtered: list[dict] = []
    adjustments: list[SignalAdjustment] = []

    # Solo procesar señales de entrada (nuevas posiciones)
    entry_signals = [s for s in signals if s.get("action") in ("long", "short")]
    other_signals = [s for s in signals if s.get("action") not in ("long", "short")]

    for sig in entry_signals:
        symbol = sig.get("symbol", "")
        size_pct = float(sig.get("size_pct", 5.0))
        original_size = size_pct

        reason_parts = []

        # Verificar límite de posiciones
        if current_positions >= max_positions and symbol not in portfolio:
            if warn_only:
                reason_parts.append(f"⚠️ límite posiciones ({current_positions}/{max_positions})")
            else:
                adjustments.append(
                    SignalAdjustment(
                        symbol=symbol,
                        original_action=sig["action"],
                        adjusted_action="cancelled",
                        original_size_pct=size_pct,
                        adjusted_size_pct=0.0,
                        reason=f"Cancelada: máximo de posiciones ({max_positions}) alcanzado",
                    )
                )
                continue

        # Verificar tamaño individual
        if size_pct > max_single_position_pct:
            size_pct = max_single_position_pct
            reason_parts.append(
                f"tamaño reducido a {max_single_position_pct:.0f}% (máx individual)"
            )

        # Verificar exposición total disponible
        if size_pct > available_exposure:
            if available_exposure <= 0 and not warn_only:
                adjustments.append(
                    SignalAdjustment(
                        symbol=symbol,
                        original_action=sig["action"],
                        adjusted_action="cancelled",
                        original_size_pct=original_size,
                        adjusted_size_pct=0.0,
                        reason=(
                            f"Cancelada: sin capacidad de exposición"
                            f" ({current_exposure:.1f}% / {max_total_exposure_pct:.1f}%)"
                        ),
                    )
                )
                continue
            size_pct = max(0.0, available_exposure)
            reason_parts.append(f"tamaño limitado a {size_pct:.1f}% por exposición total")

        # Verificar liquidez mínima
        new_cash = 100.0 - current_exposure - size_pct
        if new_cash < min_cash_pct:
            max_for_cash = 100.0 - current_exposure - min_cash_pct
            if max_for_cash <= 0 and not warn_only:
                adjustments.append(
                    SignalAdjustment(
                        symbol=symbol,
                        original_action=sig["action"],
                        adjusted_action="cancelled",
                        original_size_pct=original_size,
                        adjusted_size_pct=0.0,
                        reason=f"Cancelada: liquidez mínima {min_cash_pct:.0f}% no disponible",
                    )
                )
                continue
            size_pct = min(size_pct, max_for_cash)
            reason_parts.append(f"tamaño reducido por liquidez mínima {min_cash_pct:.0f}%")

        size_pct = round(size_pct, 2)
        adjusted_sig = {**sig, "size_pct": size_pct}

        if reason_parts:
            adjusted_sig["risk_notes"] = "; ".join(reason_parts)
            adjustments.append(
                SignalAdjustment(
                    symbol=symbol,
                    original_action=sig["action"],
                    adjusted_action=sig["action"],
                    original_size_pct=original_size,
                    adjusted_size_pct=size_pct,
                    reason="; ".join(reason_parts),
                )
            )

        filtered.append(adjusted_sig)
        # Actualizar exposición disponible para las siguientes señales
        if symbol not in portfolio:
            current_exposure += size_pct
            current_positions += 1
            available_exposure = max_total_exposure_pct - current_exposure

    return other_signals + filtered, adjustments


if __name__ == "__main__":
    data = json.load(sys.stdin)
    cmd = data.get("cmd", "filter_signals")

    if cmd == "assess_portfolio":
        result = assess_portfolio(
            portfolio=data.get("portfolio", {}),
            max_total_exposure_pct=data.get("max_total_exposure_pct", 80.0),
            max_positions=data.get("max_positions", 10),
            max_sector_exposure_pct=data.get("max_sector_exposure_pct", 30.0),
            min_cash_pct=data.get("min_cash_pct", 20.0),
        )
        print(json.dumps({"ok": True, "result": asdict(result)}))
    elif cmd == "filter_signals":
        filtered, adjustments = filter_signals_by_risk(
            signals=data.get("signals", []),
            portfolio=data.get("portfolio", {}),
            max_total_exposure_pct=data.get("max_total_exposure_pct", 80.0),
            max_single_position_pct=data.get("max_single_position_pct", 15.0),
            max_positions=data.get("max_positions", 10),
            min_cash_pct=data.get("min_cash_pct", 20.0),
            warn_only=data.get("warn_only", False),
        )
        print(
            json.dumps(
                {
                    "ok": True,
                    "signals": filtered,
                    "adjustments": [asdict(a) for a in adjustments],
                }
            )
        )
