---
name: Portfolio Risk Manager
description: Control de riesgo a nivel de cartera completa. Limita exposición total, concentración por activo/sector, número de posiciones y liquidez mínima. Disciplina transversal que actúa DESPUÉS de todos los skills y ANTES de la ejecución.
---

# Portfolio Risk Manager

## Diferencia con otros plugins de riesgo

| Plugin | Actúa sobre | Cuándo |
|--------|------------|--------|
| Kelly Criterion | Tamaño individual | Al generar señal |
| ATR Stop Loss | Salida individual | Al gestionar posición |
| Position Sizing Pyramid | Adds a ganadoras | Al añadir tranches |
| Correlation Guard | Señales correladas | Al generar señal |
| **Portfolio Risk Manager** | **Cartera completa** | **Antes de ejecutar** |
| Max Drawdown CB | Pérdida acumulada | En ciclo |

## Límites que controla

```
1. Exposición total: no más del X% del capital invertido simultáneamente
   (el resto = buffer de liquidez para oportunidades y emergencias)

2. Posición individual máxima: cap en X% por activo
   (previene "all-in" en un solo trade)

3. Número máximo de posiciones: no abrir más de N posiciones
   (diversificación controlada)

4. Exposición por sector/clase de activo: no más del X% en tech, crypto, etc.
   (previene concentración sectorial)

5. Liquidez mínima: mantener al menos X% en efectivo
   (siempre disponible para margin calls o oportunidades urgentes)
```

## Flujo de ajuste de señales

```
Señal entrante: long NVDA 12%

1. ¿Hay capacidad de posiciones? (actual=8, max=10) → SÍ
2. ¿El tamaño 12% supera el máximo individual (15%)? → NO
3. ¿La exposición total permitiría 12% más? → actual=65%, max=80% → disponible=15% → SÍ
4. ¿Quedaría suficiente liquidez? → 100-65-12=23% > min_cash 20% → SÍ

→ Señal: long NVDA 12% (sin ajuste)
```

```
Señal entrante: long AAPL 20%

1. ¿Hay capacidad de posiciones? → SÍ
2. ¿El tamaño 20% supera el máximo individual (15%)? → SÍ → ajustar a 15%
3. ¿La exposición total permitiría 15% más? → actual=75%, max=80% → disponible=5% → ajustar a 5%
4. ¿Quedaría suficiente liquidez? → 100-75-5=20% = min_cash → OK

→ Señal: long AAPL 5% (reducida por exposición total)
→ Nota: "tamaño reducido: max individual 15% → exposición total disponible 5%"
```

## Posición en el pipeline de disciplinas

```
Skills (emiten señales) →
  Signal Aggregator →
    Kelly Criterion (tamaño inicial) →
      ATR Stop Loss (añade stops) →
        Correlation Guard →
          Portfolio Risk Manager ← AQUÍ (ajuste global final)
            Max Drawdown CB (veto de emergencia)
```

## Configuración para diferentes perfiles

| Perfil | max_exposure | max_positions | min_cash | max_single |
|--------|-------------|--------------|---------|------------|
| Conservador | 60% | 6 | 40% | 10% |
| Moderado | 75% | 10 | 25% | 15% |
| Agresivo | 85% | 15 | 15% | 20% |

## Notas aprendidas

<!-- El LLM actualiza con observaciones de ciclos reales -->
