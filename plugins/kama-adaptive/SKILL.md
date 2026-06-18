# KAMA — Kaufman Adaptive Moving Average

## Problema que resuelve
Los EMAs fijos tienen un dilema insuperable: un período corto captura tendencias pero genera whipsaws en laterales; uno largo filtra ruido pero llega tarde. KAMA resuelve esto adaptando automáticamente su velocidad al régimen de mercado.

## Cómo funciona

### Efficiency Ratio (ER)
```
ER = |Precio[0] - Precio[-n]| / Σ|Precio[i] - Precio[i-1]|
```
- ER = 1.0 → movimiento perfectamente direccional (sin ruido)
- ER = 0.0 → movimiento puramente caótico (precio sube y baja sin avanzar)
- ER práctica: > 0.6 = tendencial, < 0.3 = lateral

### Smoothing Constant
```
SC = [ER × (fast_sc - slow_sc) + slow_sc]²
KAMA[t] = KAMA[t-1] + SC × (Price[t] - KAMA[t-1])
```

Default: fast=2 barras (EMA rápida), slow=30 barras (EMA lenta).

## Reglas de señal
1. Solo genera señales cuando ER > 0.6 (régimen tendencial)
2. **BUY**: precio cruza KAMA hacia arriba con >0.1% de distancia
3. **SELL/EXIT**: precio cruza KAMA hacia abajo con >0.1% de distancia
4. En régimen lateral (ER < 0.3): no genera señales — complementa con estrategias de reversión

## Cuándo usar vs otras alternativas

| Situación | Mejor herramienta |
|-----------|------------------|
| Quieres seguir tendencias con poco ruido | **KAMA** |
| Mercado con tendencias largas y claras | EMA 9/21 |
| Quieres detectar el régimen actual | KAMA + Efficiency Ratio |
| Mercado lateral bien definido | Mean Reversion Z-Score |

## Referencia académica
Kaufman, P.J. (1995) *Smarter Trading*. McGraw-Hill. Capítulo 8: "Adapting to the Market".
Perry Kaufman (2013) *Trading Systems and Methods*, 5th Edition. Wiley.

Rendimiento histórico documentado (Kaufman 2013):
- KAMA supera al S&P 500 buy-and-hold en 15 de 20 años testados
- Max drawdown reducido ~30% vs EMA simple
- Win rate ~52-55% en índices, ~56-60% en activos tendenciales (forex, commodities)
