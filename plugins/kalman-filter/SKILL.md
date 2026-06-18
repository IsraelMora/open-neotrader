# Kalman Filter Trend Following

## ¿Por qué Kalman en lugar de EMA?

| Característica | EMA | Kalman |
|---|---|---|
| Peso de observaciones | Fijo (α) | Adaptativo (K_t) |
| Convergencia | Asintótica | Óptima (MMSE) |
| Parámetros | 1 (período) | 2 (Q, R) — interpretables físicamente |
| Respuesta a régimen | Fija | Q/R adapta automáticamente |
| Incertidumbre del estado | No estima | Sí (varianza P_t) |

La **ganancia de Kalman** K ∈ [0,1] varía en cada paso:
- K alto → el filtro confía en las nuevas observaciones (precio ruidoso)
- K bajo → el filtro confía en el modelo (precio estable)

## Modelo

```
Estado oculto:  x_t = x_{t-1} + w_t    (w ~ N(0, Q))
Observación:    z_t = x_t + v_t         (v ~ N(0, R))
```

**Interpretación de Q y R:**
- Q grande: la tendencia cambia rápido (crypto volátil) → filtro reactivo
- R grande: el precio tiene mucho ruido → filtro suave

## Señales

| Condición | Señal |
|---|---|
| Precio < Kalman × (1 - threshold) Y tendencia UP | **LONG** |
| Precio > Kalman × (1 + threshold) Y tendencia DOWN | **SHORT** |
| Precio ≈ Kalman (< threshold/2) | NEUTRAL |

La condición de tendencia evita señales contradictorias.

## Configuración

```toml
process_noise     = 0.01   # Q (sugerido: 0.001 para activos estables, 0.1 para crypto)
observation_noise = 1.0    # R
initial_variance  = 1.0    # P_0
entry_threshold   = 0.002  # 0.2% desvío mínimo
min_observations  = 30
```

## Herramienta: `analyze_kalman`

```json
{
  "symbol": "BTC-USD",
  "prices": [45000, 45200, ...],
  "config": { "process_noise": 0.05, "observation_noise": 0.5 }
}
```

**Respuesta:**
```json
{
  "symbol": "BTC-USD",
  "signal": 1,
  "kalman_estimate": 45100.0,
  "deviation_pct": -0.0022,
  "trend": "up",
  "kalman_gain": 0.0099,
  "reason": "Precio 44900 por debajo de Kalman 45100 (-0.44%) en tendencia UP"
}
```
