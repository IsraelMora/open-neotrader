"""Ichimoku Kinko Hyo (Goichi Hosoda, 1969) — sistema de tendencia completo."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class IchimokuResult:
    symbol: str
    tenkan: float  # Conversion line
    kijun: float  # Base line
    senkou_a: float  # Span A (nube futura)
    senkou_b: float  # Span B (nube futura)
    chikou: float  # Lagging span (precio actual desplazado atrás)
    cloud_top: float
    cloud_bottom: float
    price: float
    above_cloud: bool
    below_cloud: bool
    tenkan_kijun_cross: str | None  # "bullish_tk" | "bearish_tk" | None
    chikou_confirmed: bool
    cloud_color: str  # "bullish" (A>B) | "bearish" (B>A)
    action: str  # "long" | "short" | "hold"
    signal_strength: float
    reason: str


def _midpoint(highs: list[float], lows: list[float], period: int) -> list[float]:
    """(max_high + min_low) / 2 sobre rolling window."""
    result = []
    for i in range(period - 1, len(highs)):
        h = max(highs[i - period + 1 : i + 1])
        lo = min(lows[i - period + 1 : i + 1])
        result.append((h + lo) / 2.0)
    return result


def compute_ichimoku(
    highs: list[float],
    lows: list[float],
    closes: list[float],
    tenkan_period: int = 9,
    kijun_period: int = 26,
    senkou_b_period: int = 52,
) -> dict | None:
    """Calcula todos los componentes Ichimoku."""
    min_bars = senkou_b_period + kijun_period
    if len(closes) < min_bars:
        return None

    tenkan = _midpoint(highs, lows, tenkan_period)
    kijun = _midpoint(highs, lows, kijun_period)

    # Senkou A = (tenkan + kijun) / 2 — desplazado kijun_period barras al futuro
    # Usamos el valor actual (no desplazado) para comparar con precio actual
    min_len = min(len(tenkan), len(kijun))
    senkou_a_series = [
        (t + k) / 2.0 for t, k in zip(tenkan[-min_len:], kijun[-min_len:], strict=False)
    ]

    senkou_b = _midpoint(highs, lows, senkou_b_period)

    # Chikou = precio actual colocado kijun_period barras atrás
    chikou_value = closes[-1]
    chikou_compare_price = closes[-kijun_period - 1] if len(closes) > kijun_period else closes[0]

    return {
        "tenkan": tenkan[-1] if tenkan else None,
        "kijun": kijun[-1] if kijun else None,
        "senkou_a": senkou_a_series[-1] if senkou_a_series else None,
        "senkou_b": senkou_b[-1] if senkou_b else None,
        "chikou": chikou_value,
        "chikou_compare_price": chikou_compare_price,
        "tenkan_prev": tenkan[-2] if len(tenkan) >= 2 else None,
        "kijun_prev": kijun[-2] if len(kijun) >= 2 else None,
    }


def analyze_ichimoku(
    symbol: str,
    highs: list[float],
    lows: list[float],
    closes: list[float],
    tenkan_period: int = 9,
    kijun_period: int = 26,
    senkou_b_period: int = 52,
    require_cloud_confirmation: bool = True,
    require_chikou_confirmation: bool = True,
) -> IchimokuResult | None:
    data = compute_ichimoku(highs, lows, closes, tenkan_period, kijun_period, senkou_b_period)
    if not data or any(
        v is None for v in [data["tenkan"], data["kijun"], data["senkou_a"], data["senkou_b"]]
    ):
        return None

    price = closes[-1]
    tenkan = data["tenkan"]
    kijun = data["kijun"]
    senkou_a = data["senkou_a"]
    senkou_b = data["senkou_b"]
    chikou = data["chikou"]
    chikou_ref = data["chikou_compare_price"]

    cloud_top = max(senkou_a, senkou_b)
    cloud_bottom = min(senkou_a, senkou_b)
    above_cloud = price > cloud_top
    below_cloud = price < cloud_bottom
    cloud_color = "bullish" if senkou_a > senkou_b else "bearish"

    # Cruce Tenkan/Kijun
    tk_cross: str | None = None
    if data["tenkan_prev"] and data["kijun_prev"]:
        prev_diff = data["tenkan_prev"] - data["kijun_prev"]
        curr_diff = tenkan - kijun
        if prev_diff < 0 and curr_diff >= 0:
            tk_cross = "bullish_tk"
        elif prev_diff > 0 and curr_diff <= 0:
            tk_cross = "bearish_tk"

    # Chikou confirma si está por encima/debajo del precio hace kijun barras
    chikou_bullish = chikou > chikou_ref
    chikou_bearish = chikou < chikou_ref

    # Señal alcista: precio sobre nube + tenkan > kijun + chikou confirma
    signals_bull = 0
    signals_bear = 0
    reasons: list[str] = []

    if above_cloud:
        signals_bull += 2
        reasons.append("precio sobre nube")
    elif below_cloud:
        signals_bear += 2
        reasons.append("precio bajo nube")

    if tenkan > kijun:
        signals_bull += 1
        reasons.append("tenkan > kijun")
    elif tenkan < kijun:
        signals_bear += 1
        reasons.append("tenkan < kijun")

    if tk_cross == "bullish_tk":
        signals_bull += 1
        reasons.append("cruce TK alcista")
    elif tk_cross == "bearish_tk":
        signals_bear += 1
        reasons.append("cruce TK bajista")

    chikou_confirmed = (signals_bull > signals_bear and chikou_bullish) or (
        signals_bear > signals_bull and chikou_bearish
    )

    if chikou_bullish:
        signals_bull += 1
        reasons.append("chikou confirma alcista")
    elif chikou_bearish:
        signals_bear += 1
        reasons.append("chikou confirma bajista")

    if cloud_color == "bullish":
        signals_bull += 0.5
    else:
        signals_bear += 0.5

    # Determinar acción
    action = "hold"
    total = signals_bull + signals_bear
    strength = 0.0 if total == 0 else max(signals_bull, signals_bear) / (total + 1)

    if signals_bull > signals_bear:
        cloud_ok = above_cloud if require_cloud_confirmation else True
        chikou_ok = chikou_bullish if require_chikou_confirmation else True
        if cloud_ok and chikou_ok:
            action = "long"
    elif signals_bear > signals_bull:
        cloud_ok = below_cloud if require_cloud_confirmation else True
        chikou_ok = chikou_bearish if require_chikou_confirmation else True
        if cloud_ok and chikou_ok:
            action = "short"

    reason = (
        f"{symbol}: {'; '.join(reasons)} | T={tenkan:.2f} K={kijun:.2f}"
        f" nube=[{cloud_bottom:.2f}-{cloud_top:.2f}]"
    )

    return IchimokuResult(
        symbol=symbol,
        tenkan=tenkan,
        kijun=kijun,
        senkou_a=senkou_a,
        senkou_b=senkou_b,
        chikou=chikou,
        cloud_top=cloud_top,
        cloud_bottom=cloud_bottom,
        price=price,
        above_cloud=above_cloud,
        below_cloud=below_cloud,
        tenkan_kijun_cross=tk_cross,
        chikou_confirmed=chikou_confirmed,
        cloud_color=cloud_color,
        action=action,
        signal_strength=strength,
        reason=reason,
    )
