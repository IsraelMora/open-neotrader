---
name: Volatility Regime Detection
description: Detecta el régimen actual de volatilidad del mercado (tranquilo/elevado/crisis) y adapta las recomendaciones de estrategia. En volatilidad baja el momentum rinde mejor; en alta volatilidad el mean reversion rinde mejor. Cargar en todos los ciclos para calibrar la estrategia al entorno.
---

# Volatility Regime Detection

## Base académica

**Ang, Hodrick, Xing & Zhang (2006)**: el riesgo de volatilidad es sistemático y cotiza con una prima negativa — los activos que se comportan mal en alta volatilidad son más riesgosos y requieren mayor retorno esperado.

**Lo (2002)**: los mercados financieros tienen regímenes estadísticamente distintos. Cambiar de estrategia según el régimen mejora el Sharpe ~30%.

## Los 4 regímenes

| Régimen | VIX | Vol Realizada | Comportamiento óptimo |
|---------|-----|--------------|----------------------|
| **Tranquilo** | < 15 | Bajo percentil 30 | Momentum, trend following |
| **Normal** | 15-25 | Percentil 30-70 | Estrategias mixtas |
| **Elevado** | 25-40 | Percentil 70-90 | Mean reversion, reducir exposición |
| **Crisis** | > 40 | Percentil > 90 | Cash, activos refugio, circuit breaker |

## Indicadores usados

### 1. VIX (Volatility Index)
```
VIX = expectativa del mercado de volatilidad implícita a 30 días del S&P 500
Fuente: CBOE (símbolo ^VIX o VIX)

Interpretación:
  VIX < 12   = complacencia extrema (raro, señal de cuidado al alza)
  VIX 12-20  = normal/tranquilo
  VIX 20-30  = elevado, cautela
  VIX 30-40  = alta volatilidad
  VIX > 40   = crisis (COVID: 85, 2008: 89)
```

### 2. Volatilidad Realizada (RV)
```
RV_21d = sqrt(252) × std(log_returns_21d)

Esto es la volatilidad anualizada basada en los últimos 21 días de datos.
```

### 3. Percentil de Volatilidad Histórica
```
percentil = posición_relativa(RV_actual, RV_histórico_252d)

Percentil 80 → la volatilidad actual es mayor que el 80% de los días del año pasado
```

### 4. VIX Term Structure (avanzado)
```
VIX_3m / VIX_1m = ratio de contango/backwardation

Ratio > 1 (contango) = mercado espera que la volatilidad baje → tranquilo
Ratio < 1 (backwardation) = mercado espera que la volatilidad suba → alerta
```

## Adaptación de estrategias al régimen

### Régimen TRANQUILO (VIX < 15)
- **Habilitar**: Momentum Factor 12-1, EMA Crossover, Bollinger Squeeze
- **Aumentar**: tamaño de posición hasta kelly_fraction normal
- **Desactivar**: exceso de filtros defensivos
- **Por qué**: baja volatilidad → tendencias más persistentes → momentum funciona

### Régimen NORMAL (VIX 15-25)
- **Habilitar**: todas las estrategias sin modificación
- **Tamaño**: kelly_fraction normal
- **Filtros**: estándar

### Régimen ELEVADO (VIX 25-40)
- **Preferir**: RSI Mean Reversion, pullbacks a EMA
- **Reducir**: exposición al 50-75% del sizing normal
- **Evitar**: momentum puro (riesgo de momentum crash)
- **Por qué**: alta volatilidad → reversiones más frecuentes → momentum pierde edge

### Régimen CRISIS (VIX > 40)
- **Señal al circuit breaker**: activar máxima cautela
- **Reducir**: exposición al 0-25%
- **Buscar**: activos refugio (oro, USD, bonos del gobierno)
- **Por qué**: correlaciones se van a 1, stops saltan, iliquidez

## Señales que emite este skill

```
volatility_regime_signal:
  regime: "low" | "normal" | "high" | "crisis"
  vix: número actual
  rv_21d: volatilidad realizada 21 días
  rv_percentile: percentil histórico
  recommended_size_multiplier: 1.0 | 0.75 | 0.50 | 0.10
  preferred_strategies: ["momentum", "mean_reversion", "cash"]
  avoid_strategies: ["momentum_pure"]
```

## Activos refugio por régimen

| Crisis | Activos defensivos |
|--------|-------------------|
| Mercado bajista general | USD (DXY), Bonos 10Y (TLT), Oro (GLD) |
| Crisis crypto | BTC dominance ↑, USDT ↑ |
| Crisis geopolítica | Oro, CHF, JPY |
| Inflación + crisis | Energía (XLE), Materiales (XLB) |

## Combinaciones recomendadas

| Con plugin | Efecto |
|------------|--------|
| + Max Drawdown Circuit Breaker | El regime detector pre-avisa ANTES del circuit breaker |
| + Kelly Criterion | Ajustar kelly_fraction según régimen |
| + Momentum Factor 12-1 | Solo activar momentum en régimen tranquilo/normal |
| + RSI Mean Reversion | Activar preferentemente en régimen elevado |

## Notas aprendidas

<!-- El LLM actualiza esta sección con observaciones de ciclos reales -->
