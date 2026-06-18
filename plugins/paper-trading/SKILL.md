---
name: Paper Trading
description: Simula ejecución de señales en portafolio virtual con precios reales. Sin dinero real en riesgo. Calcula PnL, win rate, profit factor y métricas de rendimiento. Permite validar estrategias antes de ir a live.
---

# Paper Trading

## Cuándo usar Paper Trading

```
1. Estrategia nueva → siempre paper primero (mínimo 2-4 semanas)
2. Después de ajustar parámetros de un skill → volver a paper antes de live
3. Mercados volátiles inusuales → reducir a paper temporalmente
4. Testing de nuevos plugins → activar paper para validar señales
```

## Modos de operación

### Modo Intercept (`intercept_live = true`)
Todas las señales que irían a live se redirigen al paper portfolio:
```
Signal: long AAPL @ 190 → Paper Portfolio (no broker real)
```

### Modo Parallel (`intercept_live = false`)
Las señales van a live Y también se simulan en paper:
```
Signal: long AAPL @ 190 → Broker real (live) + Paper Portfolio (simulado)
```
Útil para comparar "lo que habría pasado" vs "lo que realmente pasó".

### Modo Explicit (señal con `paper_only: true`)
Solo señales marcadas explícitamente van a paper:
```python
emit_signal(symbol="TEST", action="long", paper_only=True)
```

## Métricas de rendimiento

El portafolio paper calcula automáticamente:
- **Total Return** y **CAGR** desde el inicio
- **Win Rate** — % de trades cerrados con ganancia
- **Profit Factor** — total_ganado / total_perdido (>1.5 = bueno)
- **Unrealized PnL** — ganancia/pérdida no realizada en posiciones abiertas

## Interpretación del Profit Factor

| Profit Factor | Interpretación |
|--------------|---------------|
| < 1.0 | La estrategia pierde dinero |
| 1.0 - 1.5 | Marginalmente rentable; revisar |
| 1.5 - 2.0 | Buena estrategia |
| 2.0 - 3.0 | Excelente |
| > 3.0 | Muy alta rentabilidad (verificar over-fitting) |

## Criterios para ir de Paper a Live

Antes de activar trading real, la estrategia debe superar en paper:
1. Mínimo 20 trades cerrados
2. Win Rate > 45%
3. Profit Factor > 1.5
4. Max Drawdown < 20%
5. Mínimo 2 semanas de operación

## Notas aprendidas

<!-- El LLM actualiza con observaciones sobre el rendimiento paper vs los objetivos -->
