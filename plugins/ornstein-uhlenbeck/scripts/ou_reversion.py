"""
Ornstein-Uhlenbeck Mean Reversion
===================================
El proceso OU es:
  dX_t = θ(μ - X_t)dt + σ dW_t

donde:
  θ  = velocidad de reversión a la media
  μ  = nivel de equilibrio (media de largo plazo)
  σ  = volatilidad del proceso
  W  = movimiento Browniano estándar

Estimación discreta (Vasicek 1977):
  X_{t+1} = X_t e^{-θΔt} + μ(1 - e^{-θΔt}) + ε_t

Se estima por OLS el modelo:
  X_{t+1} = A·X_t + B + ε_t

donde A = e^{-θΔt}, B = μ(1-A)

Métricas clave:
  half-life = ln(2)/θ  (días para que la desviación se reduzca a la mitad)
  Z-score   = (X_t - μ) / σ_eq  donde σ_eq = σ/√(2θ) es la σ de la distribución estacionaria

Referencias:
  Vasicek, O. (1977). An equilibrium characterization of the term structure. JFE.
  Schwartz, E. (1997). The stochastic behavior of commodity prices. JF.
  Gatev et al. (2006). Pairs trading: Performance of a relative-value arbitrage rule. RFS.
"""

from __future__ import annotations

import json
import math
import sys
from dataclasses import asdict, dataclass
from typing import Any

# ── Estimación OLS del proceso OU ────────────────────────────────────────────


def _ols(x: list[float], y: list[float]) -> tuple[float, float, float]:
    """OLS simple: y = a·x + b. Devuelve (a, b, r_squared)."""
    n = len(x)
    if n < 3:
        return 0.0, 0.0, 0.0

    mean_x = sum(x) / n
    mean_y = sum(y) / n

    ss_xy = sum((x[i] - mean_x) * (y[i] - mean_y) for i in range(n))
    ss_xx = sum((xi - mean_x) ** 2 for xi in x)

    if abs(ss_xx) < 1e-15:
        return 0.0, mean_y, 0.0

    a = ss_xy / ss_xx
    b = mean_y - a * mean_x

    y_hat = [a * xi + b for xi in x]
    ss_res = sum((y[i] - y_hat[i]) ** 2 for i in range(n))
    ss_tot = sum((yi - mean_y) ** 2 for yi in y)

    r2 = 1.0 - ss_res / ss_tot if ss_tot > 0 else 0.0
    return a, b, r2


@dataclass
class OuParams:
    theta: float  # velocidad de reversión (por día)
    mu: float  # nivel de equilibrio
    sigma: float  # volatilidad del proceso
    sigma_eq: float  # σ estacionaria = σ/√(2θ)
    half_life: float  # días para reducir desviación a la mitad
    r_squared: float  # calidad del ajuste OLS


def estimate_ou_params(prices: list[float], dt: float = 1.0) -> OuParams:
    """
    Estima parámetros OU por OLS en el modelo discreto de Vasicek.

    Args:
        prices: serie de precios (log-precios para mejor ajuste a activos financieros)
        dt:     intervalo de tiempo entre observaciones (en días, por defecto 1)
    """
    n = len(prices)
    x_t = prices[:-1]
    x_t1 = prices[1:]

    a, b, r2 = _ols(x_t, x_t1)

    # Mapeo OLS → parámetros OU
    # A = e^{-θΔt}  →  θ = -ln(A)/Δt
    if a <= 0 or a >= 2:
        # Proceso no estacionario — devolver parámetros nulos
        return OuParams(
            theta=0.0, mu=0.0, sigma=0.0, sigma_eq=0.0, half_life=float("inf"), r_squared=r2
        )

    theta = -math.log(a) / dt
    mu = b / (1 - a) if abs(1 - a) > 1e-12 else sum(prices) / n

    # σ: std de los residuos
    residuals = [x_t1[i] - (a * x_t[i] + b) for i in range(len(x_t))]
    sigma_res = _std(residuals)
    sigma = sigma_res * math.sqrt(2 * theta / dt) if theta > 0 else sigma_res
    sigma_eq = sigma / math.sqrt(2 * theta) if theta > 0 else sigma_res

    half_life = math.log(2) / theta if theta > 0 else float("inf")

    return OuParams(
        theta=round(theta, 6),
        mu=round(mu, 6),
        sigma=round(sigma, 6),
        sigma_eq=round(sigma_eq, 6),
        half_life=round(half_life, 2),
        r_squared=round(r2, 4),
    )


def _std(data: list[float]) -> float:
    n = len(data)
    if n < 2:
        return 0.0
    mean = sum(data) / n
    return math.sqrt(sum((x - mean) ** 2 for x in data) / (n - 1))


# ── Señal OU ──────────────────────────────────────────────────────────────────


