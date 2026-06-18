"""
Position Sizing Pyramid — implementación de referencia.

Pirámide de Van Tharp: entra con fracción inicial del tamaño objetivo
y añade tranches conforme la posición avanza a favor.

Matemática:
- Coste medio ponderado nunca supera el precio de entrada inicial
- El stop loss ajustado protege el capital total en riesgo
- Expected value mejora porque sólo añades en posiciones validadas
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict, dataclass


@dataclass
class Tranche:
    number: int  # 1-based (tranche 1 = entrada inicial)
    size_pct: float  # % del tamaño objetivo total para esta tranche
    trigger_price: float  # precio al que se activa (si ya tienes posición)
    description: str


@dataclass
class PyramidPlan:
    symbol: str
    total_size_pct: float  # suma de todas las tranches como % del capital
    tranches: list[Tranche]
    entry_price: float
    stop_loss: float
    risk_per_tranche_r: float  # múltiplos R entre tranches


@dataclass
class AddSignal:
    symbol: str
    add_now: bool
    reason: str
    tranche_number: int  # qué tranche añadir (2, 3, ...)
    size_pct: float  # % del capital para esta tranche
    new_stop: float | None  # nuevo stop sugerido (breakeven o trailing)
    progress_pct: float  # % avance desde entrada hacia trigger


def calculate_tranches(
    symbol: str,
    entry_price: float,
    stop_loss: float,
    target_price: float,
    total_size_pct: float = 10.0,
    entry_pct: float = 40.0,
    add_pct: float = 30.0,
    max_tranches: int = 3,
    add_trigger_r: float = 1.0,
) -> PyramidPlan:
    """
    Calcula el plan de pirámide para una nueva señal.

    Args:
        entry_price:    precio de entrada
        stop_loss:      stop loss inicial
        target_price:   objetivo de precio
        total_size_pct: tamaño total de la posición como % del capital
        entry_pct:      % del tamaño total para la primera tranche (0-100)
        add_pct:        % del tamaño total por cada tranche adicional
        max_tranches:   número máximo de tranches
        add_trigger_r:  múltiplos R para trigger de add

    Returns:
        PyramidPlan con todas las tranches y sus niveles de activación
    """
    atr = abs(entry_price - stop_loss)
    if atr == 0:
        atr = entry_price * 0.01  # fallback 1%

    tranches: list[Tranche] = []

    # Tranche 1: entrada inicial
    t1_size = total_size_pct * (entry_pct / 100)
    tranches.append(
        Tranche(
            number=1,
            size_pct=round(t1_size, 2),
            trigger_price=entry_price,
            description=f"Entrada inicial ({entry_pct}% del tamaño objetivo)",
        )
    )

    # Tranches adicionales
    allocated_pct = entry_pct
    for i in range(2, max_tranches + 1):
        remaining = 100 - allocated_pct
        if remaining <= 0:
            break
        this_add = min(add_pct, remaining)
        trigger_price = entry_price + (atr * add_trigger_r * (i - 1))
        size = total_size_pct * (this_add / 100)
        tranches.append(
            Tranche(
                number=i,
                size_pct=round(size, 2),
                trigger_price=round(trigger_price, 4),
                description=f"Add #{i - 1} @ +{add_trigger_r * (i - 1):.1f}R",
            )
        )
        allocated_pct += this_add

    return PyramidPlan(
        symbol=symbol,
        total_size_pct=round(total_size_pct, 2),
        tranches=tranches,
        entry_price=entry_price,
        stop_loss=stop_loss,
        risk_per_tranche_r=add_trigger_r,
    )


def evaluate_add(
    symbol: str,
    current_price: float,
    entry_price: float,
    stop_loss: float,
    tranches_executed: int,
    max_tranches: int,
    add_trigger_r: float,
    add_pct: float,
    total_size_pct: float,
    trail_stop_after_add: bool = True,
) -> AddSignal:
    """
    Evalúa si se debe añadir una tranche a una posición ya abierta.

    Args:
        current_price:      precio actual del mercado
        entry_price:        precio de la entrada original
        stop_loss:          stop loss actual
        tranches_executed:  cuántas tranches ya se ejecutaron
        max_tranches:       máximo configurado

    Returns:
        AddSignal con la recomendación
    """
    atr = abs(entry_price - stop_loss)
    if atr == 0:
        atr = entry_price * 0.01

    if tranches_executed >= max_tranches:
        return AddSignal(
            symbol=symbol,
            add_now=False,
            reason=f"Pirámide completa ({max_tranches}/{max_tranches} tranches)",
            tranche_number=tranches_executed,
            size_pct=0.0,
            new_stop=None,
            progress_pct=100.0,
        )

    # Cuánto debe avanzar el precio para el siguiente add
    next_trigger = entry_price + (atr * add_trigger_r * tranches_executed)
    price_move = current_price - entry_price
    needed_move = next_trigger - entry_price
    progress = (price_move / needed_move * 100) if needed_move > 0 else 0

    if current_price < next_trigger:
        return AddSignal(
            symbol=symbol,
            add_now=False,
            reason=f"Precio {current_price:.4f} < trigger {next_trigger:.4f}",
            tranche_number=tranches_executed,
            size_pct=0.0,
            new_stop=None,
            progress_pct=round(max(0.0, progress), 1),
        )

    tranche_num = tranches_executed + 1
    size = total_size_pct * (add_pct / 100)

    new_stop = None
    if trail_stop_after_add:
        # Mover stop al breakeven (precio de entrada) o trailing con 1 ATR
        new_stop = round(max(stop_loss, entry_price - atr * 0.5), 4)

    return AddSignal(
        symbol=symbol,
        add_now=True,
        reason=f"Precio {current_price:.4f} >= trigger {next_trigger:.4f} → add #{tranche_num - 1}",
        tranche_number=tranche_num,
        size_pct=round(size, 2),
        new_stop=new_stop,
        progress_pct=100.0,
    )


if __name__ == "__main__":
    data = json.load(sys.stdin)
    cmd = data.get("cmd", "calculate_tranches")

    if cmd == "calculate_tranches":
        plan = calculate_tranches(
            symbol=data.get("symbol", ""),
            entry_price=data["entry_price"],
            stop_loss=data["stop_loss"],
            target_price=data.get("target_price", data["entry_price"] * 1.1),
            total_size_pct=data.get("total_size_pct", 10.0),
            entry_pct=data.get("entry_pct", 40.0),
            add_pct=data.get("add_pct", 30.0),
            max_tranches=data.get("max_tranches", 3),
            add_trigger_r=data.get("add_trigger_r", 1.0),
        )
        print(json.dumps({"ok": True, "plan": asdict(plan)}))
    elif cmd == "evaluate_add":
        sig = evaluate_add(
            symbol=data.get("symbol", ""),
            current_price=data["current_price"],
            entry_price=data["entry_price"],
            stop_loss=data["stop_loss"],
            tranches_executed=data.get("tranches_executed", 1),
            max_tranches=data.get("max_tranches", 3),
            add_trigger_r=data.get("add_trigger_r", 1.0),
            add_pct=data.get("add_pct", 30.0),
            total_size_pct=data.get("total_size_pct", 10.0),
            trail_stop_after_add=data.get("trail_stop_after_add", True),
        )
        print(json.dumps({"ok": True, "signal": asdict(sig)}))
