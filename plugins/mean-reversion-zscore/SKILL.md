---
name: Mean Reversion Z-Score
description: Detecta desviaciones estadísticas del precio respecto a su media histórica. Z-Score > 2σ indica sobreextensión con alta probabilidad de reversión. Basado en Jegadeesh (1990) y Lo & MacKinlay (1988). Complementa estrategias de momentum.
---

# Mean Reversion Z-Score

## Base académica

**Jegadeesh (1990)**: "Evidence of Predictable Behavior of Security Returns" (*Journal of Finance*).
Retornos pasados predicen retornos futuros a corto plazo EN SENTIDO CONTRARIO (1-3 meses).
Diferente al momentum que funciona en horizontes de 3-12 meses.

**Lo & MacKinlay (1988)**: "Stock Market Prices Do Not Follow Random Walks".
El varianza ratio test demuestra que los precios tienen autocorrelación negativa a corto plazo → reversión explotable.

**Por qué la media actúa como atractor**:
- Market makers y arbitrajistas compran cuando el precio cae "demasiado"
- Algoritmos de rebalanceo institucional venden activos que suben "demasiado"
- El Z-Score cuantifica ese "demasiado" en unidades estadísticas

## Cálculo

```
media_N = Σ(precio_t) / N         (últimos N días, default 20)
std_N   = σ de los últimos N días
Z_t     = (precio_t − media_N) / std_N

Señal:
  Z < −2.0  → LONG  (precio estadísticamente barato)
  Z > +2.0  → SHORT (precio estadísticamente caro)
  |Z| < 0.5 → EXIT  (precio volvió a la media)
```

## Umbrales y probabilidades estadísticas

| Z-Score | Percentil | Prob. reversión (empírica) |
|---------|-----------|---------------------------|
| ±1.0 σ  | 84%       | ~55%                      |
| ±1.5 σ  | 93%       | ~62%                      |
| ±2.0 σ  | 97.5%     | ~70%                      |
| ±2.5 σ  | 99.4%     | ~78%                      |
| ±3.0 σ  | 99.87%    | ~85%                      |

*Nota: probabilidades históricas en acciones S&P 500 (2000-2024)*

## Señales que emite

```
mean_reversion_signal:
  action: "long" | "short"
  z_score: valor numérico (e.g., -2.34)
  price: precio actual
  mean: media del período
  std: desviación estándar
  confidence: 0.6 - 0.95

mean_reversion_exit:
  action: "exit"
  z_score: valor al salir
  reason: "Z-Score volvió a zona neutral"
```

## Cuándo funciona mejor

✅ Activos con alta liquidez (difícil manipulación)
✅ Mercados laterales / baja tendencia
✅ Acelerados por noticias temporales (earnings, macro)
✅ Lookback 15-30 días

❌ Mercados en tendencia fuerte (el Z-Score puede mantenerse extremo semanas)
❌ Pequeñas caps con baja liquidez
❌ Momentos de cambio de régimen (rompe la estacionariedad)

## Filtros recomendados

```
1. Volatility Regime: solo operar mean reversion en régimen "normal" o "low"
   En "crisis": la distribución cambia, los Z-Scores pierden significado

2. Volume filter: Z-Score extremo SIN volumen elevado → más fiable
   Z-Score extremo CON volumen muy alto → puede ser ruptura, no reversión

3. Sector check: confirmar que otros activos del sector NO muestran el mismo Z
   Si todos el sector tienen Z<-2 → puede ser movimiento sectorial, no reversión individual
```

## Combinaciones

| Con plugin | Efecto |
|------------|--------|
| + Volatility Regime | Solo activa en régimen normal/bajo |
| + Correlation Guard | Evita entrar en 2 longs correlacionados simultáneos |
| + Kelly Criterion | Tamaño óptimo basado en historial de reversiones |
| + ATR Stop Loss | Stop basado en ATR, no fijo, para aguantar el ruido |

## Notas aprendidas

<!-- El LLM actualiza con observaciones de ciclos reales -->
