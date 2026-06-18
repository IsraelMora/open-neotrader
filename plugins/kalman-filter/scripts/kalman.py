"""
Kalman Filter Trend Following
================================
Modelo de espacio de estados para precio de activos:

  Estado oculto:    x_t = x_{t-1} + w_t        (w ~ N(0, Q))
  Observación:      z_t = x_t + v_t             (v ~ N(0, R))

El filtro de Kalman estima el estado oculto (tendencia) óptimamente en
el sentido de mínimos cuadrados bajo el modelo lineal-gaussiano.

Algoritmo (predicción + actualización):
  Predict:
    x̂_t|t-1 = x̂_{t-1|t-1}              (predicción del estado)
    P_t|t-1  = P_{t-1|t-1} + Q           (predicción de la varianza)

  Update:
    K_t = P_t|t-1 / (P_t|t-1 + R)       (ganancia de Kalman)
    x̂_t|t = x̂_t|t-1 + K_t(z_t - x̂_t|t-1)  (estado actualizado)
    P_t|t  = (1 - K_t) · P_t|t-1         (varianza actualizada)

La ganancia K adapta cuánto peso dar a la nueva observación:
  K → 1: el filtro confía más en las observaciones (entorno ruidoso → Q grande)
  K → 0: el filtro confía más en el modelo (entorno estable → R grande)

Referencias:
  Welch, G. & Bishop, G. (1995). An Introduction to the Kalman Filter.
  Zacks, S. (2009). Optimal Control. Springer.
  Fung, W. & Hsieh, D. (1997). Empirical characteristics of dynamic trading strategies. RFS.
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict, dataclass
from typing import Any


@dataclass
class KalmanState:
    x_hat: float  # estado estimado (tendencia)
    P: float  # varianza del error de estimación
    K: float  # ganancia de Kalman (último paso)


def kalman_filter(
    prices: list[float],
    Q: float,
    R: float,
    P0: float,
) -> list[KalmanState]:
    """
    Aplica el filtro de Kalman a la serie de precios.

    Args:
        prices: serie de precios observados
        Q:      varianza de ruido de proceso (cuánto varía la tendencia)
        R:      varianza de ruido de observación (cuánto ruido tiene el precio)
        P0:     varianza inicial del estado

    Returns:
        Lista de KalmanState con el estado estimado en cada paso.
    """
    if not prices:
        return []

    states: list[KalmanState] = []
    x_hat = prices[0]
    P = P0

    for z in prices:
        # Predicción (modelo random walk)
        P_pred = P + Q

        # Ganancia de Kalman
        K = P_pred / (P_pred + R)

        # Actualización
        x_hat = x_hat + K * (z - x_hat)
        P = (1 - K) * P_pred

        states.append(KalmanState(x_hat=x_hat, P=P, K=K))

    return states


@dataclass
class KalmanSignal:
    symbol: str
    signal: int  # +1=long, -1=short, 0=neutral
    current_price: float
    kalman_estimate: float  # x̂ (tendencia estimada)
    deviation_pct: float  # (price - x̂) / x̂
    kalman_gain: float  # K del último paso
    kalman_variance: float  # P del último paso
    trend: str  # "up" | "down" | "flat"
    reason: str


def analyze_kalman(
    symbol: str,
    prices: list[float],
    config: dict[str, Any],
) -> KalmanSignal:
    Q = float(config.get("process_noise", 0.01))
    R = float(config.get("observation_noise", 1.0))
    P0 = float(config.get("initial_variance", 1.0))
    threshold = float(config.get("entry_threshold", 0.002))
    min_obs = int(config.get("min_observations", 30))

    if len(prices) < min_obs:
        return KalmanSignal(
            symbol=symbol,
            signal=0,
            current_price=prices[-1] if prices else 0,
            kalman_estimate=0.0,
            deviation_pct=0.0,
            kalman_gain=0.0,
            kalman_variance=0.0,
            trend="flat",
            reason=f"Insuficientes observaciones ({len(prices)} < {min_obs})",
        )

    states = kalman_filter(prices, Q, R, P0)
    last = states[-1]
    prev = states[-2] if len(states) >= 2 else last

    current = prices[-1]
    x_hat = last.x_hat

    if abs(x_hat) < 1e-10:
        return KalmanSignal(
            symbol=symbol,
            signal=0,
            current_price=current,
            kalman_estimate=x_hat,
            deviation_pct=0.0,
            kalman_gain=last.K,
            kalman_variance=last.P,
            trend="flat",
            reason="Estimado Kalman ≈ 0",
        )

    deviation_pct = (current - x_hat) / x_hat

    # Tendencia: comparar x̂ actual con x̂ anterior
    trend_delta = last.x_hat - prev.x_hat
    if trend_delta > 0.0001:
        trend = "up"
    elif trend_delta < -0.0001:
        trend = "down"
    else:
        trend = "flat"

    # Señal: precio cruza la estimación Kalman por encima del threshold
    # Solo señales en la dirección de la tendencia
    if deviation_pct < -threshold and trend == "up":
        signal = 1
        reason = (
            f"Precio {current:.2f} por debajo de Kalman {x_hat:.2f}"
            f" ({deviation_pct:.2%}) en tendencia UP"
        )
    elif deviation_pct > threshold and trend == "down":
        signal = -1
        reason = (
            f"Precio {current:.2f} por encima de Kalman {x_hat:.2f}"
            f" ({deviation_pct:.2%}) en tendencia DOWN"
        )
    elif abs(deviation_pct) < threshold / 2:
        signal = 0
        reason = f"Precio cerca de Kalman ({deviation_pct:.2%}), sin señal"
    else:
        signal = 0
        reason = f"Sin confirmación de tendencia (trend={trend}, dev={deviation_pct:.2%})"

    return KalmanSignal(
        symbol=symbol,
        signal=signal,
        current_price=round(current, 4),
        kalman_estimate=round(x_hat, 4),
        deviation_pct=round(deviation_pct, 5),
        kalman_gain=round(last.K, 4),
        kalman_variance=round(last.P, 6),
        trend=trend,
        reason=reason,
    )


if __name__ == "__main__":
    data = json.loads(sys.stdin.read())
    fn = data.get("function", "analyze_kalman")
    args = data.get("args", {})

    if fn == "analyze_kalman":
        result = analyze_kalman(args["symbol"], args["prices"], args.get("config", {}))
        out = asdict(result)
    elif fn == "kalman_filter":
        states = kalman_filter(
            args["prices"],
            float(args.get("Q", 0.01)),
            float(args.get("R", 1.0)),
            float(args.get("P0", 1.0)),
        )
        out = {"states": [asdict(s) for s in states]}
    else:
        out = {"error": f"Función desconocida: {fn}"}

    print(json.dumps(out))
