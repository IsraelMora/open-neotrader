"""
Funding Rate Arbitrage (Crypto)
================================
Estrategia de ingresos pasivos: captura el funding rate de futuros perpetuos
tomando posición delta-neutral (long spot / short perp).

Mecánica:
- Los contratos perpetuos pagan funding cada 8h al lado perdedor
- Cuando perp > spot (contango) → long spot + short perp → cobras funding
- Cuando perp < spot (backwardation) → short spot + long perp → cobras funding
- Sin exposición neta al precio del activo (delta-neutral)

Rendimiento histórico (Binance, Bybit 2021-2023):
  BTC: 15-40% APR en períodos de alta actividad
  ETH: 20-60% APR
  Altcoins: 50-200%+ APR (mayor riesgo de liquidación)

Referencia:
  - Bitmex Research (2016) — The funding rate mechanism
  - Deribit Insights (2021) — Perpetual funding arbitrage
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict, dataclass
from typing import Any


@dataclass
class FundingOpportunity:
    symbol: str
    funding_rate_8h: float  # tasa por período de 8h (fracción)
    funding_apr: float  # tasa anualizada (fracción)
    direction: str  # "long_spot_short_perp" | "short_spot_long_perp"
    signal: int  # +1 = oportunidad, 0 = no hay
    estimated_daily_pct: float
    open_interest_usd: float
    quality: str  # "excellent" | "good" | "marginal" | "avoid"
    reason: str


def _annualize(rate_8h: float, factor: int) -> float:
    """Convierte tasa de 8h a APR. No se compone — es simple para ser conservador."""
    return rate_8h * factor


def _quality_score(apr: float, oi: float, config: dict) -> str:
    min_oi = float(config.get("min_oi_usd", 1_000_000))
    if apr >= 1.0 and oi >= min_oi * 10:
        return "excellent"
    if apr >= 0.50 and oi >= min_oi:
        return "good"
    if apr >= 0.20 and oi >= min_oi:
        return "marginal"
    return "avoid"


def analyze_funding_opportunity(
    symbol: str,
    funding_rate_8h: float,
    open_interest_usd: float,
    config: dict[str, Any],
) -> FundingOpportunity:
    """
    Analiza si hay oportunidad de arbitraje de funding para un símbolo.

    Args:
        symbol:           Ticker del activo (ej: BTC, ETH)
        funding_rate_8h:  Tasa de funding del período actual (fracción).
                          + = perp caro, - = spot caro
        open_interest_usd: Open interest en USD del contrato perpetuo
        config:           Configuración del plugin
    """
    factor = int(config.get("annualization_factor", 1095))
    min_apr = float(config.get("min_rate_annual", 0.20))
    max_apr = float(config.get("max_rate_annual", 5.00))
    min_oi = float(config.get("min_oi_usd", 1_000_000))

    abs_rate = abs(funding_rate_8h)
    apr = _annualize(abs_rate, factor)
    daily_pct = abs_rate * 3  # 3 pagos por día × tasa

    # Sin señal si la tasa está fuera de rango o la liquidez es insuficiente
    if apr < min_apr:
        return FundingOpportunity(
            symbol=symbol,
            funding_rate_8h=funding_rate_8h,
            funding_apr=apr,
            direction="none",
            signal=0,
            estimated_daily_pct=daily_pct,
            open_interest_usd=open_interest_usd,
            quality="avoid",
            reason=f"APR {apr:.1%} < mínimo {min_apr:.1%}",
        )

    if apr > max_apr:
        return FundingOpportunity(
            symbol=symbol,
            funding_rate_8h=funding_rate_8h,
            funding_apr=apr,
            direction="none",
            signal=0,
            estimated_daily_pct=daily_pct,
            open_interest_usd=open_interest_usd,
            quality="avoid",
            reason=f"APR {apr:.1%} > máximo {max_apr:.1%} — posible manipulación",
        )

    if open_interest_usd < min_oi:
        return FundingOpportunity(
            symbol=symbol,
            funding_rate_8h=funding_rate_8h,
            funding_apr=apr,
            direction="none",
            signal=0,
            estimated_daily_pct=daily_pct,
            open_interest_usd=open_interest_usd,
            quality="avoid",
            reason=f"OI ${open_interest_usd:,.0f} < mínimo ${min_oi:,.0f}",
        )

    # Determinar dirección
    direction = "long_spot_short_perp" if funding_rate_8h > 0 else "short_spot_long_perp"
    quality = _quality_score(apr, open_interest_usd, config)

    return FundingOpportunity(
        symbol=symbol,
        funding_rate_8h=round(funding_rate_8h, 6),
        funding_apr=round(apr, 4),
        direction=direction,
        signal=1,
        estimated_daily_pct=round(daily_pct, 5),
        open_interest_usd=open_interest_usd,
        quality=quality,
        reason=(
            f"APR {apr:.1%}, {daily_pct:.3%}/día estimado. "
            f"OI ${open_interest_usd / 1e6:.1f}M. Calidad: {quality.upper()}"
        ),
    )


def scan_funding_opportunities(
    symbols_data: list[dict[str, Any]],
    config: dict[str, Any],
) -> dict:
    """
    Analiza una lista de símbolos y devuelve las mejores oportunidades.

    Args:
        symbols_data: [{"symbol": "BTC", "funding_rate_8h": 0.0001, "open_interest_usd": 5e9}]
    """
    opportunities = []
    for s in symbols_data:
        opp = analyze_funding_opportunity(
            symbol=str(s.get("symbol", "")),
            funding_rate_8h=float(s.get("funding_rate_8h", 0.0)),
            open_interest_usd=float(s.get("open_interest_usd", 0.0)),
            config=config,
        )
        opportunities.append(asdict(opp))

    # Ordenar por APR descendente, solo oportunidades activas
    active = sorted(
        [o for o in opportunities if o["signal"] == 1],
        key=lambda x: x["funding_apr"],
        reverse=True,
    )
    all_ops = active + [o for o in opportunities if o["signal"] == 0]

    return {
        "total_scanned": len(symbols_data),
        "opportunities_found": len(active),
        "best_apr": active[0]["funding_apr"] if active else 0.0,
        "opportunities": all_ops,
    }


if __name__ == "__main__":
    data = json.loads(sys.stdin.read())
    fn = data.get("function", "scan_funding_opportunities")
    args = data.get("args", {})

    if fn == "scan_funding_opportunities":
        out = scan_funding_opportunities(args.get("symbols_data", []), args.get("config", {}))
    elif fn == "analyze_funding_opportunity":
        opp = analyze_funding_opportunity(
            args["symbol"],
            float(args["funding_rate_8h"]),
            float(args.get("open_interest_usd", 0)),
            args.get("config", {}),
        )
        out = asdict(opp)
    else:
        out = {"error": f"Función desconocida: {fn}"}

    print(json.dumps(out))
