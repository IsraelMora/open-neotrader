---
name: Max Drawdown Circuit Breaker
description: Disciplina de seguridad de última instancia. Detiene todo trading cuando la pérdida acumulada supera umbrales configurables. Tres niveles: Warning → Danger → Breaker (stop total). Análogo al circuit breaker de las bolsas.
---

# Max Drawdown Circuit Breaker

## Por qué es el plugin más importante

Sin este plugin, un algoritmo con un bug puede llevar la cuenta a cero en horas.
Con este plugin, el daño máximo está acotado matemáticamente.

> "The first rule of trading: don't lose money. The second rule: see rule 1."
> — Warren Buffett (adaptado)

## Los tres niveles

```
CAPITAL INICIAL: 10,000$

│ Precio      │ Pérdida │ Nivel    │ Acción                           │
│─────────────│─────────│──────────│──────────────────────────────────│
│ 9,500$     │  -5%    │ WARNING  │ Notificar; seguir operando        │
│ 9,000$     │ -10%    │ DANGER   │ Reducir tamaño al 50%; alertar    │
│ 8,000$     │ -20%    │ BREAKER  │ Cerrar todo; detener ciclos       │
```

## Recuperación

Cuando se activa el BREAKER:
1. Todas las posiciones se cierran (señal de exit forzada)
2. El scheduler de ciclos se detiene
3. El usuario recibe notificación urgente (Telegram si activo)
4. Para reactivar: el usuario debe confirmar manualmente
5. Período de reflexión recomendado: 24-48h (revisar logs, identificar causa)

## Configuración por perfil

| Perfil | Warning | Danger | Breaker | recovery_days |
|--------|---------|--------|---------|---------------|
| Ultra-conservador | 3% | 7% | 15% | 7 |
| Conservador | 5% | 10% | 20% | 3 |
| Moderado | 8% | 15% | 25% | 2 |
| Agresivo | 10% | 20% | 35% | 1 |

## Pérdida diaria vs acumulada

El circuit breaker monitorea **ambas**:

```
Pérdida ACUMULADA: drawdown desde el máximo histórico de la cuenta
→ Activa si el portafolio cae X% desde su máximo

Pérdida DIARIA: pérdida en las últimas 24h
→ Activa si el día fue especialmente malo
→ Generalmente a la mitad del umbral acumulado
```

## Posición en el pipeline

```
Todos los demás plugins (skills, disciplines) →
  Portfolio Risk Manager (limita tamaño) →
    Max Drawdown CB ← VETO FINAL (puede cancelar todo)
```

## Notas aprendidas

<!-- El LLM actualiza con observaciones: cuántas veces se activó y por qué causa -->
