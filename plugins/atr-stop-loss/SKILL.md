---
name: ATR Dynamic Stop Loss
description: Disciplina de gestión de stops usando el Average True Range. Calcula stop inicial basado en volatilidad del activo y trailing stop que sigue al precio ganador. Elimina el 'I'll exit when llegue a X' arbitrario.
---

# ATR Dynamic Stop Loss

## Por qué ATR y no stops fijos

Un stop fijo del 2% en NVDA (volátil) se activa constantemente con el ruido diario.
El mismo 2% en JNJ (defensivo) puede ser demasiado amplio para su volatilidad real.

ATR resuelve esto: el stop se calibra a la volatilidad **actual** del activo.

```
ATR(14) de NVDA: 8$ (5% de movimiento diario normal)
Stop conservador: precio_entrada - 2.0 × 8 = 16$ por debajo
Stop agresivo:    precio_entrada - 1.5 × 8 = 12$ por debajo

ATR(14) de JNJ: 1.5$ (1% de movimiento diario normal)
Stop conservador: precio_entrada - 2.0 × 1.5 = 3$ por debajo
```

## Fórmula del ATR

```
True Range = max(
  high - low,
  |high - prev_close|,
  |low - prev_close|
)

ATR(14) = Media Exponencial(TR, 14 periodos)
```

## Stop inicial vs Trailing Stop

| Tipo | Cuándo usar | Comportamiento |
|------|-------------|---------------|
| Stop inicial | Al entrar | Fijo en precio calculado; nunca sube (ni baja para long) |
| Trailing stop | Cuando el precio gana | Se mueve con el precio; solo se mueve a favor |

```
Entrada AAPL @ 190, ATR=3.5, multiplicador=2.0
→ Stop inicial: 190 - 7 = 183

Precio sube a 200:
→ Trailing stop: 200 - 7 = 193 (sube con el precio)

Precio sube a 210:
→ Trailing stop: 210 - 7 = 203 (sigue subiendo)

Precio baja a 205:
→ Trailing stop: 203 (NO baja — protege ganancias)
→ Si precio toca 203: SALIR
```

## Multiplicadores recomendados

| Estrategia | Multiplicador ATR |
|-----------|------------------|
| Scalping (muy agresivo) | 1.0 - 1.5 |
| Swing trading estándar | 1.5 - 2.0 |
| Position trading | 2.0 - 3.0 |
| Largo plazo | 3.0 - 4.0 |

## Notas aprendidas

<!-- El LLM actualiza con observaciones sobre cuáles multiplicadores funcionan mejor por activo -->
