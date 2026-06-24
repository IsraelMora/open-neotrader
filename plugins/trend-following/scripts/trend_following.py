"""
Trend Following — multi-confirmation merged strategy.

Combines three independent trend indicators:
  1. EMA crossover (fast/slow)   — momentum direction
  2. MACD (line vs signal)       — momentum confirmation
  3. Ichimoku (price vs cloud + tenkan/kijun) — structural trend

Votes from each indicator are counted. When bullish votes >= min_consensus
the signal is "long". When bearish votes >= min_consensus the signal is
"short" (or "exit" — same semantics: close long, open short intent).
If neither threshold is met, signal is "none".

analyze() contract (MANDATORY — do not change signature):
    def analyze(bars: list[dict], config: dict) -> dict

bars: list of OHLCV dicts, already sliced to the window of interest.
      [{date, open, high, low, close, volume}, ...], index 0 = oldest.
      NEVER indexes beyond len(bars) — strict no-lookahead guarantee.

Returns:
    {
        "signal":     "long" | "short" | "exit" | "none",
        "confirmed":  bool,
        "confidence": float 0.0..1.0,   # agreement_count / 3
        "reason":     str,
        # extra diagnostic fields (non-breaking additions):
        "ema_vote":      "bull" | "bear" | "neutral",
        "macd_vote":     "bull" | "bear" | "neutral",
        "ichimoku_vote": "bull" | "bear" | "neutral",
        "bull_votes":    int,
        "bear_votes":    int,
    }
"""

from __future__ import annotations


# ---------------------------------------------------------------------------
# EMA helper
# ---------------------------------------------------------------------------

def _ema(prices: list[float], period: int) -> list[float]:
    """Exponential moving average; returns series aligned to first output at prices[period-1]."""
    if len(prices) < period:
        return []
    k = 2.0 / (period + 1)
    result: list[float] = []
    sma = sum(prices[:period]) / period
    result.append(sma)
    for v in prices[period:]:
        result.append(v * k + result[-1] * (1 - k))
    return result


# ---------------------------------------------------------------------------
# Indicator vote functions — each returns "bull" | "bear" | "neutral"
# ---------------------------------------------------------------------------

def _ema_crossover_vote(
    closes: list[float], fast: int, slow: int
) -> str:
    """
    EMA crossover direction vote.
    Bull when fast EMA > slow EMA (price momentum up).
    Bear when fast EMA < slow EMA.
    """
    fast_series = _ema(closes, fast)
    slow_series = _ema(closes, slow)
    if not fast_series or not slow_series:
        return "neutral"

    # Align: fast_series has more entries than slow_series by (slow - fast) bars.
    # Take the last value of each.
    ef = fast_series[-1]
    es = slow_series[-1]

    if ef > es:
        return "bull"
    if ef < es:
        return "bear"
    return "neutral"


def _macd_vote(
    closes: list[float], fast: int, slow: int, signal_period: int
) -> str:
    """
    MACD direction vote.
    Bull when MACD line > signal line.
    Bear when MACD line < signal line.

    Ported from the original strategy implementation compute_macd().
    """
    if len(closes) < slow + signal_period:
        return "neutral"

    fast_ema = _ema(closes, fast)
    slow_ema = _ema(closes, slow)

    if not fast_ema or not slow_ema:
        return "neutral"

    # Align: fast_ema is longer by (slow - fast).
    offset = slow - fast
    macd_line = [f - s for f, s in zip(fast_ema[offset:], slow_ema)]

    signal_line = _ema(macd_line, signal_period)
    if not signal_line:
        return "neutral"

    macd_val = macd_line[-1]
    signal_val = signal_line[-1]

    if macd_val > signal_val:
        return "bull"
    if macd_val < signal_val:
        return "bear"
    return "neutral"


def _midpoint_series(highs: list[float], lows: list[float], period: int) -> list[float]:
    """(highest_high + lowest_low) / 2 over a rolling window — Ichimoku midpoint."""
    result = []
    for i in range(period - 1, len(highs)):
        h = max(highs[i - period + 1: i + 1])
        lo = min(lows[i - period + 1: i + 1])
        result.append((h + lo) / 2.0)
    return result


def _ichimoku_vote(
    highs: list[float],
    lows: list[float],
    closes: list[float],
    tenkan: int,
    kijun: int,
    senkou_b: int,
) -> str:
    """
    Ichimoku structural trend vote.

    Bull when:
      - price > cloud top (Senkou A and B)  — primary filter
      - tenkan > kijun                       — secondary confirmation

    Bear when:
      - price < cloud bottom
      - tenkan < kijun

    The cloud is computed at the current bar (no displacement) using available
    data — we do NOT project into the future to avoid lookahead.

    Ported from the original strategy implementation
    """
    min_bars = senkou_b + kijun
    if len(closes) < min_bars:
        return "neutral"

    tenkan_series = _midpoint_series(highs, lows, tenkan)
    kijun_series = _midpoint_series(highs, lows, kijun)
    senkou_b_series = _midpoint_series(highs, lows, senkou_b)

    if not tenkan_series or not kijun_series or not senkou_b_series:
        return "neutral"

    min_len = min(len(tenkan_series), len(kijun_series))
    senkou_a_series = [
        (t + k) / 2.0
        for t, k in zip(tenkan_series[-min_len:], kijun_series[-min_len:])
    ]

    if not senkou_a_series:
        return "neutral"

    senkou_a = senkou_a_series[-1]
    senkou_b_val = senkou_b_series[-1]
    tenkan_val = tenkan_series[-1]
    kijun_val = kijun_series[-1]
    price = closes[-1]

    cloud_top = max(senkou_a, senkou_b_val)
    cloud_bottom = min(senkou_a, senkou_b_val)

    above_cloud = price > cloud_top
    below_cloud = price < cloud_bottom
    tk_bull = tenkan_val > kijun_val
    tk_bear = tenkan_val < kijun_val

    if above_cloud and tk_bull:
        return "bull"
    if below_cloud and tk_bear:
        return "bear"
    # Partial confirmation: price position only
    if above_cloud:
        return "bull"
    if below_cloud:
        return "bear"
    return "neutral"


