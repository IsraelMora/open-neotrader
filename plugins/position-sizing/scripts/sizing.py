"""
Kelly Criterion sizing — pure math functions ported from kelly-criterion plugin.

References: Kelly (1956), Thorp (2006).
"""

from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass
class KellyStats:
    n_trades: int
    win_rate: float       # fraction [0, 1]
    payoff_ratio: float   # avg_win / avg_loss
    kelly_full: float     # full Kelly [0, 1]
    kelly_half: float     # Half-Kelly
    is_reliable: bool     # True if n_trades >= min_required
    avg_win_pct: float
    avg_loss_pct: float
    expectancy: float     # expected gain per trade as fraction


@dataclass
class PositionResult:
    shares: int
    position_usd: float
    position_pct_capital: float
    kelly_fraction_used: float
    risk_usd: float
    reward_usd: float
    risk_reward_ratio: float
    warning: str | None


def compute_kelly(
    win_rate: float,
    payoff_ratio: float,
    fraction: float = 0.5,
) -> float:
    """
    Compute the adjusted Kelly fraction.

    f* = (p * b - q) / b  where b=payoff_ratio, p=win_rate, q=1-p

    Args:
        win_rate:     probability of winning [0, 1]
        payoff_ratio: avg_win / avg_loss
        fraction:     fraction of full Kelly to use (0.5 = Half-Kelly)

    Returns:
        fraction of capital to risk [0, 1]
    """
    if payoff_ratio <= 0 or win_rate <= 0 or win_rate >= 1:
        return 0.0

    p = win_rate
    q = 1.0 - win_rate
    b = payoff_ratio

    kelly_full = (p * b - q) / b
    kelly_full = max(0.0, min(1.0, kelly_full))
    return kelly_full * fraction


