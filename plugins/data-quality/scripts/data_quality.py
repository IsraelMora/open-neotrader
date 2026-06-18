"""
data_quality.py — Validación estadística de datos de precio.

Checks implementados:
  1. STALE_PRICE     — precio más antiguo que max_price_age_hours
  2. ZERO_PRICE      — precio <= 0 (dato corrupto)
  3. OUTLIER         — precio a >N sigma de la media histórica (Chauvenet criterion)
  4. HISTORY_GAP     — gap >gap_threshold_pct entre dos barras consecutivas
  5. INSUFFICIENT    — menos de min_history_bars para validar estadísticas
  6. CROSS_PROVIDER  — divergencia >cross_provider_max_diff entre dos fuentes de precio

Referencia académica:
  Taylor, S.J. (2008) "Modelling Financial Time Series" — criterios de limpieza de datos.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from typing import Any


@dataclass
class QualityIssue:
    symbol: str
    check: str  # STALE_PRICE | ZERO_PRICE | OUTLIER | HISTORY_GAP | INSUFFICIENT | CROSS_PROVIDER
    severity: str  # LOW | MEDIUM | HIGH | CRITICAL
    detail: str
    should_veto: bool


@dataclass
class QualityReport:
    symbol: str
    passed: bool
    issues: list[QualityIssue] = field(default_factory=list)


def check_symbol(
    symbol: str,
    current_price: float | None,
    price_timestamp: float | None,  # Unix epoch seconds
    history: list[float] | None,  # cierre diario, orden cronológico
    alt_price: float | None = None,  # precio de un segundo provider (opcional)
    config: dict[str, Any] | None = None,
) -> QualityReport:
    cfg = config or {}
    max_age_h = float(cfg.get("max_price_age_hours", 24))
    sigma_thresh = float(cfg.get("outlier_sigma_threshold", 4.0))
    min_bars = int(cfg.get("min_history_bars", 10))
    gap_thresh = float(cfg.get("gap_threshold_pct", 0.15))
    veto_on_fail = bool(cfg.get("veto_on_quality_fail", True))
    xp_max_diff = float(cfg.get("cross_provider_max_diff", 0.005))

    issues: list[QualityIssue] = []

    # 1. Precio cero o negativo
    if current_price is not None and current_price <= 0:
        issues.append(
            QualityIssue(
                symbol=symbol,
                check="ZERO_PRICE",
                severity="CRITICAL",
                detail=f"Precio inválido: {current_price}",
                should_veto=True,
            )
        )

    # 2. Precio obsoleto
    if price_timestamp is not None:
        age_h = (time.time() - price_timestamp) / 3600
        if age_h > max_age_h:
            sev = "CRITICAL" if age_h > max_age_h * 2 else "HIGH"
            issues.append(
                QualityIssue(
                    symbol=symbol,
                    check="STALE_PRICE",
                    severity=sev,
                    detail=f"Precio tiene {age_h:.1f}h de antigüedad (máx: {max_age_h}h)",
                    should_veto=veto_on_fail,
                )
            )

    if history:
        valid_hist = [p for p in history if p and p > 0]

        # 3. Historial insuficiente
        if len(valid_hist) < min_bars:
            issues.append(
                QualityIssue(
                    symbol=symbol,
                    check="INSUFFICIENT",
                    severity="MEDIUM",
                    detail=f"Solo {len(valid_hist)} barras disponibles (mín: {min_bars})",
                    should_veto=False,  # no vetear — simplemente sin suficientes datos
                )
            )
        else:
            # 4. Outlier estadístico
            if current_price and current_price > 0:
                mean = sum(valid_hist) / len(valid_hist)
                std = math.sqrt(sum((p - mean) ** 2 for p in valid_hist) / len(valid_hist))
                if std > 1e-8:
                    z = abs(current_price - mean) / std
                    if z > sigma_thresh:
                        sev = "CRITICAL" if z > sigma_thresh * 1.5 else "HIGH"
                        issues.append(
                            QualityIssue(
                                symbol=symbol,
                                check="OUTLIER",
                                severity=sev,
                                detail=(
                                    f"Precio {current_price:.4f} está a {z:.1f}σ"
                                    f" de la media histórica ({mean:.4f}±{std:.4f})"
                                ),
                                should_veto=veto_on_fail,
                            )
                        )

            # 5. Gap entre barras consecutivas
            for i in range(1, len(valid_hist)):
                prev, curr = valid_hist[i - 1], valid_hist[i]
                if prev > 0:
                    gap = abs(curr - prev) / prev
                    if gap > gap_thresh:
                        issues.append(
                            QualityIssue(
                                symbol=symbol,
                                check="HISTORY_GAP",
                                severity="MEDIUM",
                                detail=(
                                    f"Gap del {gap * 100:.1f}% entre barras {i - 1} y {i}"
                                    f" ({prev:.4f}→{curr:.4f})"
                                ),
                                should_veto=False,
                            )
                        )
                        break  # reportar solo el primero por símbolo

    # 6. Divergencia cross-provider
    if current_price and alt_price and current_price > 0 and alt_price > 0:
        diff = abs(current_price - alt_price) / current_price
        if diff > xp_max_diff:
            sev = "HIGH" if diff > xp_max_diff * 2 else "MEDIUM"
            issues.append(
                QualityIssue(
                    symbol=symbol,
                    check="CROSS_PROVIDER",
                    severity=sev,
                    detail=(
                        f"Divergencia del {diff * 100:.2f}% entre providers"
                        f" ({current_price:.4f} vs {alt_price:.4f})"
                    ),
                    should_veto=veto_on_fail,
                )
            )

    return QualityReport(
        symbol=symbol,
        passed=len([i for i in issues if i.should_veto]) == 0,
        issues=issues,
    )


def validate_batch(
    prices: dict[str, float],
    price_timestamps: dict[str, float] | None = None,
    price_history: dict[str, list[float]] | None = None,
    alt_prices: dict[str, float] | None = None,
    config: dict[str, Any] | None = None,
) -> dict[str, QualityReport]:
    """Valida todos los símbolos de un batch."""
    reports: dict[str, QualityReport] = {}
    for symbol, price in prices.items():
        reports[symbol] = check_symbol(
            symbol=symbol,
            current_price=price,
            price_timestamp=(price_timestamps or {}).get(symbol),
            history=(price_history or {}).get(symbol),
            alt_price=(alt_prices or {}).get(symbol),
            config=config,
        )
    return reports
