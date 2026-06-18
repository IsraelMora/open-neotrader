---
name: Sector Rotation
description: Rotación mensual entre los 11 sectores SPDR del S&P 500 por momentum relativo con filtro de tendencia. Faber (2007): supera al mercado ~2% anual con menos del 50% del drawdown de buy-and-hold. Usar con universo de ETFs sectoriales (XLK, XLF, XLE, etc.).
---

# Sector Rotation

## Base académica

**Meb Faber (2007)**: "A Quantitative Approach to Tactical Asset Allocation". *Journal of Wealth Management*.

**Estrategia GTAA (Global Tactical Asset Allocation)**:
- Mantener las N clases de activos/sectores con mejor momentum
- Filtro: solo mantener si el precio está sobre la MA de 10 meses
- Rebalanceo mensual

### Evidencia histórica (1972-2023)

| Métrica | Buy & Hold S&P 500 | Sector Rotation |
|---------|--------------------|-----------------|
| Retorno anual | 10.5% | 12.2% |
| Máx Drawdown | -55% | -26% |
| Sharpe | 0.45 | 0.78 |
| Años en pérdida | 28% | 17% |

*Fuente: Faber (2007), replicado por AQR y múltiples estudios*

## Los 11 sectores SPDR (ETFs)

| ETF | Sector | Características |
|-----|--------|----------------|
| XLK | Tecnología | Mayor momentum en bull markets |
| XLV | Salud | Defensivo, baja correlación con ciclo |
| XLF | Financiero | Cíclico, correlación con tasas |
| XLY | Consumo Discrecional | Cíclico, beta alto |
| XLP | Consumo Básico | Defensivo, dividendos estables |
| XLE | Energía | Alta volatilidad, correlación con petróleo |
| XLI | Industriales | Cíclico, correlación con PIB |
| XLB | Materiales | Cíclico, correlación con commodities |
| XLRE | Inmobiliario | Correlación con tasas de interés |
| XLU | Utilities | Muy defensivo, cuasi-bono |
| XLC | Comunicaciones | Mix defensivo/growth |

## Algoritmo

### Paso 1: Calcular momentum de cada sector
```
momentum(sector_i) = retorno_12_meses(sector_i)
```
(O retorno de N meses según configuración)

### Paso 2: Aplicar filtro de tendencia
```
incluir(sector_i) = precio_actual > MA(10 meses)
```
Si el sector está en downtrend, no incluir aunque tenga buen momentum.

### Paso 3: Rankear y seleccionar
```
candidatos = sectores que pasan el filtro de tendencia
ranking = ordenar candidatos por momentum (mayor primero)
portafolio = top N (default: 3)
```

### Paso 4: Rebalancear mensualmente
```
Salir de: sectores que salieron del top N o que fallan el filtro
Entrar en: sectores nuevos en el top N
Igualar peso: 1/N del portfolio en cada sector seleccionado
```

## Señales que emite

```
sector_rotation_signal:
  action: "long" | "exit" | "hold"
  symbol: "XLK" | "XLV" | etc.
  rank: 1-11 (1 = mejor)
  momentum_12m: retorno de 12 meses
  above_ma: true/false
  weight_pct: peso recomendado en portfolio
```

## Gestión de transición

- **Salida gradual**: reducir posición 50% en mes 1, salir completamente en mes 2 (evita slippage en salidas abruptas)
- **Entrada**: esperar cierre mensual para confirmar señal (no operar intraday)
- **Empate de momentum**: desempatar por Sharpe ratio del período

## Combinaciones

| Con plugin | Efecto |
|------------|--------|
| + Volatility Regime | Si VIX > 25, reducir a 1-2 sectores defensivos |
| + Max Drawdown CB | Activar cash (salir de todo) si drawdown > 10% |
| + Kelly Criterion | Peso óptimo entre sectores vs igual peso |

## Variaciones conocidas

| Variación | Cambio | Efecto |
|-----------|--------|--------|
| Solo filtro MA (sin momentum) | Entrar/salir por MA | Reduce DD más que momentum puro |
| Momentum 1-12 (excluir 1m) | Skip último mes | Leve mejora en algunos períodos |
| 5 sectores en vez de 3 | Más diversificación | Menor alpha, menor volatilidad |

## Notas aprendidas

<!-- El LLM actualiza con observaciones de ciclos reales -->
