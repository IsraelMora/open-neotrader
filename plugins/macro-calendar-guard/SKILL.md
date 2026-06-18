---
name: Macro Calendar Guard
description: Disciplina de seguridad que suprime o reduce posiciones en ventanas de alta incertidumbre macro (FOMC, CPI, NFP, BCE). Evita el slippage extremo y reversiones post-evento.
---

# Macro Calendar Guard

## Por qué evitar operar en eventos macro

Los eventos macro de alta volatilidad producen:
1. **Spike de spread bid/ask** — los market makers amplían spreads justo antes y durante el evento
2. **Deslizamiento extremo** — las órdenes se ejecutan lejos del precio esperado
3. **Reversión post-evento** — el precio se mueve violentamente y puede revertir en minutos
4. **Gaps en gráficos** — especialmente en forex y futuros

Estudios muestran que las estrategias algorítmicas que operan *alrededor* de eventos macro pierden entre 30-60% más que las que los evitan.

## Eventos cubiertos

| Evento | Impacto | Mercados | Frecuencia |
|--------|---------|----------|-----------|
| FOMC Meeting | Muy alto | Todo | 8 veces/año |
| US CPI | Alto | Todo | Mensual |
| Non-Farm Payrolls | Alto | Forex, Equities | Primer viernes/mes |
| ECB Rate Decision | Alto | Forex EUR | 8 veces/año |

## Ventanas de tiempo

```
Ejemplo para NFP (12:30 UTC primer viernes):

  08:30        11:30        12:30        14:30        16:30
    |            |            |            |            |
    |---ZONA GRIS (reducción)---|--BLACKOUT--|---ZONA GRIS---|
    
Zona gris  = 4h antes / 2h después (configurable)
Blackout   = 1h antes / 1h después (bloqueo total)
```

## Modo warn_only

Útil durante el setup inicial para observar cuántas señales se habrían suprimido sin afectar el trading real:

```toml
[config]
warn_only = true
```

## Inyección de eventos del LLM

El LLM puede añadir eventos no incluidos en el calendario embebido:
```json
{
  "name": "Fed Emergency Meeting",
  "date": "2026-06-15",
  "time_utc": "14:00",
  "category": "fed",
  "impact": "high"
}
```

## Filosofía de operación

> "En trading, el dinero que no pierdes vale más que el que ganas. Evitar las trampas macro es tan importante como encontrar las oportunidades."

Los mejores traders profesionales tienen calendarios macro marcados con semanas de antelación y reducen automáticamente el tamaño de sus posiciones en esas fechas.

## Notas aprendidas

<!-- El LLM actualiza con observaciones: qué eventos causaron mayor impacto en cada ciclo -->
