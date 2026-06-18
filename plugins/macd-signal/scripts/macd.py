"""MACD — Moving Average Convergence Divergence (Gerald Appel, 1979)."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class MacdResult:
    symbol: str
    macd_line: list[float]
    signal_line: list[float]
    histogram: list[float]
    crossover: str | None  # "bullish" | "bearish" | None
    divergence: str | None  # "bullish" | "bearish" | None
    last_histogram: float
    signal_strength: float  # 0.0 – 1.0
    action: str  # "long" | "short" | "hold" | "exit_long" | "exit_short"
    reason: str


def _ema(values: list[float], period: int) -> list[float]:
    if len(values) < period:
        return []
    k = 2.0 / (period + 1)
    result: list[float] = []
    sma = sum(values[:period]) / period
    result.append(sma)
    for v in values[period:]:
        result.append(v * k + result[-1] * (1 - k))
    return result


def compute_macd(
    closes: list[float],
    fast: int = 12,
    slow: int = 26,
    signal_period: int = 9,
) -> tuple[list[float], list[float], list[float]]:
    """Returns (macd_line, signal_line, histogram) — aligned to slow EMA length."""
    if len(closes) < slow + signal_period:
        return [], [], []

    fast_ema = _ema(closes, fast)
    slow_ema = _ema(closes, slow)

    # Align: fast_ema starts at index fast-1, slow_ema at slow-1
    offset = slow - fast  # how many fast values to skip
    macd_line = [f - s for f, s in zip(fast_ema[offset:], slow_ema, strict=False)]

    signal_line = _ema(macd_line, signal_period)
    offset2 = signal_period - 1
    macd_aligned = macd_line[offset2:]
    histogram = [m - s for m, s in zip(macd_aligned, signal_line, strict=False)]

    return macd_aligned, signal_line, histogram


def detect_crossover(macd: list[float], signal: list[float]) -> str | None:
    """Detecta cruce en las últimas 2 barras."""
    if len(macd) < 2 or len(signal) < 2:
        return None
    prev_diff = macd[-2] - signal[-2]
    curr_diff = macd[-1] - signal[-1]
    if prev_diff < 0 and curr_diff >= 0:
        return "bullish"
    if prev_diff > 0 and curr_diff <= 0:
        return "bearish"
    return None


def detect_divergence(
    closes: list[float], histogram: list[float], window: int = 14
) -> str | None:
    """
    Divergencia: precio hace nuevos máximos/mínimos pero el histograma no.
    Bullish divergence: precio nuevo mínimo, histograma mínimo menos negativo.
    Bearish divergence: precio nuevo máximo, histograma máximo menos positivo.
    """
    if len(closes) < window or len(histogram) < window:
        return None

    price_w = closes[-window:]
    hist_w = histogram[-window:]

    price_min_idx = price_w.index(min(price_w))
    price_max_idx = price_w.index(max(price_w))

    # Bullish: precio en nuevo mínimo (reciente vs anterior en ventana)
    if price_min_idx == len(price_w) - 1:
        mid = window // 2
        prev_min_hist = min(hist_w[:mid])
        curr_min_hist = min(hist_w[mid:])
        if curr_min_hist > prev_min_hist:
            return "bullish"

    # Bearish: precio en nuevo máximo
    if price_max_idx == len(price_w) - 1:
        mid = window // 2
        prev_max_hist = max(hist_w[:mid])
        curr_max_hist = max(hist_w[mid:])
        if curr_max_hist < prev_max_hist:
            return "bearish"

    return None


def analyze_macd(
    symbol: str,
    closes: list[float],
    fast: int = 12,
    slow: int = 26,
    signal_period: int = 9,
    require_crossover: bool = True,
    divergence_bars: int = 14,
    min_histogram: float = 0.0,
) -> MacdResult | None:
    if len(closes) < slow + signal_period + 2:
        return None

    macd_line, signal_line, histogram = compute_macd(closes, fast, slow, signal_period)
    if not histogram:
        return None

    crossover = detect_crossover(macd_line, signal_line)
    divergence = detect_divergence(closes, histogram, divergence_bars)

    last_hist = histogram[-1]
    last_macd = macd_line[-1]
    last_signal = signal_line[-1]

    # Fuerza de la señal — basada en tamaño del histograma relativo al precio
    price_ref = closes[-1] if closes[-1] != 0 else 1
    strength = min(1.0, abs(last_hist) / (price_ref * 0.01))

    # Lógica de acción
    action = "hold"
    reason_parts: list[str] = []

    if require_crossover and crossover:
        if crossover == "bullish" and abs(last_hist) >= min_histogram:
            action = "long"
            reason_parts.append("cruce alcista MACD/señal")
        elif crossover == "bearish" and abs(last_hist) >= min_histogram:
            action = "short"
            reason_parts.append("cruce bajista MACD/señal")
    elif not require_crossover:
        if last_macd > last_signal and abs(last_hist) >= min_histogram:
            action = "long"
            reason_parts.append("MACD sobre señal")
        elif last_macd < last_signal and abs(last_hist) >= min_histogram:
            action = "short"
            reason_parts.append("MACD bajo señal")

    # Divergencia refuerza o cambia la señal
    if divergence == "bullish" and action in ("hold", "short"):
        action = "long"
        reason_parts.append("divergencia alcista precio/histograma")
    elif divergence == "bearish" and action in ("hold", "long"):
        action = "short"
        reason_parts.append("divergencia bajista precio/histograma")

    reason = (
        f"{symbol}: {'; '.join(reason_parts) if reason_parts else 'sin señal'}"
        f" | hist={last_hist:.4f} macd={last_macd:.4f} signal={last_signal:.4f}"
    )

    return MacdResult(
        symbol=symbol,
        macd_line=macd_line,
        signal_line=signal_line,
        histogram=histogram,
        crossover=crossover,
        divergence=divergence,
        last_histogram=last_hist,
        signal_strength=strength,
        action=action,
        reason=reason,
    )
