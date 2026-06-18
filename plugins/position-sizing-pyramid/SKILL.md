---
name: Position Sizing Pyramid
description: Disciplina de pirámide de Van Tharp — entra con fracción inicial del tamaño objetivo y añade tranches a medida que la posición avanza a favor. Reduce coste medio sin aumentar riesgo inicial. Usado por Ed Seykota, Stanley Druckenmiller.
---

# Position Sizing Pyramid

## Base académica y práctica

**Van Tharp (1999)** "Trade Your Way to Financial Freedom": el tamaño de posición es la variable más importante del trading — más que la entrada o la salida.

**Ed Seykota**: "The trend is your friend until it ends." Pirámide permite capturar grandes movimientos tendenciales añadiendo en confirmaciones.

**Por qué funciona matemáticamente**:
- El coste medio ponderado de la posición total NUNCA supera el precio de entrada inicial
- Sólo añades cuando el mercado te da la razón — autocorrelación positiva con trades ganadores
- El stop loss actualizado (trail) garantiza que el capital en riesgo total permanece controlado

## Algoritmo

### Configuración típica (3 tranches)

```
Tamaño objetivo total: 9% del capital
Tranche 1 (entrada):    40% × 9% = 3.6% @ precio_entrada
Tranche 2 (add #1):     30% × 9% = 2.7% @ precio_entrada + 1 ATR
Tranche 3 (add #2):     30% × 9% = 2.7% @ precio_entrada + 2 ATR
                        ────────────────────────────────────────
TOTAL máximo:                       9.0% del capital
```

### Gestión del stop loss

```
Entrada:    Stop inicial (definido por ATR-Stop-Loss)
Después de Add #1: mover stop al breakeven = precio_entrada − 0.5 ATR
Después de Add #2: trailing stop = precio_actual − 1 ATR
```

### Ventaja matemática

Si la posición NO avanza → nunca llegas a Add #1 → máxima pérdida = 3.6% del 9% objetivo
Si la posición SÍ avanza → adds confirmados por el mercado → captura movimiento con tamaño creciente

## Señales que emite

```
pyramid_plan (adjunto a señal de entrada):
  entry_tranche_size_pct: tamaño de la primera tranche
  remaining_tranches: [ {trigger_price, size_pct} ]

pyramid_add (para posición abierta):
  action: "long"
  tranche_number: 2 | 3 | ...
  size_pct: % del capital para este add
  new_stop: nuevo nivel de stop recomendado
```

## Cuándo usar

✅ Mercados tendenciales (momentum, breakout)
✅ Posiciones con stop definido por ATR
✅ Horizontes de semanas/meses

❌ Mean reversion (la reversión ya completó el movimiento)
❌ Scalping / operativa intradía muy rápida

## Combinaciones

| Con plugin | Efecto |
|------------|--------|
| + ATR Stop Loss | Define el ATR para calcular triggers de adds |
| + Kelly Criterion | Kelly determina el tamaño total; pirámide define cuándo entrar |
| + EMA Crossover | Señal de entrada + pirámide en seguimiento de tendencia |
| + Volatility Regime | En régimen "crisis": reducir a 1 sola tranche (sin pyramid) |

## Notas aprendidas

<!-- El LLM actualiza con observaciones de ciclos reales -->
