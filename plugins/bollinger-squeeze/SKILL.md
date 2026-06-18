---
name: Bollinger Band Squeeze
description: Detecta compresión de volatilidad entre Bandas de Bollinger y Keltner Channel. Genera señales de ruptura cuando la energía acumulada se libera. Alta precisión en squeezes de ≥5 barras con momentum claro. No operar sin confirmar dirección del momentum.
---

# Bollinger Band Squeeze

## Base técnica

**Concepto**: la volatilidad de los mercados es cíclica — períodos de expansión siguen a períodos de compresión. El squeeze detecta la compresión y espera la ruptura.

**Método TTM Squeeze** (Carter 2002):
- **Squeeze**: Bandas de Bollinger están *dentro* del Keltner Channel
- **Ruptura**: BB sale del KC → liberación de energía → movimiento direccional fuerte

### Por qué funciona estadísticamente
- Volatilidad baja → opciones baratas → momento de comprar/vender antes de la expansión
- Los grandes movimientos (>5% en un día) casi siempre van precedidos de un squeeze de baja volatilidad
- Las bandas de BB comprimen cuando no hay acuerdo entre compradores y vendedores → ruptura decide la dirección

## Fórmulas

### Bollinger Bands
```
SMA_n   = media(close, N)  [N=20]
σ_n     = desviación estándar(close, N)
BB_up   = SMA_n + 2 × σ_n
BB_low  = SMA_n - 2 × σ_n
```

### Keltner Channel
```
EMA_n   = media exponencial(close, N)
ATR_n   = Average True Range(N)
KC_up   = EMA_n + 1.5 × ATR_n
KC_low  = EMA_n - 1.5 × ATR_n
```

### Condición de Squeeze
```
Squeeze activo si:  BB_up ≤ KC_up  AND  BB_low ≥ KC_low
```

### Indicador de Momentum
```
Momentum = precio_actual - media(regresión_lineal(close, N))
Positivo → precio por encima de tendencia lineal → alcista
Negativo → precio por debajo de tendencia lineal → bajista
```

## Señales de trading

### Señal LONG (Ruptura alcista)
```
Condición:
  1. Squeeze estaba activo ≥5 barras
  2. Esta barra: BB_up > KC_up (ruptura)
  3. Momentum positivo y creciente

Entrada:    cierre de la barra de ruptura
Stop loss:  KC_low actual (el Keltner se convierte en soporte)
Target:     ancho del BB proyectado desde el punto de ruptura
```

### Señal SHORT (Ruptura bajista)
```
Condición:
  1. Squeeze activo ≥5 barras
  2. Ruptura con BB_low < KC_low
  3. Momentum negativo y decreciente

Solo para mercados que lo permiten (crypto, forex, futuros).
En equity solo long: usar como señal de SALIDA de posición larga.
```

### No operar si
- Squeeze duró < 5 barras: insuficiente energía acumulada
- Momentum plano o sin dirección clara
- Volumen por debajo de la media en la barra de ruptura

## Gestión de la posición

### Stop loss
```
Opción A: KC_low en el momento de la ruptura
Opción B: ATR Stop Loss plugin (más dinámico)
Opción C: mínimo de las 3 barras anteriores al breakout
```

Recomendación: **Opción A** — el KC actúa como soporte natural tras la ruptura.

### Take profit
```
Target mínimo = ruptura + (BB_up - BB_low) en el momento del squeeze
Target amplio = 2× el ancho del BB

Alternativa: trailing stop con ATR (mover stop al alza en cada barra)
```

## Timeframes óptimos

| Timeframe | Squeeze típico dura | Movimiento esperado |
|-----------|--------------------|--------------------|
| 1D        | 5-20 días          | 5-15% del precio   |
| 4H        | 10-30 barras       | 2-8%               |
| 1H        | 15-40 barras       | 1-4%               |
| 15m       | Mucho ruido, no recomendado para principiantes |

## Combinaciones probadas

| Con plugin | Efecto |
|------------|--------|
| + EMA 9/21 | Confirmar dirección: solo operar squeeze si EMA apunta en misma dirección |
| + Momentum 12-1 | Elegir los squeezes en activos con momentum fundamental alto |
| + Kelly Criterion | Sizing óptimo con el R/R del squeeze |
| + ATR Stop Loss | Stop dinámico en lugar del KC estático |

## Notas aprendidas

<!-- El LLM actualiza esta sección con observaciones de ciclos reales -->
