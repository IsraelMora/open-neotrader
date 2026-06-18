"""
Mean Reversion Z-Score — implementación de referencia.

Base académica:
- Jegadeesh (1990): "Evidence of Predictable Behavior of Security Returns"
  Retornos negativos autocorrelacionados a 1 mes → reversión a la media.
- Lo & MacKinlay (1988): Varianza ratio test del random walk.
  Muchos activos NO siguen random walk → existe reversión explotable.

Z-Score = (precio_actual - media_N_días) / desviación_estándar_N_días
  |Z| > 2 → precio a 2σ de la media → sobreextendido → reversión probable
"""

from __future__ import annotations

import json
import math
import sys
from dataclasses import asdict, dataclass


@dataclass
class ZScoreResult:
    symbol: str
    z_score: float  # valor actual del Z-Score
    price: float  # precio actual
    mean: float  # media del período
    std: float  # desviación estándar
    upper_band: float  # media + entry_zscore * std
    lower_band: float  # media - entry_zscore * std
    signal: str  # "long" | "short" | "exit_long" | "exit_short" | "neutral"
    confidence: float  # 0-1 basado en qué tan extremo es el Z-Score
    lookback: int  # días usados
    zscore_pct: float  # percentil histórico del Z-Score


def compute_mean_std(prices: list[float]) -> tuple[float, float]:
    n = len(prices)
    if n < 2:
        return 0.0, 0.0
    mean = sum(prices) / n
    variance = sum((p - mean) ** 2 for p in prices) / (n - 1)
    return mean, math.sqrt(variance)


def compute_zscore_series(prices: list[float], lookback: int) -> list[float]:
    """Z-Score rolling para cada punto."""
    result = []
    for i in range(len(prices)):
        window = prices[max(0, i - lookback + 1) : i + 1]
        if len(window) < 5:
            result.append(0.0)
            continue
        mean, std = compute_mean_std(window)
        result.append((prices[i] - mean) / std if std > 0 else 0.0)
    return result


def _zscore_percentile(zscore: float, historical_zscores: list[float]) -> float:
    """Percentil histórico del Z-Score (cuán extremo es comparado con el pasado)."""
    if not historical_zscores:
        return 0.5
    abs_z = abs(zscore)
    below = sum(1 for z in historical_zscores if abs(z) <= abs_z)
    return round(below / len(historical_zscores), 3)


def analyze(
    symbol: str,
    prices: list[float],
    lookback: int = 20,
    entry_zscore: float = 2.0,
    exit_zscore: float = 0.5,
    current_signal: str | None = None,  # señal activa si hay posición abierta
) -> ZScoreResult:
    """
    Analiza si el precio está estadísticamente alejado de su media.

    Args:
        prices:         serie de precios cierre (más antiguo primero)
        lookback:       días para calcular media/std
        entry_zscore:   umbral para generar señal de entrada
        exit_zscore:    umbral para señal de salida
        current_signal: "long" | "short" | None (posición actual)

    Returns:
        ZScoreResult con señal y métricas
    """
    if len(prices) < lookback + 5:
        return ZScoreResult(
            symbol=symbol,
            z_score=0.0,
            price=prices[-1] if prices else 0.0,
            mean=0.0,
            std=0.0,
            upper_band=0.0,
            lower_band=0.0,
            signal="neutral",
            confidence=0.0,
            lookback=lookback,
            zscore_pct=0.5,
        )

    window = prices[-lookback:]
    mean, std = compute_mean_std(window)

    if std == 0:
        return ZScoreResult(
            symbol=symbol,
            z_score=0.0,
            price=prices[-1],
            mean=mean,
            std=0.0,
            upper_band=mean,
            lower_band=mean,
            signal="neutral",
            confidence=0.0,
            lookback=lookback,
            zscore_pct=0.5,
        )

    current = prices[-1]
    z = (current - mean) / std

    # Calcular percentil histórico
    all_zscores = compute_zscore_series(prices, lookback)
    zscore_pct = _zscore_percentile(z, all_zscores[:-1])

    upper = mean + entry_zscore * std
    lower = mean - entry_zscore * std
    exit_upper = mean + exit_zscore * std
    exit_lower = mean - exit_zscore * std

    # Lógica de señal
    if current_signal == "short":
        # Tenemos posición short, buscar salida si z vuelve a zona neutral
        signal = "exit_short" if current >= exit_lower else "short"
    elif current_signal == "long":
        # Tenemos posición long, buscar salida
        signal = "exit_long" if current <= exit_upper else "long"
    else:
        if current <= lower:
            signal = "long"  # precio muy bajo → comprar reversión al alza
        elif current >= upper:
            signal = "short"  # precio muy alto → vender reversión a la baja
        else:
            signal = "neutral"

    # Confianza: cuán lejos está el Z-Score del umbral
    excess = max(0.0, abs(z) - entry_zscore)
    confidence = min(1.0, 0.6 + excess * 0.2) if signal in ("long", "short") else 0.0

    return ZScoreResult(
        symbol=symbol,
        z_score=round(z, 4),
        price=round(current, 4),
        mean=round(mean, 4),
        std=round(std, 4),
        upper_band=round(upper, 4),
        lower_band=round(lower, 4),
        signal=signal,
        confidence=round(confidence, 3),
        lookback=lookback,
        zscore_pct=zscore_pct,
    )


if __name__ == "__main__":
    data = json.load(sys.stdin)
    result = analyze(
        symbol=data.get("symbol", ""),
        prices=data["prices"],
        lookback=data.get("lookback", 20),
        entry_zscore=data.get("entry_zscore", 2.0),
        exit_zscore=data.get("exit_zscore", 0.5),
        current_signal=data.get("current_signal"),
    )
    print(json.dumps({"ok": True, "result": asdict(result)}))
