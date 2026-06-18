---
name: Gap Opening Strategy
description: Skill de gaps de apertura. Detecta diferencias entre cierre anterior y apertura del día. Gaps grandes (>2%) → fade (mean reversion). Gaps pequeños en tendencia → continuation. Win rate histórico: 58-65%.
---

# Gap Opening Strategy

## Fundamento estadístico

Los gaps de apertura son uno de los patrones más estudiados en trading:

- **Toby Crabel (1990)**: gaps > 2% en S&P 500 se rellenan en el mismo día en ~65% de los casos
- **Larry Connors**: gap fades en ETFs tienen win rate ~62% con trailing stop
- **Gap size distribution** (Nasdaq, 2010-2023):
  - Gaps 0.5-2%: 60% continúan, 40% se rellenan
  - Gaps 2-5%: 55% se rellenan, 45% continúan
  - Gaps > 5%: 68% se rellenan (pánico → sobre-reacción)

## Dos estrategias

### 1. Gap Fade (Mean Reversion)
Para gaps grandes (> `large_gap_pct`, default 2%):
```
Premisa: el mercado sobre-reacciona; el precio tiende a regresar al cierre anterior
Entrada: al open o primeros 5-15 minutos
Target: fill del gap (precio de cierre anterior)
Stop: 50% del tamaño del gap (por encima/debajo del open)
Win rate: ~60-65% con volumen confirmado
```

### 2. Gap and Go (Continuation)
Para gaps pequeños (0.5-2%) alineados con tendencia:
```
Premisa: gap con volumen fuerte en dirección de tendencia → aceleración
Entrada: pullback al open o primera consolidación
Target: extensión del gap (1.5x-2x el tamaño del gap)
Stop: por debajo del mínimo de la vela de apertura
Win rate: ~55-60%
```

## Confirmaciones adicionales

| Factor | Impact |
|--------|--------|
| Volumen >1.5x promedio | +15% confianza |
| Gap alineado con SPY | +10% confianza |
| Pre-market sostenido | +10% confianza |
| Gap contra tendencia semanal | -20% confianza |

## Timing de la operación

```
09:30 → Gap detectado al abrir
09:30-09:45 → Período de observación (alta volatilidad, no entrar)
09:45-10:15 → Ventana óptima de entrada (volatilidad se asienta)
12:00 → Cierre de posición intraday (fade suele completarse antes de mediodía)
15:45 → Cierre máximo para evitar volatilidad de cierre
```

## Filtros de calidad

1. **No operar en días de datos macro** → usar con Macro Calendar Guard
2. **No operar si VIX > 30** → gaps extremos son poco fiables en alta volatilidad
3. **Volumen de apertura** → si volumen < 50% del promedio, skip (gap falso)
4. **Earnings gap** → los gaps post-earnings se comportan diferente; PEAD plugin los maneja

## Notas aprendidas

<!-- El LLM actualiza con observaciones sobre qué gaps resultaron en señales acertadas -->
