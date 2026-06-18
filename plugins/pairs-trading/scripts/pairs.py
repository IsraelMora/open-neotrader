"""
Pairs Trading (Statistical Arbitrage) — implementación de referencia.

Base académica:
- Engle & Granger (1987): "Co-integration and Error Correction" (Econometrica).
  Dos series no-estacionarias pueden tener una combinación lineal estacionaria.
- Vidyamurthy (2004): "Pairs Trading: Quantitative Methods and Analysis".
  Aplicación práctica en mercados financieros.

Dos activos A y B están cointegrados si existe β tal que:
    spread_t = ln(P_A_t) - β × ln(P_B_t) ~ estacionario (media-revertiente)

Cuando el spread diverge > 2σ:
    long el activo rezagado + short el adelantado
    Esperar convergencia → cerrar ambas posiciones
"""

from __future__ import annotations

import json
import math
import sys
from dataclasses import asdict, dataclass


@dataclass
class PairStats:
    symbol_a: str
    symbol_b: str
    beta: float  # ratio de cobertura (hedge ratio)
    spread_mean: float  # media histórica del spread
    spread_std: float  # desviación estándar del spread
    current_spread: float  # spread actual
    z_score: float  # Z-Score del spread actual
    correlation: float  # correlación de Pearson (referencia)
    adf_stat: float  # estadístico ADF (aproximado) — más negativo = más estacionario
    is_cointegrated: bool  # True si pasa el test de cointegración
    lookback: int


@dataclass
class PairsSignal:
    symbol_a: str
    symbol_b: str
    action: str  # "long_spread" | "short_spread" | "exit" | "stop"
    leg_a: str  # "long" | "short" | "exit"
    leg_b: str  # "long" | "short" | "exit"
    z_score: float
    beta: float
    confidence: float
    reason: str


def compute_log_returns(prices: list[float]) -> list[float]:
    return [math.log(prices[i] / prices[i - 1]) for i in range(1, len(prices)) if prices[i - 1] > 0]


def pearson_corr(xs: list[float], ys: list[float]) -> float:
    n = min(len(xs), len(ys))
    if n < 5:
        return 0.0
    x, y = xs[-n:], ys[-n:]
    mx, my = sum(x) / n, sum(y) / n
    cov = sum((x[i] - mx) * (y[i] - my) for i in range(n)) / n
    vx = math.sqrt(sum((v - mx) ** 2 for v in x) / n)
    vy = math.sqrt(sum((v - my) ** 2 for v in y) / n)
    return round(cov / (vx * vy), 4) if vx > 0 and vy > 0 else 0.0


def ols_beta(y: list[float], x: list[float]) -> float:
    """OLS: estima β en y = α + β×x (regresión mínimos cuadrados)."""
    n = min(len(y), len(x))
    if n < 5:
        return 1.0
    y_, x_ = y[-n:], x[-n:]
    mx, my = sum(x_) / n, sum(y_) / n
    num = sum((x_[i] - mx) * (y_[i] - my) for i in range(n))
    den = sum((x_[i] - mx) ** 2 for i in range(n))
    return num / den if den != 0 else 1.0


def adf_statistic_approx(series: list[float]) -> float:
    """
    Aproximación del estadístico ADF (Augmented Dickey-Fuller).
    ADF < -3.0 sugiere rechazo de raíz unitaria (serie estacionaria).

    Implementación simplificada sin dependencias externas:
    regresión de Δy_t sobre y_{t-1}, el t-estadístico del coeficiente es el ADF.
    """
    if len(series) < 10:
        return 0.0
    dy = [series[i] - series[i - 1] for i in range(1, len(series))]
    y_lag = series[:-1]

    n = len(dy)
    mx = sum(y_lag) / n
    num = sum(y_lag[i] * dy[i] for i in range(n)) - n * mx * (sum(dy) / n)
    den = sum((y_lag[i] - mx) ** 2 for i in range(n))
    if den == 0:
        return 0.0
    beta = num / den

    residuals = [dy[i] - beta * (y_lag[i] - mx) for i in range(n)]
    mse = math.sqrt(sum(r**2 for r in residuals) / max(n - 2, 1))
    se_beta = mse / math.sqrt(den) if den > 0 else 1e-9

    return beta / se_beta if se_beta > 0 else 0.0


def compute_spread(
    prices_a: list[float],
    prices_b: list[float],
    beta: float | None = None,
) -> tuple[list[float], float]:
    """
    Calcula el spread logarítmico: spread_t = ln(P_A_t) - β × ln(P_B_t).

    Returns:
        (series_de_spread, beta_usado)
    """
    n = min(len(prices_a), len(prices_b))
    log_a = [math.log(p) for p in prices_a[-n:] if p > 0]
    log_b = [math.log(p) for p in prices_b[-n:] if p > 0]

    if beta is None:
        beta = ols_beta(log_a, log_b)

    spread = [log_a[i] - beta * log_b[i] for i in range(min(len(log_a), len(log_b)))]
    return spread, beta


