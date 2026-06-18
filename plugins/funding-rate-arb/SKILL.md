# Funding Rate Arbitrage (Crypto) — Ingresos Pasivos

Plugin de tipo `skill` que detecta oportunidades de **arbitraje de tasa de financiamiento** en futuros perpetuos crypto. Es una de las estrategias de ingresos pasivos más utilizadas por hedge funds crypto.

## ¿Qué es el funding rate?

Los futuros perpetuos no tienen vencimiento. Para mantener el precio anclado al spot, los exchanges cobran/pagan un **funding rate** cada 8 horas:

- **Perp > Spot** (contango): los longs pagan a los shorts → **long spot + short perp = cobras funding**
- **Perp < Spot** (backwardation): los shorts pagan a los longs → **short spot + long perp = cobras funding**

En ambos casos, la posición es **delta-neutral** — sin exposición al precio del activo.

## Rendimiento histórico

| Activo | Período | APR medio | APR pico |
|---|---|---|---|
| BTC | 2021 bull | ~30% | ~150% |
| ETH | 2021 bull | ~50% | ~300% |
| SOL | 2021 | ~80% | ~500% |
| BTC | 2022 bear | ~8% | ~20% |

*(Fuentes: Bitmex Research, Deribit Insights)*

## Clasificación de oportunidades

| Calidad | APR | OI mínimo | Recomendación |
|---|---|---|---|
| EXCELLENT | ≥100% | ≥10× mínimo | Entrada prioritaria |
| GOOD | ≥50% | ≥ mínimo | Entrada normal |
| MARGINAL | ≥20% | ≥ mínimo | Entrada pequeña |
| AVOID | <20% o >500% | — | Sin acción |

Las tasas >500% APR se evitan por probable manipulación o liquidaciones en cascada.

## Configuración

```toml
[config]
min_rate_annual    = 0.20    # 20% APR mínimo para entrar
max_rate_annual    = 5.00    # 500% APR máximo (evitar manipulación)
min_oi_usd         = 1000000 # $1M de OI mínimo para liquidez
funding_interval_h = 8
annualization_factor = 1095  # 365 × 3 períodos por día
```

## Herramientas disponibles

### `scan_funding_opportunities`
```json
{
  "symbols_data": [
    { "symbol": "BTC", "funding_rate_8h": 0.0005, "open_interest_usd": 5000000000 },
    { "symbol": "ETH", "funding_rate_8h": -0.0003, "open_interest_usd": 2000000000 }
  ]
}
```

**Respuesta:**
```json
{
  "total_scanned": 2,
  "opportunities_found": 2,
  "best_apr": 0.5475,
  "opportunities": [
    {
      "symbol": "BTC", "funding_apr": 0.5475,
      "direction": "long_spot_short_perp",
      "quality": "good", "signal": 1,
      "reason": "APR 54.8%, 0.150%/día estimado. OI $5,000.0M. Calidad: GOOD"
    }
  ]
}
```

## Riesgos

- **Riesgo de ejecución**: el spread spot-perp puede erosionar ganancias en activos ilíquidos
- **Riesgo de liquidación**: si la posición perp se liquida, pierdes la cobertura
- **Cambio de tasa**: el funding puede volverse negativo (cambias de pagador a cobrador)
- Recomendación: usar stop-loss por pérdida de spread > 0.5% o cambio de dirección del funding
