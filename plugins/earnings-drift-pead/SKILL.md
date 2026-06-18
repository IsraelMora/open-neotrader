---
name: Earnings Drift (PEAD)
description: Post-Earnings Announcement Drift — las acciones con sorpresas positivas de EPS tienden a continuar subiendo 30-60 días tras el anuncio. Anomalía documentada desde 1968. Win rate ~65-70% en sorpresas grandes (>10%). Estrategia de medio plazo.
---

# Earnings Drift (PEAD)

## Base académica

**Ball & Brown (1968)**: primer estudio que documenta que las acciones con buenas sorpresas de earnings siguen subiendo después del anuncio. *Journal of Accounting Research*.

**Bernard & Thomas (1989)**: "Post-Earnings-Announcement Drift: Delayed Price Response or Risk Premium?" Documentan que el drift persiste décadas después de ser publicado — inversores subreaccionan sistemáticamente.

**Jegadeesh & Livnat (2006)**: actualización con datos modernos. El drift es mayor en:
- Empresas pequeñas y medianas (menos cobertura de analistas)
- Sorpresas que sorprenden incluso a los analistas más optimistas
- Primer trimestre tras un cambio de tendencia en earnings

## Por qué funciona

```
1. Inversores "anclan" su valoración a la estimación previa → subreacción inicial
2. Analistas actualizan estimaciones gradualmente → flujo de revisiones durante ~60 días
3. Instituciones acumulan gradualmente → no pueden entrar todo en el día del earnings
```

## Cálculo de la sorpresa

```
Sorpresa (%) = (EPS_reportado − EPS_estimado) / |EPS_estimado| × 100

Tiers:
  > +10%   → "large_beat"  → LONG  (conf ~80%)
  +5–10%   → "beat"        → LONG  (conf ~65%)
  -5–5%    → "inline"      → NEUTRAL
  -5–10%   → "miss"        → SHORT (conf ~65%)
  < -10%   → "large_miss"  → SHORT (conf ~80%)
```

## Confirmación de señal

Mejor cuando el precio TAMBIÉN confirma la sorpresa:

```
✅ Gap de apertura en la misma dirección que la sorpresa
✅ Volumen anómalo > 2× la media (instituciones reposicionándose)
✅ El gap NO se llena completamente en el mismo día

❌ Gap en dirección CONTRARIA a la sorpresa (potential "sell the news")
```

## Gestión de la posición

```
Entrada:   apertura o primer precio tras el earnings
Stop:      gap de apertura - 1.5 ATR (no dejar que el gap se llene)
Target:    mantener N días (no stop profit — el drift es gradual)
Salida:    a los N días o si hay otro earnings en el período
```

## Cuándo NO usar PEAD

❌ Acciones con cap < $1B (ilíquidas, gaps difíciles de ejecutar)
❌ Si el sector entero está en tendencia contraria a la señal
❌ En la semana previa a otro earnings de la misma empresa
❌ Si el VIX > 30 (el régimen de volatilidad supera cualquier señal idiosincrásica)

## Obtener datos de earnings

Este plugin requiere datos de earnings en el contexto (`earnings_events`). Fuentes:
- **LLM**: puede proporcionar earnings de empresas conocidas (para un universo pequeño)
- **Earnings calendar plugin** (futuro): API pública de earnings de Yahoo/Tiingo/Alpaca

## Señales que emite

```
pead_signal:
  action: "long" | "short"
  eps_surprise_pct: valor numérico
  surprise_tier: "large_beat" | "beat" | "miss" | "large_miss"
  hold_days: días de mantenimiento
  gap_pct: gap de apertura (si disponible)
  volume_ratio: volumen vs media 20d (si disponible)
  confidence: 0.65 - 0.90
```

## Combinaciones

| Con plugin | Efecto |
|------------|--------|
| + Kelly Criterion | Tamaño óptimo; PEAD tiene win rate conocido → Kelly directo |
| + Volatility Regime | No operar PEAD en régimen "crisis" |
| + ATR Stop Loss | Stop dinámico en vez de stop fijo debajo del gap |
| + Correlation Guard | Evitar 2 PEAD longs en el mismo sector simultáneamente |

## Notas aprendidas

<!-- El LLM actualiza con observaciones de ciclos reales -->
