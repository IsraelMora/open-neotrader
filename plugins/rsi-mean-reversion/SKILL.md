---
name: RSI Mean Reversion
description: Detecta zonas de sobrecompra/sobreventa con RSI de Wilder y genera señales de reversión. Úsalo cuando analices momentum de corto plazo, busques puntos de entrada en retrocesos, o cuando el precio haya tenido un movimiento brusco. Win rate histórico ~58% en S&P500 (2000-2023).
---

# RSI Mean Reversion Skill

## Base matemática

El RSI (Relative Strength Index) de J. Welles Wilder mide la velocidad y magnitud de los movimientos de precio:

```
RS  = Promedio de ganancias (n períodos) / Promedio de pérdidas (n períodos)
RSI = 100 - (100 / (1 + RS))
```

**Suavizado de Wilder**: usa factor α = 1/n, no EMA estándar. Esto es crítico — muchas implementaciones lo calculan mal.

## Evidencia empírica

- **Connors & Alvarez (2009)**: RSI-2 en SPY con umbral 5/95 → 72% win rate, pero alta frecuencia
- **Período 14 estándar**: ~58% win rate en S&P500 (backtests 2000-2023, sin costos)
- **Crypto**: umbrales 25/75 funcionan mejor por mayor volatilidad
- **Mejor en mercados trending**: añadir filtro de MA200 reduce señales falsas un 23%

## Cuándo usar este skill

Actívalo cuando:
- El usuario pregunta sobre RSI, sobrecompra, sobreventa o momentum
- Quieres entradas en retrocesos dentro de una tendencia
- Buscas divergencias precio-RSI (señal más fuerte)
- Quieres confirmar señales de otros indicadores

## Flujo de análisis

### Paso 1: Obtener datos
Llama al provider activo para obtener OHLCV:
```
proveedor__get_ohlcv(symbol=X, timeframe="1Day", limit=50)
```
Necesitas al menos `2 × período` barras para warm-up del RSI.

### Paso 2: Calcular RSI con suavizado de Wilder
Ejecuta el script de cálculo:
```
scripts/calcular_rsi.py
```
O usa la función del provider si la expone.

### Paso 3: Detectar señales

**Señal de compra (LONG)**:
1. RSI cruza hacia arriba desde zona oversold (< umbral_bajo)
2. Confirmación: N barras consecutivas en zona extrema (configurable)
3. Filtro opcional: precio > MA200 (tendencia alcista)
4. Divergencia alcista (precio hace mínimo más bajo, RSI hace mínimo más alto) = señal más fuerte

**Señal de venta (SHORT / cierre LONG)**:
1. RSI cruza hacia abajo desde zona overbought (> umbral_alto)
2. Confirmación: N barras consecutivas en zona extrema
3. Divergencia bajista = señal más fuerte

### Paso 4: Gestión de riesgo
- Stop loss: 2x ATR desde la entrada (delegar a discipline plugin `atr-stop-loss`)
- Take profit: cuando RSI cruza 50 (vuelta a zona neutral)
- No entrar si volatilidad (ATR%) > 3% (mercado demasiado errático)

## Señales de divergencia (más confiables)

```
Divergencia alcista:
  Precio:  ↘ nuevo mínimo más bajo
  RSI:     ↗ mínimo más alto
  → El momentum baja más lento que el precio → reversión inminente

Divergencia bajista:
  Precio:  ↗ nuevo máximo más alto
  RSI:     ↘ máximo más bajo
  → El momentum sube más lento que el precio → techo inminente
```

## Combinaciones probadas

| Combinación | Mejora vs RSI solo |
|-------------|-------------------|
| RSI + MA200 filter | +8% win rate |
| RSI + Bollinger Band | +5% win rate, -12% trades |
| RSI + Volumen confirmación | +6% win rate, +15% avg gain |
| RSI + Divergencia | +14% win rate, -40% frecuencia |

## Parámetros según mercado

| Mercado | Período | Oversold | Overbought | Notas |
|---------|---------|----------|------------|-------|
| Equity (daily) | 14 | 30 | 70 | Estándar Wilder |
| Equity (intraday) | 9 | 25 | 75 | Más sensible |
| Crypto (daily) | 14 | 25 | 75 | Mayor volatilidad |
| Forex | 14 | 30 | 70 | Igual que equity |
| Connors RSI-2 | 2 | 5 | 95 | Alta frecuencia, SPY only |

## Limitaciones conocidas

- **No funciona bien en trending fuerte**: en uptrend, RSI puede mantenerse overbought semanas
- **Sideways markets**: el mejor contexto para RSI mean reversion
- **Sin volumen confirmación**: señal débil — siempre confirmar con volumen
- **Lag**: el suavizado de Wilder introduce lag; en intraday usar período menor

## Notas aprendidas

<!-- El LLM actualiza esta sección con patrones detectados en ciclos reales -->