def analyze_pair(
    symbol_a: str,
    symbol_b: str,
    prices_a: list[float],
    prices_b: list[float],
    lookback: int = 60,
    min_correlation: float = 0.7,
    adf_threshold: float = -2.5,
) -> PairStats:
    """
    Analiza si dos activos forman un par cointegrado y calcula el Z-Score del spread.

    Args:
        prices_a, prices_b: series históricas (más antiguo primero)
        lookback:            días para calcular estadísticas del spread
        min_correlation:     correlación mínima para considerar el par
        adf_threshold:       estadístico ADF mínimo para considerar cointegrado

    Returns:
        PairStats con métricas completas del par
    """
    n = min(len(prices_a), len(prices_b), lookback + 5)
    pa = prices_a[-n:]
    pb = prices_b[-n:]

    log_pa = [math.log(p) for p in pa if p > 0]
    log_pb = [math.log(p) for p in pb if p > 0]

    corr = pearson_corr(log_pa, log_pb)
    beta = ols_beta(log_pa, log_pb)

    spread, beta = compute_spread(pa, pb, beta)

    if not spread:
        return PairStats(
            symbol_a=symbol_a,
            symbol_b=symbol_b,
            beta=beta,
            spread_mean=0,
            spread_std=0,
            current_spread=0,
            z_score=0,
            correlation=corr,
            adf_stat=0,
            is_cointegrated=False,
            lookback=lookback,
        )

    # Estadísticas del spread sobre el período de lookback
    window = spread[-lookback:]
    mean = sum(window) / len(window)
    std = math.sqrt(sum((s - mean) ** 2 for s in window) / max(len(window) - 1, 1))

    current = spread[-1]
    z = (current - mean) / std if std > 0 else 0.0

    # Test ADF aproximado sobre el spread
    adf = adf_statistic_approx(window)

    is_coint = (abs(corr) >= min_correlation) and (adf <= adf_threshold)

    return PairStats(
        symbol_a=symbol_a,
        symbol_b=symbol_b,
        beta=round(beta, 4),
        spread_mean=round(mean, 6),
        spread_std=round(std, 6),
        current_spread=round(current, 6),
        z_score=round(z, 4),
        correlation=corr,
        adf_stat=round(adf, 4),
        is_cointegrated=is_coint,
        lookback=lookback,
    )


def generate_signal(
    stats: PairStats,
    entry_z: float = 2.0,
    exit_z: float = 0.5,
    stop_z: float = 3.5,
    current_position: str | None = None,  # "long_spread" | "short_spread" | None
) -> PairsSignal | None:
    """
    Genera señal de pairs trading basada en el Z-Score del spread.

    Convención:
    - Spread sube (Z > 0): A está caro vs B → short A + long B = "short_spread"
    - Spread baja (Z < 0): A está barato vs B → long A + short B = "long_spread"
    """
    z = stats.z_score

    if current_position == "long_spread":
        if z >= -exit_z:
            return PairsSignal(
                symbol_a=stats.symbol_a,
                symbol_b=stats.symbol_b,
                action="exit",
                leg_a="exit",
                leg_b="exit",
                z_score=z,
                beta=stats.beta,
                confidence=0.85,
                reason=f"Spread volvió a la media (Z={z:+.2f})",
            )
        if z <= -stop_z:
            return PairsSignal(
                symbol_a=stats.symbol_a,
                symbol_b=stats.symbol_b,
                action="stop",
                leg_a="exit",
                leg_b="exit",
                z_score=z,
                beta=stats.beta,
                confidence=0.99,
                reason=f"Stop loss activado (Z={z:+.2f} < -{stop_z})",
            )
        return None  # mantener posición

    if current_position == "short_spread":
        if z <= exit_z:
            return PairsSignal(
                symbol_a=stats.symbol_a,
                symbol_b=stats.symbol_b,
                action="exit",
                leg_a="exit",
                leg_b="exit",
                z_score=z,
                beta=stats.beta,
                confidence=0.85,
                reason=f"Spread volvió a la media (Z={z:+.2f})",
            )
        if z >= stop_z:
            return PairsSignal(
                symbol_a=stats.symbol_a,
                symbol_b=stats.symbol_b,
                action="stop",
                leg_a="exit",
                leg_b="exit",
                z_score=z,
                beta=stats.beta,
                confidence=0.99,
                reason=f"Stop loss activado (Z={z:+.2f} > {stop_z})",
            )
        return None

    # Sin posición — buscar entrada
    if z <= -entry_z:
        excess = abs(z) - entry_z
        conf = min(0.88, 0.65 + excess * 0.08)
        return PairsSignal(
            symbol_a=stats.symbol_a,
            symbol_b=stats.symbol_b,
            action="long_spread",
            leg_a="long",
            leg_b="short",
            z_score=z,
            beta=stats.beta,
            confidence=round(conf, 3),
            reason=(
                f"Spread bajo (Z={z:+.2f}): long {stats.symbol_a}"
                f" / short {stats.symbol_b} (β={stats.beta:.3f})"
            ),
        )
    if z >= entry_z:
        excess = abs(z) - entry_z
        conf = min(0.88, 0.65 + excess * 0.08)
        return PairsSignal(
            symbol_a=stats.symbol_a,
            symbol_b=stats.symbol_b,
            action="short_spread",
            leg_a="short",
            leg_b="long",
            z_score=z,
            beta=stats.beta,
            confidence=round(conf, 3),
            reason=(
                f"Spread alto (Z={z:+.2f}): short {stats.symbol_a}"
                f" / long {stats.symbol_b} (β={stats.beta:.3f})"
            ),
        )

    return None


if __name__ == "__main__":
    data = json.load(sys.stdin)
    cmd = data.get("cmd", "analyze_pair")

    if cmd == "analyze_pair":
        result = analyze_pair(
            symbol_a=data["symbol_a"],
            symbol_b=data["symbol_b"],
            prices_a=data["prices_a"],
            prices_b=data["prices_b"],
            lookback=data.get("lookback", 60),
        )
        print(json.dumps({"ok": True, "result": asdict(result)}))
    elif cmd == "generate_signal":
        stats_data = data["stats"]
        stats = PairStats(**stats_data)
        sig = generate_signal(
            stats=stats,
            entry_z=data.get("entry_zscore", 2.0),
            exit_z=data.get("exit_zscore", 0.5),
            stop_z=data.get("stop_zscore", 3.5),
            current_position=data.get("current_position"),
        )
        print(json.dumps({"ok": True, "signal": asdict(sig) if sig else None}))
