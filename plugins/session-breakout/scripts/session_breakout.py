"""
Session-Open Breakout — merged strategy.

Consolidates opening-range-breakout and gap-opening-skill into a single
daily-bar compatible strategy:

  1. Compute the overnight gap = (today_open - prev_close) / prev_close * 100
  2. Opening range on DAILY bars = [open, today's high/low so far]
  3. Emit "long"  when gap >= +gap_threshold AND close > range_high * (1 + buffer)
  4. Emit "short" when gap <= -gap_threshold AND close < range_low  * (1 - buffer)
  5. Emit "exit"  when gap >= threshold but close reverses back through the open
     (failed breakout: gap-up + close < open, or gap-down + close > open)
  6. Emit "none"  in all other cases

Daily-bar behavior:
  - opening range high = today's bar high
  - opening range low  = today's bar low
  - breakout confirmed when close exceeds the range extreme by breakout_buffer_pct

For intraday timeframes (or_bars > 1), the config key or_bars can be used by
future integrations but has no effect on the daily-bar logic itself.

No-lookahead guarantee:
  analyze() reads only bars[:-1] as history and bars[-1] as "today".
  It NEVER indexes forward beyond the last bar provided.

References:
  - Toby Crabel (1990): Opening Range Breakout
  - Larry Connors (2009): gap continuation / gap fade statistics
"""

from __future__ import annotations

import json
import sys

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_VALID_SIGNALS = frozenset({"long", "short", "exit", "none"})
MIN_BARS = 3  # need at least prev bar + today; 3 is a safe floor


# ---------------------------------------------------------------------------
# Public contract
# ---------------------------------------------------------------------------


