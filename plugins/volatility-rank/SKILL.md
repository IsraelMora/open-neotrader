---
name: Volatility Rank (HV Percentile)
description: Calcula el rango histórico de volatilidad como proxy de IV Rank. Identifica regímenes de volatilidad alta (premium selling) o baja (premium buying). Técnica fundamental de traders profesionales de opciones.
---

# Volatility Rank (HV Percentile)

## Por qué los traders de opciones miran IV Rank

En opciones, el precio (prima) está determinado principalmente por la **volatilidad implícita (IV)**. Si compras opciones cuando IV está alta, estás pagando más de lo que deberías. Si vendes cuando IV está baja, el premium es insuficiente para el riesgo.

**Regla fundamental:**
- IV alta → vender premium (covered calls, cash-secured puts, iron condors)
- IV baja → comprar opciones (long calls, long puts, debit spreads)

## IV Rank vs HV Percentile

| Métrica | Qué mide | Datos necesarios |
|---------|----------|-----------------|
| IV Rank | Dónde está la IV actual vs su rango de 1 año | Cadena de opciones (caro) |
| HV Percentile | Dónde está la HV actual vs su historia | Solo OHLCV (gratis) |

HV Percentile es el **mejor proxy gratuito** disponible. Correlación con IV Rank: ~0.65-0.80.

## Fórmula

```
Retorno diario = ln(close_t / close_{t-1})

HV(21) = std_dev(retornos 21 días) × √252 × 100

HV Percentile = % de valores históricos (252 días) inferiores al HV actual
```

## Interpretación

```
HV Percentile 90% → La volatilidad actual es MAYOR que el 90% de la historia
→ Vender premium (las opciones están caras)

HV Percentile 15% → La volatilidad actual es MENOR que el 85% de la historia  
→ Comprar opciones (están baratas en términos históricos)

HV Percentile 40-60% → Normal — sin ventaja de volatilidad
```

## Estrategias por régimen

| Régimen (Percentil) | Estrategia de opciones | Equity equivalente |
|--------------------|----------------------|-------------------|
| Alto (>80%) | Vender covered calls, CSP, IC | Short volatilidad (cauto) |
| Normal (20-80%) | Spreads neutros | Momentum / técnico |
| Bajo (<20%) | Comprar calls/puts, straddles | Long volatilidad |

## Relación con otros skills

- **Volatility Regime Detection** — detecta 4 regímenes usando VIX
- **Volatility Rank** — granular por activo individual usando HV
- **ATR Stop Loss** — usa ATR del mismo HV para calibrar stops

## Notas aprendidas

<!-- El LLM actualiza con observaciones sobre qué percentiles correlacionaron mejor con IV real -->