def stats_from_trades(
    trades: list[dict],
    min_required: int = 30,
) -> KellyStats:
    """
    Compute Kelly statistics from trade history.

    Args:
        trades:       list of dicts with 'pnl_pct' (gain/loss as %)
        min_required: minimum trades for reliable stats

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
    avg_loss = sum(losses) / len(losses) if losses else 0.001  # avoid div/0

    payoff_ratio = avg_win / avg_loss
    kelly_full = compute_kelly(win_rate, payoff_ratio, fraction=1.0)
    kelly_half = kelly_full * 0.5
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


def compute_inverse_vol_weights(
    volatilities: dict[str, float],
    vol_floor: float = 0.01,
) -> dict[str, float]:
    """
    Inverse-volatility (risk-parity) weighting across a batch of candidates.

    w_i = (1 / vol_i) / sum_j(1 / vol_j)

    Lower-volatility assets get a larger weight — no single high-vol position
    dominates the sleeve. This is the sizing half of dual/time-series momentum
    (see docs/design/trading-strategy.md step 4: "volatility-targeted sizing").

    Args:
        volatilities: { symbol: annualized volatility (fraction, e.g. 0.20) }
        vol_floor:    minimum volatility used in the division, guards against
                      div/0 or a runaway weight for a near-zero-vol asset.

    Returns:
        { symbol: weight } — weights sum to 1.0 (empty dict if no input).
        Caller is responsible for clamping each weight against the kernel's
        max_position_pct — this function only expresses the relative
        risk-parity allocation.
    """
    if not volatilities:
        return {}

    inv_vol = {symbol: 1.0 / max(vol, vol_floor) for symbol, vol in volatilities.items()}
    total = sum(inv_vol.values())
    if total <= 0:
        # Degenerate case (shouldn't happen given the floor) — split evenly.
        n = len(volatilities)
        return dict.fromkeys(volatilities, 1.0 / n)

    return {symbol: raw / total for symbol, raw in inv_vol.items()}


@dataclass
class FixedFractionalRiskResult:
    shares: int
    position_usd: float
    position_pct_capital: float
    risk_usd: float
    risk_per_share: float
    stop_price: float
    capped_by_max_position: bool
    warning: str | None


def position_size_fixed_fractional_risk(
    equity: float,
    entry_price: float,
    stop_price: float,
    risk_per_trade_pct: float = 1.0,
    max_position_pct: float = 10.0,
) -> FixedFractionalRiskResult:
    """
    Fixed-fractional RISK sizing: size a position so that a stop-out loses exactly
    `risk_per_trade_pct` of equity — NOT a fixed % of capital (that's mode="fixed").

    risk_per_share = |entry_price - stop_price|
    shares = floor((equity * risk_per_trade_pct / 100) / risk_per_share)

    A WIDER stop means MORE $ at risk per share for the same equity-at-risk budget,
    so shares must shrink accordingly (inverse relationship) — this is the whole
    point of risk-based sizing over naive fixed-fraction-of-capital sizing.

    Hard-capped by max_position_pct of equity (position_usd), same ceiling
    convention as the other sizing modes in this plugin (never a substitute for the
    kernel's own max_position_pct ceiling in trade-intent.service.ts — this is an
    additional, tighter constraint the plugin applies on top).

    Args:
        equity:            total account equity (paper or real)
        entry_price:        intended entry fill price
        stop_price:         where the position would be stopped out (any direction —
                             caller passes the correct side; only the absolute
                             distance from entry_price is used)
        risk_per_trade_pct: % of equity to risk on this ONE trade if the stop is hit
        max_position_pct:   upper limit of position notional as % of equity

    Returns:
        FixedFractionalRiskResult
    """
    risk_per_share = abs(entry_price - stop_price)

    if equity <= 0 or entry_price <= 0 or risk_per_share <= 0:
        return FixedFractionalRiskResult(
            shares=0,
            position_usd=0.0,
            position_pct_capital=0.0,
            risk_usd=0.0,
            risk_per_share=round(risk_per_share, 4),
            stop_price=round(stop_price, 4),
            capped_by_max_position=False,
            warning="Invalid inputs: equity/entry_price/risk_per_share must be positive",
        )

    risk_budget_usd = equity * (risk_per_trade_pct / 100.0)
    shares = math.floor(risk_budget_usd / risk_per_share)

    position_usd = shares * entry_price
    max_position_usd = equity * (max_position_pct / 100.0)
    capped = False
    warning = None
    if position_usd > max_position_usd:
        capped = True
        shares = math.floor(max_position_usd / entry_price)
        position_usd = shares * entry_price
        warning = (
            f"Risk-based size would exceed {max_position_pct}% of equity "
            f"— capped to {max_position_pct}%"
        )

    actual_risk_usd = shares * risk_per_share

    return FixedFractionalRiskResult(
        shares=shares,
        position_usd=round(position_usd, 2),
        position_pct_capital=round(position_usd / equity * 100, 2) if equity > 0 else 0.0,
        risk_usd=round(actual_risk_usd, 2),
        risk_per_share=round(risk_per_share, 4),
        stop_price=round(stop_price, 4),
        capped_by_max_position=capped,
        warning=warning,
    )


def _wilder_atr_local(
    highs: list[float], lows: list[float], closes: list[float], period: int = 14
) -> float:
    """
    Minimal Wilder ATR, kept local to this plugin (deliberately NOT imported from
    atr-stop-loss — plugins stay independent). Only used as a last-resort fallback
    when a signal carries raw OHLCV arrays but no pre-computed atr14/stop.
    """
    if len(highs) < period + 1:
        return 0.0

    true_ranges: list[float] = []
    for i in range(1, len(highs)):
        tr = max(
            highs[i] - lows[i],
            abs(highs[i] - closes[i - 1]),
            abs(lows[i] - closes[i - 1]),
        )
        true_ranges.append(tr)

    if len(true_ranges) < period:
        return 0.0

    atr = sum(true_ranges[:period]) / period
    for tr in true_ranges[period:]:
        atr = (atr * (period - 1) + tr) / period
    return atr


def resolve_stop_price(
    signal: dict,
    entry_price: float,
    direction: str = "long",
    stop_atr_mult: float = 2.0,
) -> tuple[float | None, str | None]:
    """
    Resolves the stop price for fixed_fractional_risk sizing, in priority order:

      1. signal['stop_price']  — explicit stop set upstream (any producer)
      2. signal['stop_loss']   — the atr-stop-loss plugin's convention (absolute price)
      3. ATR-derived: entry_price -+ stop_atr_mult * ATR, where ATR comes from
         signal['atr14'] if present (atr-stop-loss plugin output), else computed
         locally from signal['closes']/['highs']/['lows'] if those arrays are present.
      4. None — caller must skip sizing (no reliable risk denominator).

    Returns (stop_price, source) where source is 'signal' | 'atr' | None.
    """
    stop_price = signal.get("stop_price")
    if stop_price is not None and stop_price > 0:
        return float(stop_price), "signal"

    stop_loss = signal.get("stop_loss")
    if stop_loss is not None and stop_loss > 0:
        return float(stop_loss), "signal"

    atr = signal.get("atr14")
    if atr is None:
        closes = signal.get("closes")
        highs = signal.get("highs", closes)
        lows = signal.get("lows", closes)
        if closes and highs and lows:
            atr = _wilder_atr_local(highs, lows, closes)

    if atr and atr > 0 and entry_price > 0:
        if direction == "short":
            return entry_price + atr * stop_atr_mult, "atr"
        return entry_price - atr * stop_atr_mult, "atr"

    return None, None


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
    Compute position size using Kelly fraction.

    Position = capital * kelly_fraction / (stop_loss_pct / 100)
    Capped by max_position_pct.

    Args:
        capital:          total available capital
        price:            current asset price
        stop_loss_pct:    % loss if stop is hit (e.g. 2.0 = 2%)
        take_profit_pct:  % gain expected (e.g. 3.0 = 3%)
        kelly_fraction:   Kelly fraction to apply
        max_position_pct: upper limit of position as % of capital
        safety_size_pct:  fallback position size when Kelly is unreliable
        use_safety:       if True, use safety_size_pct instead of Kelly

    Returns:
        PositionResult
    """
    warning = None

    if use_safety or kelly_fraction <= 0:
        target_pct = safety_size_pct / 100.0
        warning = f"Kelly unreliable: using safety size ({safety_size_pct}%)"
    else:
        sl_frac = stop_loss_pct / 100.0
        if sl_frac <= 0:
            target_pct = safety_size_pct / 100.0
            warning = "Invalid stop loss: using safety size"
        else:
            target_pct = kelly_fraction / sl_frac
            max_pct = max_position_pct / 100.0
            if target_pct > max_pct:
                warning = (
                    f"Kelly suggests {target_pct * 100:.1f}% but capped to {max_position_pct}%"
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
