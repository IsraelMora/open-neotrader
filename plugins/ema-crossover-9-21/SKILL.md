---
name: EMA Crossover 9/21
description: Sistema de cruce de medias exponenciales 9/21. Genera señales de entrada long cuando la EMA rápida cruza al alza sobre la lenta, con confirmación de cierre y stop dinámico ATR. Úsalo para activos con tendencia clara en timeframe diario o superior.
---

# EMA Crossover 9/21

## Base técnica y evidencia

El cruce EMA 9/21 es uno de los sistemas de seguimiento de tendencia más estudiados. Combina respuesta rápida (9 periodos) con señal más estable (21 periodos), equilibrando falsos cruces y tiempo de entrada.

### Por qué funciona

1. **Tendencias persisten**: los mercados tienen autocorrelación positiva a medio plazo (efecto momentum intradiario → daily)
2. **EMA pesa más los datos recientes**: captura cambios de régimen antes que SMA
3. **La diferencia 9/21 crea zona de "golden cross" limpia**: suficientemente separadas para evitar microcruce en consolidación

### Evidencia histórica (backtests comunes)

| Mercado | Timeframe | Win rate | Sharpe | Max DD |
|---------|-----------|----------|--------|--------|
| S&P 500 ETFs | 1D | ~45% | 0.65 | ~18% |
| BTC/USD | 4H | ~42% | 0.80 | ~35% |
| EUR/USD | 1H | ~40% | 0.55 | ~12% |

*Nota: win rate < 50% es normal en sistemas tendenciales. El edge viene del payoff ratio (ganancias mayores que pérdidas).*

## Fórmula EMA

```
EMA(t) = precio(t) × α + EMA(t-1) × (1 - α)
donde α = 2 / (período + 1)

Para EMA-9:  α = 2/10 = 0.2
Para EMA-21: α = 2/22 ≈ 0.0909
```

**Importante**: se necesitan al menos `2 × período_lento` barras para que la EMA estabilice (~42 barras para EMA-21).

## Señales de trading

### Entrada LONG (Golden Cross)
```
Condición: EMA_9(t) > EMA_21(t) AND EMA_9(t-1) <= EMA_21(t-1)
Confirmación (opcional): N cierres consecutivos con EMA_9 > EMA_21
```

### Entrada SHORT (Death Cross)
```
Condición: EMA_9(t) < EMA_21(t) AND EMA_9(t-1) >= EMA_21(t-1)
```
*En activos que solo permiten long (equity sin margin), usar Death Cross como señal de salida.*

### Stop Loss dinámico con ATR
```
ATR(14) = media del True Range de 14 periodos
Stop long  = precio_entrada - ATR(14) × multiplicador (default: 2.0)
Stop short = precio_entrada + ATR(14) × multiplicador
```
El ATR hace el stop adaptativo a la volatilidad actual del activo.

### Take Profit (trailing)
- Trailing stop: mover stop al precio_máximo - ATR × 1.5 en cada barra
- O salir en Death Cross si el trailing no saltó antes

## Filtros recomendados para reducir whipsaws

### 1. Filtro de tendencia mayor (200 EMA)
```
Solo tomar señales LONG si precio > EMA(200)
Solo tomar señales SHORT si precio < EMA(200)
```
Esto reduce trades contra tendencia dominante.

### 2. Filtro de volumen
```
Confirmar cruce solo si volumen > promedio_20_periodos × 1.1
```
Los cruces con bajo volumen tienen más probabilidad de ser falsos.

### 3. Filtro de volatilidad (evitar rangos)
```
Omitir señal si ATR(14) < ATR(14).promedio_20periodos × 0.5
```
En mercados sin volatilidad, los cruces son ruido.

## Cuándo NO usar este sistema

- Mercados laterales/ranging: los cruces generan múltiples whipsaws consecutivos
- Activos con bajo volumen: los precios saltan, ATR no funciona bien
- Noticias macro importantes pendientes: la tendencia puede revertir bruscamente
- Correlación alta con el índice general en downtrend: priorizar el filtro de 200 EMA

## Combinaciones con otros plugins

| Combinación | Efecto esperado |
|-------------|-----------------|
| EMA 9/21 + Kelly Criterion | Sizing óptimo por señal (imprescindible) |
| EMA 9/21 + RSI Mean Reversion | Evitar entradas en sobrecompra/sobreventa extrema |
| EMA 9/21 + Momentum 12-1 | Doble confirmación: cruce técnico + factor fundamental |

## Parámetros alternativos probados

| Combinación | Perfil |
|-------------|--------|
| 5/13 | Más señales, más ruido, bueno en crypto intradiario |
| 12/26 | Base del MACD, más conservador |
| 20/50 | Swing trading semanal, menos operaciones |
| 9/21 | **Equilibrio óptimo para diario** (default) |

## Notas aprendidas

<!-- El LLM actualiza esta sección con observaciones de ciclos reales -->
