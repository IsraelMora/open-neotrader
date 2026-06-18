---
name: Carry Trade
description: Compra divisas de alto rendimiento y vende las de bajo rendimiento. El diferencial de tasas de interés genera ingreso diario (swap/rollover). Rentabilidad histórica ~5-8% anual en AUD/JPY, NZD/JPY. Con filtro de momentum: reduce pérdidas en entornos risk-off.
---

# Carry Trade

## Base académica

**Uncovered Interest Rate Parity (UIP)**: la teoría predice que las divisas de mayor rendimiento se devalúan compensando el diferencial de tasas. En la práctica esto **no ocurre** — el carry trade es rentable de forma persistente.

**Burnside, Eichenbaum & Rebelo (2006)**: "The Returns to Currency Speculation". Sharpe ratio ~0.70 en el largo plazo. El carry trade sobrevive con retornos netos incluso después de costes de transacción.

**Lustig & Verdelhan (2007)**: el carry trade captura un **factor de riesgo sistemático** — el riesgo de desastre global (crash de activos de riesgo). Justifica el Sharpe positivo.

## Cómo funciona

```
Ejemplo: long AUD/JPY

  Australia (RBA): tasa 4.35%/año
  Japón (BoJ):     tasa 0.10%/año
  
  Carry diario = (4.35% - 0.10%) / 365 = 0.0116%/día
  Carry anual  = 4.25% del notional

  → Por cada $10,000 invertidos: ~$425/año de carry income
    + (o -) movimiento del tipo de cambio
```

## Tasas de interés actuales (actualizar con write_skill)

| Divisa | Banco Central | Tasa aproximada |
|--------|--------------|----------------|
| MXN | Banxico | 11.00% |
| TRY | TCMB | 40.00% ⚠️ (alto riesgo) |
| NZD | RBNZ | 5.50% |
| USD | Fed | 5.33% |
| AUD | RBA | 4.35% |
| GBP | BoE | 5.25% |
| EUR | ECB | 4.50% |
| CAD | BoC | 5.00% |
| CHF | SNB | 1.50% |
| JPY | BoJ | 0.10% |

## Mejores pares de carry (mayor diferencial)

| Par | Carry aprox | Riesgo |
|-----|------------|--------|
| NZD/JPY | +5.4% | Medio |
| AUD/JPY | +4.25% | Medio |
| GBP/JPY | +5.15% | Alto |
| USD/JPY | +5.23% | Medio-bajo |
| AUD/CHF | +2.85% | Bajo |

## El riesgo del carry trade: "crash risk"

El carry trade **funciona bien en calma** y **sufre en crisis**:
- 2008: AUD/JPY cayó -47% en semanas → carry eliminado en días
- 2020 COVID: mismo patrón, recuperación más rápida
- 2022 inflation shock: JPY se fortaleció bruscamente

**Mitigación implementada:**
1. `use_momentum_filter`: solo entrar si precio > MA(200) — evita mercados bajistas
2. `risk_off_exit`: salir automáticamente si VIX > 25 — corta las pérdidas grandes

## Cuándo usar carry trade

✅ Mercados en calma (VIX < 20)
✅ Risk-on: bolsas subiendo, spreads de crédito bajos
✅ Banco central de la divisa high-yield en modo restrictivo (subiendo tasas)

❌ Crisis, recesión, pánico
❌ Cuando el banco central high-yield empieza a bajar tasas
❌ VIX > 25 (salir preventivamente)

## Combinaciones

| Con plugin | Efecto |
|------------|--------|
| + Volatility Regime | Usar `avoid_strategies` del régimen para desactivar carry en crisis |
| + ATR Stop Loss | Stop dinámico en pares de carry (no matar la posición con el ruido diario) |
| + Kelly Criterion | Carry tiene estadísticas históricas conocidas → Kelly directo |

## Notas aprendidas

<!-- El LLM actualiza tasas de interés y observaciones de ciclos reales -->
<!-- Última actualización: junio 2026 -->
<!-- RBA: 4.35% | RBNZ: 5.5% | Fed: 5.33% | BoJ: 0.10% -->
