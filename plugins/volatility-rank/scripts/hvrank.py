"""
Volatility Rank — cálculo de HV Percentile (proxy de IV Rank).

IV Rank real requiere datos de opciones (caros/difíciles de obtener).
HV Percentile es el proxy estándar que usan traders minoristas:
- HV alta históricamente → probablemente IV alta → premium selling favorecido
- HV baja históricamente → probablemente IV baja → premium buying favorecido

Referencias:
- Sinclair (2008), "Volatility Trading"
- Natenberg (1994), "Option Volatility and Pricing"
- TaskerBlue, "The Wheel Strategy" (popular retail options strategy)
"""

import math
from dataclasses import dataclass


@dataclass
class HvResult:
    symbol: str
    current_hv: float  # HV actual (anualizada, como %)
    hv_percentile: float  # percentil del HV actual vs historia (0-100)
    hv_1y_high: float  # HV más alta en el último año
    hv_1y_low: float  # HV más baja en el último año
    hv_1y_mean: float  # HV media en el último año
    vol_regime: str  # "high" | "normal" | "low"
    signal: str  # "sell_premium" | "buy_premium" | "neutral"
    confidence: float  # 0.0 - 1.0


def compute_log_returns(closes: list[float]) -> list[float]:
    """Calcula retornos logarítmicos diarios."""
    if len(closes) < 2:
        return []
    return [math.log(closes[i] / closes[i - 1]) for i in range(1, len(closes))]


def compute_hv(returns: list[float], window: int) -> float | None:
    """
    Calcula Historical Volatility anualizada (%) usando ventana móvil.
    Fórmula estándar: desviación estándar de retornos diarios × √252 × 100
    """
    if len(returns) < window:
        return None

    window_returns = returns[-window:]
    n = len(window_returns)
    mean = sum(window_returns) / n
    variance = sum((r - mean) ** 2 for r in window_returns) / (n - 1)
    hv_daily = math.sqrt(variance)
    hv_annual = hv_daily * math.sqrt(252) * 100  # anualizada como %

    return round(hv_annual, 2)


def compute_hv_series(returns: list[float], window: int) -> list[float]:
    """
    Calcula HV para cada punto de tiempo (serie completa).
    Necesario para calcular el percentil histórico.
    """
    series = []
    for i in range(window, len(returns) + 1):
        window_r = returns[i - window : i]
        n = len(window_r)
        if n < 2:
            continue
        mean = sum(window_r) / n
        variance = sum((r - mean) ** 2 for r in window_r) / (n - 1)
        hv = math.sqrt(variance) * math.sqrt(252) * 100
        series.append(round(hv, 2))
    return series


def percentile_rank(value: float, series: list[float]) -> float:
    """
    Percentil del valor actual en la serie histórica.
    Retorna 0-100: 80 significa que el valor actual es mayor al 80% de los históricos.
    """
    if not series:
        return 50.0
    below = sum(1 for v in series if v < value)
    return round(below / len(series) * 100, 1)


def analyze_volatility_rank(
    symbol: str,
    closes: list[float],
    cfg: dict,
) -> HvResult | None:
    """
    Calcula el rango de volatilidad histórica para un símbolo.

    closes: lista de precios de cierre, ordenados ascendente (más antiguo primero)
    """
    lookback = cfg.get("lookback_days", 252)
    hv_window = cfg.get("hv_window", 21)
    high_pct = cfg.get("high_vol_pct", 80)
    low_pct = cfg.get("low_vol_pct", 20)

    min_required = hv_window + lookback
    # Usar lo que tengamos si hay suficiente para algo
    if len(closes) < min_required and len(closes) < hv_window + 5:
        return None

    returns = compute_log_returns(closes)
    if not returns:
        return None

    # HV actual
    current_hv = compute_hv(returns, hv_window)
    if current_hv is None:
        return None

    # Serie de HV histórica (para calcular percentil)
    history_returns = returns[-lookback - hv_window :]
    hv_series = compute_hv_series(history_returns, hv_window)

    if not hv_series:
        return None

    hv_percentile = percentile_rank(current_hv, hv_series)
    hv_high = max(hv_series)
    hv_low = min(hv_series)
    hv_mean = round(sum(hv_series) / len(hv_series), 2)

    # Régimen y señal
    if hv_percentile >= high_pct:
        vol_regime = "high"
        signal = "sell_premium"
    elif hv_percentile <= low_pct:
        vol_regime = "low"
        signal = "buy_premium"
    else:
        vol_regime = "normal"
        signal = "neutral"

    # Confianza: mayor cuando el percentil es más extremo
    if vol_regime == "high":
        confidence = min((hv_percentile - high_pct) / (100 - high_pct) + 0.5, 0.90)
    elif vol_regime == "low":
        confidence = min((low_pct - hv_percentile) / low_pct + 0.5, 0.90)
    else:
        confidence = 0.20

    return HvResult(
        symbol=symbol,
        current_hv=current_hv,
        hv_percentile=hv_percentile,
        hv_1y_high=hv_high,
        hv_1y_low=hv_low,
        hv_1y_mean=hv_mean,
        vol_regime=vol_regime,
        signal=signal,
        confidence=round(confidence, 3),
    )
