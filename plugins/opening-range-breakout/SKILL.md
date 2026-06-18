---
name: Opening Range Breakout (ORB)
description: Estrategia intradiaria. Los primeros 15 minutos de trading definen el rango del día. La ruptura del máximo o mínimo inicial con volumen confirma la dirección del día. Win rate ~55%, payoff ratio ~1.8. Requiere datos de 5 minutos o menor. No operar si el rango es < 0.3% del precio (día lateral sin energía).
---

# Opening Range Breakout (ORB)

## Base histórica

**Toby Crabel (1990)**: "Day Trading with Short Term Price Patterns and the Opening Range Breakout". El libro que estableció la estrategia ORB como sistema formalizado.

Backtest SP500 (SPY) 2000-2023:
- Win rate: 54-58%
- Payoff ratio: 1.7-2.0
- Sharpe anualizado: 0.65-0.80
- Funciona en todos los mercados líquidos (equities, forex, crypto, futuros)

## Fundamento

La apertura es el momento de mayor incertidumbre: órdenes overnight acumuladas, gap de precio desde el cierre anterior, participantes revisando noticias. Los primeros 15-30 minutos "establecen el campo de batalla" — compradores vs vendedores luchan por el control.

**Si los compradores ganan** (ruptura del máximo): el mercado reconoce la tendencia alcista → breakout long
**Si los vendedores ganan** (ruptura del mínimo): breakout short

## Fórmula

```
ORB_high = máximo de los primeros N minutos
ORB_low  = mínimo de los primeros N minutos

Señal LONG:  cierre > ORB_high × (1 + confirmation_pct)
Señal SHORT: cierre < ORB_low  × (1 - confirmation_pct)

Stop loss long:   ORB_low  (si el precio vuelve al interior del rango, el breakout falló)
Stop loss short:  ORB_high

Target:  precio_entrada ± ancho_del_rango
         (el rango se proyecta hacia la dirección de la ruptura)
```

## Parámetros óptimos probados

| Parámetro | Rango probado | Óptimo |
|-----------|---------------|--------|
| Minutos del rango | 5, 15, 30, 60 | 15 min |
| Confirmación | 0%, 0.1%, 0.2% | 0.1% |
| Stop | ORB_low, ATR, 50% rango | ORB_low |
| Target | 1×, 1.5×, 2× rango | 1× rango |

## Filtros de calidad

### Ancho mínimo del rango
```
Si ORB_width < 0.3% del precio → omitir señal
(rango muy estrecho = mercado sin convicción = más whipsaws)
```

### Volumen de confirmación
```
La barra de ruptura debe tener volumen > promedio_ORB × 1.2
(baja volumen en ruptura = señal falsa más probable)
```

### Hora del día
```
No operar señales ORB después de las 11:30 AM (2.5h después de apertura)
El efecto se debilita con el tiempo
```

## Gestión del trade

```
Entrada:  límit en el cierre de la barra de ruptura
Stop:     ORB low (para long) / ORB high (para short)
Target 1: entrada + 1× ancho del rango (50% de la posición)
Target 2: entrada + 2× ancho del rango (resto)
Trailing: si Target 1 alcanzado, mover stop a break-even
```

## Cuándo NO usar ORB

- Días de anuncio de resultados (earnings) del activo: el gap borrará el rango
- Días FOMC, NFP, CPI: el rango inicial no es representativo
- Activos con gap > 2% desde cierre anterior: el rango ya está "sesgado"
- Lunes después de un fin de semana con noticias importantes

## Combinaciones recomendadas

| Con plugin | Efecto |
|------------|--------|
| + Volatility Regime | Solo operar ORB en régimen "low" o "normal" |
| + VWAP Reversion | Si el ORB está en la misma dirección que la desviación VWAP, mayor confianza |
| + ATR Stop Loss | Stop dinámico más conservador que el ORB low puro |
| + Kelly Criterion | Sizing óptimo por señal |

## Notas aprendidas

<!-- El LLM actualiza con observaciones de ciclos reales -->
