---
name: VWAP Reversion
description: Estrategia intradiaria de mean reversion al VWAP. Cuando el precio se aleja 2σ del VWAP, entra en la dirección opuesta esperando la reversión. Win rate ~62% histórico. Solo en días líquidos con volumen normal. Requiere datos intradiarios (5m recomendado).
---

# VWAP Reversion

## ¿Qué es el VWAP?

El VWAP (**Volume Weighted Average Price**) es el precio promedio ponderado por volumen desde la apertura de la sesión. Es el benchmark interno de los traders institucionales — los algoritmos de ejecución intentan comprar por debajo y vender por encima del VWAP.

```
VWAP = Σ(precio_típico_i × volumen_i) / Σ(volumen_i)
precio_típico = (máximo + mínimo + cierre) / 3
```

## Por qué el precio revierte al VWAP

1. **Institucionales como imán**: los market makers y fondos ejecutan órdenes cerca del VWAP para minimizar market impact
2. **Desvíos = oportunidad de arbitraje**: cuando el precio se aleja mucho del VWAP, otros participantes ven una desviación y la aprovechan
3. **Self-fulfilling**: millones de algoritmos usan el VWAP como referencia → se convierte en soporte/resistencia dinámico

## Bandas VWAP (sigma)

```
σ_VWAP = desviación estándar ponderada por volumen
Banda superior = VWAP + 2σ
Banda inferior = VWAP - 2σ

La mayoría del tiempo (~95.4%), el precio se mantiene dentro de ±2σ.
Cuando sale, hay alta probabilidad de reversión.
```

## Señales de trading

### Long Reversion
```
Condición:
  precio_actual < VWAP - 2σ        (muy por debajo del VWAP)
  volumen_actual > promedio × 0.8   (liquidez suficiente)
  sesión_activa = True              (no en pre/after market)

Entrada:  precio actual (mercado)
Stop:     precio_entrada - 1σ       (si se aleja más, la reversión falló)
Target:   precio_entrada + (VWAP - precio_entrada) × 50%  (a mitad del camino)
R/R esperado: ~1.4:1
```

### Short Reversion
```
Condición:
  precio_actual > VWAP + 2σ        (muy por encima)

Solo en mercados que permiten short (crypto, futuros, forex).
En equity usa como señal de reducir/salir de posición larga.
```

## Cuándo funciona mejor

✅ **Días de alta volatilidad con retorno al rango** (más desvíos = más oportunidades)
✅ **Activos con alta liquidez** (SPY, QQQ, BTC/USDT, EUR/USD)
✅ **Después de un spike de volumen** (el spike revierte, el precio vuelve al VWAP)
✅ **Gap de apertura**: si el precio abre muy lejos del VWAP previo, a menudo rellena el gap

❌ **Días de trend fuerte** (el precio puede mantenerse lejos del VWAP todo el día)
❌ **Eventos macro** (FOMC, earnings): el VWAP se recalibra → señales inválidas
❌ **Pre/after market**: volumen bajo, el VWAP no es representativo

## Combinaciones

| Con plugin | Efecto |
|------------|--------|
| + Volatility Regime | Activar VWAP solo en regime "low" o "normal" — en crisis el VWAP no revierte |
| + ATR Stop Loss | Stop dinámico en vez de 1σ fijo |
| + Kelly Criterion | Sizing óptimo por trade |

## Timeframe óptimo

**5 minutos** es el estándar — suficiente para confirmar el desvío sin ser ruido puro como en 1m.

15 minutos da menos señales pero mayor calidad en mercados tranquilos.

## Notas aprendidas

<!-- El LLM actualiza esta sección con observaciones de ciclos reales -->
