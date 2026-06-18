"""
Ensemble Signal Voting + Vol-Targeting
=======================================
12 variantes de señal (3 tipos × 4 lookbacks) + volatility scaling.

Basado en:
- Moskowitz, Ooi & Pedersen (2012) "Time Series Momentum" — Journal of Financial Economics
- AQR Capital Management: TSMOM estrategia institucional
- Trading-test/domain/strategy.py (arquitectura hexagonal, portada a plugins)

Lógica:
1. Para cada lookback en [20, 60, 120, 250]:
   - EMA Cross: precio > EMA(lookback) → long
   - Donchian: precio > max(lookback) / precio < min(lookback) → señal
   - TSMOM: retorno(lookback días) > 0 → long
2. Votación: ≥ min_votes de 12 → señal consolidada
3. Vol-targeting: position_size = vol_target / vol_realizada_21d
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict, dataclass, field
from typing import Any

# ── Primitivas ────────────────────────────────────────────────────────────────


def _ema(prices: list[float], period: int) -> list[float]:
    """EMA con factor de suavizado α = 2/(period+1)."""
    if not prices:
        return []
    alpha = 2.0 / (period + 1)
    ema = [prices[0]]
    for p in prices[1:]:
        ema.append(ema[-1] * (1 - alpha) + p * alpha)
    return ema


def _realized_vol(prices: list[float], lookback: int = 21) -> float:
    """Volatilidad diaria realizada como std de log-retornos × √252."""
    if len(prices) < lookback + 1:
        return 0.0
    recent = prices[-(lookback + 1) :]
    log_rets = [(recent[i] / recent[i - 1]) - 1 for i in range(1, len(recent))]
    if len(log_rets) < 2:
        return 0.0
    mean = sum(log_rets) / len(log_rets)
    variance = sum((r - mean) ** 2 for r in log_rets) / (len(log_rets) - 1)
    daily_std = variance**0.5
    return daily_std * (252**0.5)


# ── Señales individuales ──────────────────────────────────────────────────────


def _ema_signal(prices: list[float], lookback: int) -> int:
    """EMA Cross: +1 si precio actual > EMA(lookback), -1 si <, 0 si sin datos."""
    if len(prices) < lookback:
        return 0
    ema = _ema(prices, lookback)
    last_price = prices[-1]
    last_ema = ema[-1]
    if last_price > last_ema * 1.001:  # 0.1% buffer anti-whipsaw
        return 1
    if last_price < last_ema * 0.999:
        return -1
    return 0


def _donchian_signal(prices: list[float], lookback: int) -> int:
    """Donchian Channel Breakout: +1 si nuevo máximo(lookback), -1 si nuevo mínimo."""
    if len(prices) < lookback + 1:
        return 0
    window = prices[-(lookback + 1) : -1]  # ventana excluyendo el precio actual
    current = prices[-1]
    if current >= max(window):
        return 1
    if current <= min(window):
        return -1
    return 0


def _tsmom_signal(prices: list[float], lookback: int) -> int:
    """Time-Series Momentum: +1 si retorno(lookback) > 0, -1 si < 0."""
    if len(prices) < lookback + 1:
        return 0
    ret = (prices[-1] / prices[-lookback - 1]) - 1
    if ret > 0.001:  # buffer mínimo del 0.1%
        return 1
    if ret < -0.001:
        return -1
    return 0


# ── Ensemble ──────────────────────────────────────────────────────────────────


@dataclass
class VariantVote:
    type: str  # "ema" | "donchian" | "tsmom"
    lookback: int
    signal: int  # +1, -1, 0


@dataclass
class EnsembleResult:
    symbol: str
    signal: int  # +1=long, -1=short, 0=neutral
    votes_long: int
    votes_short: int
    votes_neutral: int
    total_variants: int
    conviction: float  # |votes_long - votes_short| / total_variants
    vol_annual: float  # volatilidad realizada anual
    position_scale: float  # factor de escala vol-targeting (0-2.0)
    variants: list[VariantVote] = field(default_factory=list)


def compute_ensemble(
    symbol: str,
    prices: list[float],
    lookbacks: list[int],
    vol_target_annual: float,
    vol_lookback: int,
    min_votes: int,
    use_ema: bool,
    use_donchian: bool,
    use_tsmom: bool,
) -> EnsembleResult:
    variants: list[VariantVote] = []

    for lb in lookbacks:
        if use_ema:
            variants.append(VariantVote("ema", lb, _ema_signal(prices, lb)))
        if use_donchian:
            variants.append(VariantVote("donchian", lb, _donchian_signal(prices, lb)))
        if use_tsmom:
            variants.append(VariantVote("tsmom", lb, _tsmom_signal(prices, lb)))

    votes_long = sum(1 for v in variants if v.signal == 1)
    votes_short = sum(1 for v in variants if v.signal == -1)
    votes_neutral = sum(1 for v in variants if v.signal == 0)
    total = len(variants)

    # Señal consolidada
    if votes_long >= min_votes:
        signal = 1
    elif votes_short >= min_votes:
        signal = -1
    else:
        signal = 0

    conviction = abs(votes_long - votes_short) / total if total > 0 else 0.0

    # Vol-targeting: position_scale = vol_target / vol_realizada
    vol_annual = _realized_vol(prices, vol_lookback)
    position_scale = min(vol_target_annual / vol_annual, 2.0) if vol_annual > 0.001 else 1.0

    return EnsembleResult(
        symbol=symbol,
        signal=signal,
        votes_long=votes_long,
        votes_short=votes_short,
        votes_neutral=votes_neutral,
        total_variants=total,
        conviction=round(conviction, 3),
        vol_annual=round(vol_annual, 4),
        position_scale=round(position_scale, 3),
        variants=variants,
    )


def analyze_ensemble(symbol: str, prices: list[float], config: dict[str, Any]) -> dict:
    lookbacks = list(config.get("lookbacks", [20, 60, 120, 250]))
    vol_target_annual = float(config.get("vol_target_annual", 0.10))
    vol_lookback = int(config.get("vol_lookback", 21))
    min_votes = int(config.get("min_votes", 7))
    use_ema = bool(config.get("use_ema", True))
    use_donchian = bool(config.get("use_donchian", True))
    use_tsmom = bool(config.get("use_tsmom", True))

    if len(prices) < max(lookbacks) + 2:
        return {
            "symbol": symbol,
            "signal": 0,
            "error": f"Insuficientes datos: se necesitan al menos {max(lookbacks) + 2} precios",
        }

    result = compute_ensemble(
        symbol,
        prices,
        lookbacks,
        vol_target_annual,
        vol_lookback,
        min_votes,
        use_ema,
        use_donchian,
        use_tsmom,
    )
    return asdict(result)


if __name__ == "__main__":
    data = json.loads(sys.stdin.read())
    fn = data.get("function", "analyze_ensemble")
    args = data.get("args", {})

    if fn == "analyze_ensemble":
        out = analyze_ensemble(args["symbol"], args["prices"], args.get("config", {}))
    else:
        out = {"error": f"Función desconocida: {fn}"}

    print(json.dumps(out))
