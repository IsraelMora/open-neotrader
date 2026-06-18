# Ornstein-Uhlenbeck Mean Reversion

## ¿Por qué OU en lugar de Z-score simple?

El Z-score asume que las desviaciones de la media son independientes. El proceso OU captura la **memoria** del proceso: cuánto tarda el precio en volver al equilibrio.

| Característica | Z-score | Ornstein-Uhlenbeck |
|---|---|---|
| Velocidad de reversión | No captura | θ (estimado por MLE) |
| Half-life | No definido | ln(2)/θ días |
| Validación estadística | Ninguna | R², half-life bounds |
| Distribución estacionaria | Asumida | Estimada (σ_eq) |
| Señales en activos no estacionarios | Muchas (erróneas) | 0 (filtradas por R²) |

## Proceso

```
dX_t = θ(μ - X_t)dt + σ dW_t
```

**Estimación** (modelo discreto de Vasicek, OLS):
```
X_{t+1} = A·X_t + B + ε    →    θ = -ln(A)/Δt,  μ = B/(1-A)
```

**Z-score OU** (más preciso que el clásico):
```
Z = (X_t - μ) / σ_eq     donde σ_eq = σ/√(2θ)
```

## Señales

| Condición | Señal |
|---|---|
| Z < -2σ | **LONG** (infravalorado) |
| Z > +2σ | **SHORT** (sobrevalorado) |
| |Z| < 0.5σ | NEUTRAL (cerca del equilibrio) |
| R² < 0.30 | Sin señal (modelo no válido) |
| half-life < 2d o > 90d | Sin señal (fuera de rango) |

## Configuración

```toml
entry_sigmas        = 2.0    # sigmas para entrar
exit_sigmas         = 0.5    # sigmas para salir
min_half_life_days  = 2
max_half_life_days  = 90
min_r_squared       = 0.30
lookback            = 252
```

## Herramienta: `analyze_ou`

```json
{
  "symbol": "AAPL",
  "prices": [150.0, 151.2, ...],
  "config": { "entry_sigmas": 1.8 }
}
```

**Respuesta:**
```json
{
  "symbol": "AAPL",
  "signal": 1,
  "z_score": -2.34,
  "mu": 155.2,
  "half_life": 12.5,
  "r_squared": 0.67,
  "valid": true,
  "reason": "Z=-2.34 < -2.0σ. Half-life=12.5d"
}
```
