---
name: claude-subscription
description: Usa la suscripción de Claude (Claude Code CLI) como backend del LLM en vez de una API key.
---

# Claude Subscription (CLI)

Plugin de tipo `extra` que **cambia el backend del orquestador LLM** de "API key" a
"suscripción de Claude". En vez de llamar a `api.anthropic.com` con una
`ANTHROPIC_API_KEY` (que se factura por token), la plataforma invoca el CLI de
Claude Code (`claude -p`) usando tu sesión OAuth ya autenticada.

## Por qué

Para una operación 24/7 de ingresos pasivos, el costo por token de la API puede
comerse el rendimiento. Con la suscripción, los ciclos del agente usan tu plan de
Claude Code en vez de cobrarte por llamada.

## Cómo funciona

Al activar este plugin, `LlmService` detecta `isExtraActive('claude-subscription')`
y enruta cada ciclo por `completeViaSubscription()`, que ejecuta:

```
claude --output-format text --model <modelo> [--append-system-prompt <system+skills>] -p <contexto>
```

- **No requiere** `ANTHROPIC_API_KEY`.
- El **modelo** se elige en *Configuración LLM* (`PATCH /llm/config { model }`):
  Haiku para ciclos baratos y frecuentes, Opus para decisiones pesadas.
- El system prompt y los skills activos viajan por `--append-system-prompt`;
  el contexto del ciclo va en `-p`.

## Requisitos

1. Tener el CLI `claude` instalado y autenticado (`claude` interactivo una vez para
   completar el login OAuth de tu suscripción).
2. Activar este plugin **o** poner `LLM_BACKEND=subscription` en `.env`.

## Gotchas

- El CLI corre en la capa NestJS (con red), **no** en el sandbox Python
  (aislado de red). El plugin en sí no llama a `claude`.
- Un ciclo por suscripción tarda más que la API (~1-2 min) y consume cuota de tu
  plan de Claude Code.
- Si el CLI falla (no autenticado, sin cuota), el ciclo cae al fail-safe del LLM.

## Herramienta disponible

### `subscription_status`
Devuelve el estado del backend de suscripción tal como lo ve la plataforma
(nombre del backend, modelo configurado y notas). No accede a la red.