# ---------------------------------------------------------------------------
# Main analyze() — the backtester-facing contract
# ---------------------------------------------------------------------------

def analyze(bars: list[dict], config: dict) -> dict:
    """
    Multi-confirmation trend strategy.

    Parameters
    ----------
    bars : list[dict]
        OHLCV window, already sliced. Each dict has keys:
        date, open, high, low, close, volume.
        Oldest bar at index 0. NEVER indexes beyond len(bars).
    config : dict
        Plugin configuration. Supported keys (with defaults):
            fast_period  : int   = 9
            slow_period  : int   = 21
            min_consensus: int   = 2
            macd_fast    : int   = 12
            macd_slow    : int   = 26
            macd_signal  : int   = 9
            tenkan       : int   = 9
            kijun        : int   = 26
            senkou_b     : int   = 52

    Returns
    -------
    dict with keys:
        signal      : "long" | "short" | "exit" | "none"
        confirmed   : bool
        confidence  : float  (agreement_count / 3)
        reason      : str
        ema_vote    : "bull" | "bear" | "neutral"
        macd_vote   : "bull" | "bear" | "neutral"
        ichimoku_vote: "bull" | "bear" | "neutral"
        bull_votes  : int
        bear_votes  : int
    """
    # --- config ---
    fast_period = int(config.get("fast_period", 9))
    slow_period = int(config.get("slow_period", 21))
    min_consensus = int(config.get("min_consensus", 2))
    macd_fast = int(config.get("macd_fast", 12))
    macd_slow = int(config.get("macd_slow", 26))
    macd_signal = int(config.get("macd_signal", 9))
    tenkan = int(config.get("tenkan", 9))
    kijun = int(config.get("kijun", 26))
    senkou_b = int(config.get("senkou_b", 52))

    # Minimum bars needed: Ichimoku dominates (senkou_b + kijun)
    min_bars = senkou_b + kijun

    _empty = {
        "signal": "none",
        "confirmed": False,
        "confidence": 0.0,
        "reason": "insufficient bars",
        "ema_vote": "neutral",
        "macd_vote": "neutral",
        "ichimoku_vote": "neutral",
        "bull_votes": 0,
        "bear_votes": 0,
    }

    if len(bars) < min_bars:
        return _empty

    # Extract OHLCV series — never index beyond len(bars)
    closes = [b["close"] for b in bars]
    highs = [b.get("high", b["close"]) for b in bars]
    lows = [b.get("low", b["close"]) for b in bars]

    # --- compute votes ---
    ema_vote = _ema_crossover_vote(closes, fast_period, slow_period)
    macd_vote = _macd_vote(closes, macd_fast, macd_slow, macd_signal)
    ichimoku_vote = _ichimoku_vote(highs, lows, closes, tenkan, kijun, senkou_b)

    votes = [ema_vote, macd_vote, ichimoku_vote]
    bull_votes = sum(1 for v in votes if v == "bull")
    bear_votes = sum(1 for v in votes if v == "bear")

    # --- consensus decision ---
    total_indicators = 3
    if bull_votes >= min_consensus:
        signal = "long"
        agreement = bull_votes
        confirmed = bull_votes == total_indicators
    elif bear_votes >= min_consensus:
        # "exit" and "short" are equivalent here: exit longs / go short.
        # We emit "short" as the primary bearish signal.
        # Callers that only want long-exits should treat "short" as exit.
        signal = "short"
        agreement = bear_votes
        confirmed = bear_votes == total_indicators
    else:
        signal = "none"
        agreement = max(bull_votes, bear_votes)
        confirmed = False

    confidence = float(agreement) / float(total_indicators)

    reason_parts = [
        f"EMA={ema_vote}",
        f"MACD={macd_vote}",
        f"Ichimoku={ichimoku_vote}",
        f"bull={bull_votes}/bear={bear_votes}",
        f"consensus={min_consensus}",
    ]
    reason = " | ".join(reason_parts)

    return {
        "signal": signal,
        "confirmed": confirmed,
        "confidence": confidence,
        "reason": reason,
        "ema_vote": ema_vote,
        "macd_vote": macd_vote,
        "ichimoku_vote": ichimoku_vote,
        "bull_votes": bull_votes,
        "bear_votes": bear_votes,
    }
