"""
Position Sizing Pyramid — pure math functions ported from position-sizing-pyramid plugin.

Van Tharp pyramiding: enter in tranches, add to winners.
References: Van Tharp (1999), Ed Seykota.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class Tranche:
    number: int           # 1-based (tranche 1 = initial entry)
    size_pct: float       # % of total target size for this tranche
    trigger_price: float  # price at which this tranche activates
    description: str


@dataclass
class PyramidPlan:
    symbol: str
    total_size_pct: float     # sum of all tranches as % of capital
    tranches: list[Tranche]
    entry_price: float
    stop_loss: float
    risk_per_tranche_r: float  # R multiples between tranches


@dataclass
class AddSignal:
    symbol: str
    add_now: bool
    reason: str
    tranche_number: int   # which tranche to add (2, 3, ...)
    size_pct: float       # % of capital for this tranche
    new_stop: float | None  # suggested new stop (breakeven or trailing)
    progress_pct: float   # % progress from entry toward trigger


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
    Compute the pyramid plan for a new signal.

    Args:
        entry_price:    entry price
        stop_loss:      initial stop loss
        target_price:   price target
        total_size_pct: total position size as % of capital
        entry_pct:      % of total size for the first tranche (0-100)
        add_pct:        % of total size for each additional tranche
        max_tranches:   maximum number of tranches
        add_trigger_r:  R multiples required to trigger each add

    Returns:
        PyramidPlan with all tranches and their activation levels
    """
    atr = abs(entry_price - stop_loss)
    if atr == 0:
        atr = entry_price * 0.01  # 1% fallback

    tranches: list[Tranche] = []

    # Tranche 1: initial entry
    t1_size = total_size_pct * (entry_pct / 100)
    tranches.append(
        Tranche(
            number=1,
            size_pct=round(t1_size, 2),
            trigger_price=entry_price,
            description=f"Initial entry ({entry_pct}% of target size)",
        )
    )

    # Additional tranches
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
    Evaluate whether to add a tranche to an already-open position.

    Args:
        current_price:     current market price
        entry_price:       original entry price
        stop_loss:         current stop loss
        tranches_executed: how many tranches have been executed
        max_tranches:      configured maximum

    Returns:
        AddSignal with the recommendation
    """
    atr = abs(entry_price - stop_loss)
    if atr == 0:
        atr = entry_price * 0.01

    if tranches_executed >= max_tranches:
        return AddSignal(
            symbol=symbol,
            add_now=False,
            reason=f"Pyramid complete ({max_tranches}/{max_tranches} tranches)",
            tranche_number=tranches_executed,
            size_pct=0.0,
            new_stop=None,
            progress_pct=100.0,
        )

    next_trigger = entry_price + (atr * add_trigger_r * tranches_executed)
    price_move = current_price - entry_price
    needed_move = next_trigger - entry_price
    progress = (price_move / needed_move * 100) if needed_move > 0 else 0

    if current_price < next_trigger:
        return AddSignal(
            symbol=symbol,
            add_now=False,
            reason=f"Price {current_price:.4f} < trigger {next_trigger:.4f}",
            tranche_number=tranches_executed,
            size_pct=0.0,
            new_stop=None,
            progress_pct=round(max(0.0, progress), 1),
        )

    tranche_num = tranches_executed + 1
    size = total_size_pct * (add_pct / 100)

    new_stop = None
    if trail_stop_after_add:
        new_stop = round(max(stop_loss, entry_price - atr * 0.5), 4)

    return AddSignal(
        symbol=symbol,
        add_now=True,
        reason=f"Price {current_price:.4f} >= trigger {next_trigger:.4f} → add #{tranche_num - 1}",
        tranche_number=tranche_num,
        size_pct=round(size, 2),
        new_stop=new_stop,
        progress_pct=100.0,
    )