@dataclass
class OuSignal:
    symbol: str
    signal: int  # +1=long (subvalorado), -1=short (sobrevalorado), 0=neutral
    z_score: float  # desviación del equilibrio en sigmas
    current: float  # precio actual (log)
    mu: float  # nivel de equilibrio estimado
    theta: float  # velocidad de reversión
    half_life: float  # días para reversión a la media
    sigma_eq: float  # sigma de la distribución estacionaria
    r_squared: float  # calidad del modelo
    valid: bool  # si el modelo OU es válido para este activo
    reason: str


def analyze_ou(
    symbol: str,
    prices: list[float],
    config: dict[str, Any],
) -> OuSignal:
    entry_sigmas = float(config.get("entry_sigmas", 2.0))
    exit_sigmas = float(config.get("exit_sigmas", 0.5))
    min_hl = float(config.get("min_half_life_days", 2.0))
    max_hl = float(config.get("max_half_life_days", 90.0))
    min_r2 = float(config.get("min_r_squared", 0.30))
    lookback = int(config.get("lookback", 252))

    if len(prices) < max(20, lookback // 4):
        return OuSignal(
            symbol=symbol,
            signal=0,
            z_score=0.0,
            current=0.0,
            mu=0.0,
            theta=0.0,
            half_life=float("inf"),
            sigma_eq=0.0,
            r_squared=0.0,
            valid=False,
            reason="Datos insuficientes",
        )

    # Usar log-precios para mejor ajuste a precios financieros
    log_prices = [math.log(p) for p in prices[-lookback:] if p > 0]
    current = log_prices[-1]

    params = estimate_ou_params(log_prices)

    # Validar calidad del modelo
    if params.r_squared < min_r2:
        return OuSignal(
            symbol=symbol,
            signal=0,
            z_score=0.0,
            current=math.exp(current),
            mu=math.exp(params.mu),
            theta=params.theta,
            half_life=params.half_life,
            sigma_eq=params.sigma_eq,
            r_squared=params.r_squared,
            valid=False,
            reason=f"R² {params.r_squared:.3f} < mínimo {min_r2:.3f}",
        )

    if params.half_life < min_hl or params.half_life > max_hl:
        return OuSignal(
            symbol=symbol,
            signal=0,
            z_score=0.0,
            current=math.exp(current),
            mu=math.exp(params.mu),
            theta=params.theta,
            half_life=params.half_life,
            sigma_eq=params.sigma_eq,
            r_squared=params.r_squared,
            valid=False,
            reason=f"Half-life {params.half_life:.1f}d fuera de rango [{min_hl}, {max_hl}]",
        )

    if params.sigma_eq < 1e-8:
        return OuSignal(
            symbol=symbol,
            signal=0,
            z_score=0.0,
            current=math.exp(current),
            mu=math.exp(params.mu),
            theta=params.theta,
            half_life=params.half_life,
            sigma_eq=params.sigma_eq,
            r_squared=params.r_squared,
            valid=False,
            reason="σ_eq ≈ 0, proceso demasiado estable",
        )

    z_score = (current - params.mu) / params.sigma_eq

    # Señal
    if z_score < -entry_sigmas:
        signal = 1  # infravalorado → long
        reason = f"Z={z_score:.2f} < -{entry_sigmas}σ. Half-life={params.half_life:.1f}d"
    elif z_score > entry_sigmas:
        signal = -1  # sobrevalorado → short
        reason = f"Z={z_score:.2f} > +{entry_sigmas}σ. Half-life={params.half_life:.1f}d"
    elif abs(z_score) < exit_sigmas:
        signal = 0
        reason = f"Z={z_score:.2f} dentro de {exit_sigmas}σ del equilibrio (zona de salida)"
    else:
        signal = 0
        reason = f"Z={z_score:.2f}: entre {exit_sigmas}σ y {entry_sigmas}σ (zona neutral)"

    return OuSignal(
        symbol=symbol,
        signal=signal,
        z_score=round(z_score, 3),
        current=round(math.exp(current), 4),
        mu=round(math.exp(params.mu), 4),
        theta=params.theta,
        half_life=params.half_life,
        sigma_eq=params.sigma_eq,
        r_squared=params.r_squared,
        valid=True,
        reason=reason,
    )


if __name__ == "__main__":
    data = json.loads(sys.stdin.read())
    fn = data.get("function", "analyze_ou")
    args = data.get("args", {})

    if fn == "analyze_ou":
        result = analyze_ou(args["symbol"], args["prices"], args.get("config", {}))
        out = asdict(result)
    elif fn == "estimate_ou_params":
        params = estimate_ou_params(args["prices"], float(args.get("dt", 1.0)))
        out = asdict(params)
    else:
        out = {"error": f"Función desconocida: {fn}"}

    print(json.dumps(out))
