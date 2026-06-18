---
name: rsi-analysis
description: Analiza el RSI (Relative Strength Index) para detectar zonas sobrecompradas/sobrevendidas y generar señales de reversión. Úsalo cuando analices momentum o cuando el usuario mencione RSI, sobrecompra, sobreventa o señales de reversión.
---

# RSI Analysis Skill

## Cuándo usar este skill

Activa este skill cuando necesites:
- Evaluar si un activo está sobrecomprado (RSI > 70) o sobrevendido (RSI < 30)
- Generar señales de entrada/salida basadas en divergencias RSI
- Combinar RSI con niveles de soporte/resistencia

## Flujo de trabajo

1. Llama a `[provider-plugin]__get_ohlcv` para obtener datos de precio
2. Calcula RSI con período 14 (estándar) o ajusta según la disciplina activa
3. Evalúa señales:
   - RSI < 30 + divergencia alcista → señal de compra potencial
   - RSI > 70 + divergencia bajista → señal de venta potencial
4. Confirma con volumen y tendencia macro antes de emitir decisión

## Parámetros recomendados

| Mercado  | Período RSI | Umbral bajo | Umbral alto |
|----------|-------------|-------------|-------------|
| Equity   | 14          | 30          | 70          |
| Crypto   | 14          | 25          | 75          |
| Intraday | 9           | 20          | 80          |

## Notas aprendidas

<!-- El LLM actualiza esta sección tras cada ciclo con patrones detectados -->