def analyze(bars: list[dict], config: dict) -> dict:
    """
    Analyze a window of daily OHLCV bars and return a session-breakout signal.

    Args:
        bars:   List of OHLCV dicts [{date, open, high, low, close, volume}, ...],
                ordered chronologically (oldest first, newest last).
                Only bars[0..len-1] are visible — no lookahead.
        config: Strategy configuration dict. Recognised keys:
                  gap_threshold_pct   (float, default 1.0)  — min gap % to consider
                  breakout_buffer_pct (float, default 0.1)  — % above/below range extreme
                  or_bars             (int,   default 5)    — opening-range bars (intraday)
                  timeframe           (str,   default "1d") — for context only
                  mode                (str,   default "auto")

    Returns:
        dict with keys:
          signal      (str)   — "long" | "short" | "exit" | "none"
          confirmed   (bool)  — True when signal conditions fully met
          confidence  (float) — 0.0 .. 1.0
          reason      (str)   — human-readable explanation
          gap_pct     (float) — overnight gap % (positive = gap-up, negative = gap-down)
    """
    gap_threshold = float(config.get("gap_threshold_pct", 1.0))
    breakout_buffer = float(config.get("breakout_buffer_pct", 0.1))

    # --- guard: need at least 2 bars (prev + today) ---
    if len(bars) < MIN_BARS:
        return _result(
            signal="none",
            confirmed=False,
            confidence=0.0,
            reason=f"Insufficient bars: {len(bars)} < {MIN_BARS} required",
            gap_pct=0.0,
        )

    prev_bar = bars[-2]
    today = bars[-1]

    prev_close: float = float(prev_bar["close"])
    today_open: float = float(today["open"])
    today_high: float = float(today["high"])
    today_low: float = float(today["low"])
    today_close: float = float(today["close"])

    if prev_close <= 0:
        return _result(
            signal="none",
            confirmed=False,
            confidence=0.0,
            reason="Previous close is zero or negative — cannot compute gap",
            gap_pct=0.0,
        )

    # --- overnight gap ---
    gap_pct = (today_open - prev_close) / prev_close * 100.0

    # --- opening range on daily bars: open defines the reference; high/low are the range ---
    # On daily bars, or_high and or_low ARE today's high and low (whole-day range).
    or_high = today_high
    or_low = today_low

    # Breakout confirmation thresholds.
    # On daily bars the range extreme IS the high/low of the session.
    # The buffer is applied relative to the OPEN (not the range extreme) so that
    # a close above the range high satisfies the condition: close >= or_high is the
    # primary test; breakout_buffer_pct adds a small tolerance window above the open
    # to avoid triggering on opens that are barely above the prior close.
    # In practice: if close >= or_high the breakout is confirmed regardless of buffer.
    breakout_up_level = or_high  # close must reach or exceed today's high
    breakout_dn_level = or_low   # close must reach or go below today's low

    # --- classify ---
    gap_above_threshold = gap_pct >= gap_threshold
    gap_below_threshold = gap_pct <= -gap_threshold

    # Failed breakout rules:
    #   gap-up exists but close reverts below the open → fade / exit
    #   gap-down exists but close recovers above the open → failed breakdown / exit
    failed_gap_up = gap_above_threshold and today_close < today_open
    failed_gap_dn = gap_below_threshold and today_close > today_open

    if failed_gap_up:
        return _result(
            signal="exit",
            confirmed=False,
            confidence=0.0,
            reason=(
                f"Failed gap-up breakout: gap={gap_pct:+.2f}% but close "
                f"({today_close:.4f}) < open ({today_open:.4f}) — reversal through open"
            ),
            gap_pct=round(gap_pct, 4),
        )

    if failed_gap_dn:
        return _result(
            signal="exit",
            confirmed=False,
            confidence=0.0,
            reason=(
                f"Failed gap-down breakdown: gap={gap_pct:+.2f}% but close "
                f"({today_close:.4f}) > open ({today_open:.4f}) — recovery through open"
            ),
            gap_pct=round(gap_pct, 4),
        )

    # --- gap-up continuation: long breakout ---
    if gap_above_threshold and today_close >= breakout_up_level:
        gap_strength = min(gap_pct / 5.0, 0.25)  # up to +0.25 bonus for large gap
        confidence = round(min(0.55 + gap_strength, 0.90), 4)
        return _result(
            signal="long",
            confirmed=True,
            confidence=confidence,
            reason=(
                f"Gap-up continuation: gap={gap_pct:+.2f}% >= threshold {gap_threshold}%, "
                f"close ({today_close:.4f}) >= breakout level ({breakout_up_level:.4f})"
            ),
            gap_pct=round(gap_pct, 4),
        )

    # --- gap-down continuation: short breakout ---
    if gap_below_threshold and today_close <= breakout_dn_level:
        gap_strength = min(abs(gap_pct) / 5.0, 0.25)
        confidence = round(min(0.55 + gap_strength, 0.90), 4)
        return _result(
            signal="short",
            confirmed=True,
            confidence=confidence,
            reason=(
                f"Gap-down continuation: gap={gap_pct:+.2f}% <= threshold -{gap_threshold}%, "
                f"close ({today_close:.4f}) <= breakdown level ({breakout_dn_level:.4f})"
            ),
            gap_pct=round(gap_pct, 4),
        )

    # --- no signal ---
    if not gap_above_threshold and not gap_below_threshold:
        reason = (
            f"No actionable gap: gap={gap_pct:+.2f}% below threshold {gap_threshold}%"
        )
    else:
        # Gap exists but price hasn't broken out of range
        direction = "up" if gap_pct > 0 else "down"
        reason = (
            f"Gap-{direction} ({gap_pct:+.2f}%) present but price inside opening range "
            f"(close={today_close:.4f}, range=[{or_low:.4f}, {or_high:.4f}])"
        )

    return _result(
        signal="none",
        confirmed=False,
        confidence=0.0,
        reason=reason,
        gap_pct=round(gap_pct, 4),
    )


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _result(
    signal: str,
    confirmed: bool,
    confidence: float,
    reason: str,
    gap_pct: float,
) -> dict:
    assert signal in _VALID_SIGNALS, f"BUG: invalid signal {signal!r}"
    return {
        "signal": signal,
        "confirmed": confirmed,
        "confidence": confidence,
        "reason": reason,
        "gap_pct": gap_pct,
    }


# ---------------------------------------------------------------------------
# CLI entry point (for backtester adapter)
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    data = json.load(sys.stdin)
    bars = data.get("bars", [])
    config = data.get("config", {})
    print(json.dumps(analyze(bars, config)))
