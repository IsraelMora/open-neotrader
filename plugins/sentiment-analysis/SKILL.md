---
name: Sentiment Analysis
description: Skill que analiza titulares de noticias financieras via NewsAPI. El LLM evalúa el sentimiento semánticamente y emite señales long/short basadas en consenso de noticias.
---

# Sentiment Analysis

## Por qué el sentimiento importa

Los mercados se mueven antes de que los fundamentales cambien — el sentimiento anticipa el precio. Estudios muestran:

- **AAII Sentiment Survey**: extremo pessimismo → +12% en 6 meses (contrarian)
- **News sentiment**: correlación positiva 0.35-0.55 con retornos de corto plazo (1-5 días)
- **Social sentiment + técnico**: mejora el win rate un 8-15% sobre técnico solo

## Flujo de análisis

```
1. NewsAPI → titulares y resúmenes de las últimas 24h para cada símbolo

2. LLM evalúa cada artículo:
   - "AAPL beats earnings, raises guidance +15%" → +0.85 (muy positivo)
   - "Fed signals more rate hikes, tech selloff" → -0.6 (negativo, sector amplio)
   - "AAPL opens new store in Tokyo" → +0.1 (neutral/ligeramente positivo)

3. Score compuesto ponderado por magnitud:
   composite = Σ(score_i × magnitud_i) / Σ(magnitud_i)

4. Si |composite| > min_score (default 0.6) y artículos >= min_articles:
   → Emitir señal long (bullish) o short (bearish)
```

## Diferencia entre análisis heurístico y LLM

| Método | Precisión | Costo |
|--------|-----------|-------|
| Heurístico (keywords) | ~60-65% | Gratis, instantáneo |
| LLM (Claude) | ~80-85% | Por llamada API |
| LLM + contexto de mercado | ~85-90% | Mayor contexto = mayor costo |

Este plugin usa LLM por defecto. El análisis heurístico es el fallback.

## Señales y su uso correcto

El sentimiento es un factor **complementario**, no standalone:

```
Señal técnica (EMA crossover) + Sentimiento positivo → REFUERZO (tamaño ×1.2)
Señal técnica (EMA crossover) + Sentimiento negativo → REDUCCIÓN (tamaño ×0.7)
Solo sentimiento positivo sin señal técnica → señal débil (confidence < 0.4)
```

## Configuración para NewsAPI gratuita

La capa gratuita de NewsAPI incluye:
- 100 requests/día
- Artículos con hasta 1 mes de antigüedad
- Sin datos en tiempo real (delay 15 min)

Con `symbols_per_cycle = 5` y `timeframe = "4h"`: 5 × 6 = 30 req/día → dentro del límite.

## Consideraciones importantes

1. **No operar solo con sentimiento** — correlación no es causalidad
2. **Efecto reflexivo**: el sentimiento muy extremo suele ser contrarian (pánico = suelo)
3. **Noticias falsas / ruido**: el LLM es robusto pero puede confundirse con sarcasmo o contexto implícito
4. **Delay de noticias**: en capa gratuita de NewsAPI, las noticias tienen 15 min de delay

## Notas aprendidas

<!-- El LLM actualiza con observaciones: qué noticias resultaron en señales acertadas -->
