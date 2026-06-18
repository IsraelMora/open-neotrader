---
name: Signal Aggregator
description: Combina señales de múltiples skills mediante votación ponderada por confianza. Genera un consenso por símbolo, filtra ruido, y produce decisiones más robustas que cualquier skill individual. Disciplina clave para sistemas multi-estrategia.
---

# Signal Aggregator

## Por qué agregar señales

Un solo indicador tiene:
- RSI: ~55% win rate en condiciones ideales
- EMA Crossover: ~52% win rate
- Bollinger Squeeze: ~58% win rate

Combinados correctamente:
- Cuando todos apuntan en la misma dirección: ~70-75% win rate
- La confluencia de señales independientes **multiplica la evidencia estadística**

## Algoritmo de votación ponderada

```
Para cada símbolo:
  1. Recopilar todas las señales del ciclo (de todos los plugins activos)
  2. Filtrar las que no alcanzan min_confidence
  3. Calcular votos:
       voto_long  = Σ(conf_i)  para señales long
       voto_short = Σ(conf_i)  para señales short
       voto_exit  = Σ(conf_i)  para señales exit
  4. Ganador: la dirección con mayor peso
  5. Acuerdo: voto_ganador / (voto_long + voto_short + voto_exit) × 100
  6. Si acuerdo ≥ min_agreement_pct → emitir señal consenso
     Si no → ignorar (ruido / conflicto)
```

## Ejemplo

```
Señales para AAPL en un ciclo:
  EMA Crossover: long (conf=0.72)
  Bollinger Squeeze: long (conf=0.68)
  RSI Mean Reversion: long (conf=0.64)
  Volatility Regime: (no emite señal, modo normal)

Votos: long = 0.72 + 0.68 + 0.64 = 2.04  |  short = 0  |  exit = 0
Acuerdo: 100%
Confianza consenso: (0.72+0.68+0.64)/3 = 0.68

→ Consenso: LONG AAPL (conf=0.68, 100% acuerdo, 3 fuentes)
```

## Cuándo NO agregar

Pass-through automático (no se agregan, pasan directamente):
- `pairs_signal` — estrategia market-neutral, tiene su propia lógica
- `pead_signal` — señal de evento único, no combinar con técnico
- `pyramid_add` — decisión de gestión de posición ya abierta

## Señales que emite

```
consensus_signal:
  action: "long" | "short" | "exit"
  confidence: confianza ponderada del consenso
  agreement_pct: % de votos en la dirección ganadora
  contributing_signals: N señales que contribuyeron
  sources: ["ema-crossover-9-21", "bollinger-squeeze", ...]
```

## Combinaciones recomendadas

Este plugin debería estar activo junto a todos los skill plugins.
El orden correcto del pipeline:
```
Skills (emiten señales) →
  Signal Aggregator (consolida) →
    Disciplines (Kelly, ATR Stop, Pyramid) →
      Correlation Guard (filtra correladas) →
        Max Drawdown CB (último veto)
```

## Configuración óptima

| Escenario | min_agreement | require_min | conflict_resolution |
|-----------|--------------|-------------|---------------------|
| Conservative | 75% | 3 | skip |
| Balanced | 60% | 2 | skip |
| Aggressive | 55% | 2 | dominant |

## Notas aprendidas

<!-- El LLM actualiza con observaciones de ciclos reales -->
