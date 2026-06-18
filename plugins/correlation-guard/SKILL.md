---
name: Correlation Guard
description: Disciplina que cancela señales si el activo tiene correlación alta (>0.7) con posiciones ya abiertas. Previene la acumulación de riesgo disfrazada de diversificación.
---

# Correlation Guard

## El problema de la correlación oculta

Comprar NVDA + AMD + MRVL + AVGO parece diversificación en semiconductores.
En realidad, tienen correlación 0.85-0.95 entre sí. En un crash de sector, **todas caen juntas**.

Este plugin lo detecta y bloquea la acumulación de posiciones altamente correladas.

## Correlación de Pearson

```python
r = Σ[(X_i - μ_X)(Y_i - μ_Y)] / (σ_X × σ_Y)

r ∈ [-1, 1]
r = 0.9 → movimiento casi idéntico
r = 0.7 → alta correlación (umbral por defecto)
r = 0.5 → correlación moderada
r < 0.3 → baja correlación → OK para diversificar
```

## Regla de bloqueo

```
Si una señal de NUEVO activo A tiene:
  correlación(A, B) > 0.7  donde B es una posición ya abierta
→ BLOQUEAR señal de A (ya tenemos exposición similar via B)

Si la correlación es 0.5-0.7:
→ ADVERTIR pero permitir (zona gris)
```

## Casos prácticos

| Par | Correlación típica | Resultado |
|-----|-------------------|-----------|
| NVDA / AMD | 0.85-0.92 | Bloqueado |
| QQQ / SPY | 0.88-0.95 | Bloqueado |
| SPY / GLD | 0.05-0.25 | Permitido (diversifica) |
| BTC / ETH | 0.75-0.90 | Bloqueado |
| BTC / GLD | 0.15-0.40 | Permitido |
| EUR/USD / GBP/USD | 0.70-0.85 | Bloqueado |

## Excepción: Pairs Trading

Los signals de pairs-trading son deliberadamente correlados (eso es el punto).
Este plugin hace pass-through de señales de tipo `long_spread` / `short_spread` — no las filtra.

## Notas aprendidas

<!-- El LLM actualiza con observaciones sobre correlaciones observadas en ciclos reales -->
