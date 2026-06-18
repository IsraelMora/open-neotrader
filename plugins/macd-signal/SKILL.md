# MACD Signal

## Descripción
MACD (Moving Average Convergence Divergence) es un indicador de seguimiento de tendencia y momentum creado por Gerald Appel en 1979. Es uno de los más usados a nivel global por su simplicidad y eficacia.

## Componentes
- **Línea MACD**: EMA(12) - EMA(26) del precio de cierre
- **Línea de señal**: EMA(9) de la línea MACD
- **Histograma**: MACD - Señal (mide la fuerza del movimiento)

## Señales generadas

### Cruce alcista (long)
- MACD cruza POR ENCIMA de la línea de señal
- Histograma pasa de negativo a positivo
- Indica aceleración del momentum alcista
- **Win rate histórico**: ~54% en tendencias claras, ~47% en rango

### Cruce bajista (short)
- MACD cruza POR DEBAJO de la línea de señal
- Histograma pasa de positivo a negativo
- Indica desaceleración del momentum alcista / inicio bajista

### Divergencia alcista (refuerzo de long)
- Precio hace nuevo mínimo, pero el histograma hace mínimo menos negativo
- Señal de agotamiento vendedor
- **Alta probabilidad de reversión**: ~62% en timeframe diario

### Divergencia bajista (refuerzo de short)
- Precio hace nuevo máximo, pero el histograma hace máximo menos positivo
- Señal de agotamiento comprador

## Configuración recomendada

| Mercado | Fast | Slow | Signal | Timeframe |
|---------|------|------|--------|-----------|
| Acciones | 12 | 26 | 9 | 1d |
| Crypto | 8 | 21 | 5 | 4h |
| Forex | 12 | 26 | 9 | 4h o 1d |

## Bases matemáticas
- EMA con factor de suavizado k = 2/(n+1)
- El histograma es la segunda derivada del precio (aceleración)
- Los cruces tienen mayor fiabilidad cuando ocurren lejos del cero (no en zona de consolidación)

## Filtros recomendados
1. **Tendencia superior**: Confirmar con EMA(200) — solo longs sobre EMA200, solo shorts bajo EMA200
2. **Zona de cruce**: Cruces en territorio positivo (alcista) o negativo (bajista) tienen más fiabilidad
3. **Volumen**: Cruce + incremento de volumen = señal más fuerte
4. **Régimen de volatilidad**: MACD underperforma en mercados laterales (usar `volatility-regime` plugin)

## Limitaciones conocidas
- Rezagado (lagging indicator) — los cruces ocurren después del inicio del movimiento
- Falsos positivos frecuentes en mercados laterales/rangos estrechos
- En activos muy volátiles (BTC, meme stocks), el histograma oscila sin señal limpia

## Integración con otros plugins
- Se combina con `ema-crossover-9-21` para confirmación de tendencia
- `signal-aggregator` puede ponderar MACD junto con RSI y Bollinger
- `stack-trend-following` usa MACD como uno de los 5 componentes del consenso
- `macro-calendar-guard` suprime señales MACD antes de eventos FOMC/CPI

## Parámetros configurables
- `fast_period` (default: 12)
- `slow_period` (default: 26)
- `signal_period` (default: 9)
- `require_crossover` (default: true) — solo señal en el momento del cruce
- `divergence_bars` (default: 14) — ventana de detección de divergencias
- `min_histogram` (default: 0.0) — filtro de histograma mínimo para reducir ruido
