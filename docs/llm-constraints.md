# NeuroTrader — Restricciones del LLM

## Principio fundamental

El LLM en NeuroTrader es un **lector y consejero**, no un ejecutor.

```
LO QUE PUEDE HACER EL LLM:
  ✓ Leer contexto de texto (noticias, eventos macro, resumen de portfolio)
  ✓ Devolver texto (análisis, justificación de decisión)
  ✓ Llamar tools declarados en el plugin activo (via tool call)
  ✓ Recibir el resultado de un tool call y continuar razonando

LO QUE NO PUEDE HACER EL LLM:
  ✗ Ejecutar código Python/JS/bash (no hay tool "execute_code")
  ✗ Llamar tools no declarados en el plugin activo
  ✗ Modificar directamente el portfolio (solo propone; Decision Service decide)
  ✗ Acceder a series de precios crudas (solo resúmenes)
  ✗ Leer/escribir archivos (solo a través de tools del plugin)
  ✗ Hacer peticiones HTTP (el sandbox bloquea la red)
```

## Flujo completo de una consulta LLM

```
1. AgentRunService construye el contexto:
   {
     "system": "Eres un auditor de trading. Solo puedes MANTENER o REDUCIR exposiciones...",
     "context": {
       "portfolio": { ... },          # resumen texto, no series
       "signals": "SPY trending +0.3, BTC vix_high -0.1...",
       "macro_events": "FOMC en 48h",
       "skills": "fomc_caution activo (0.95)"
     },
     "tools": [                        # solo los del plugin activo
       {
         "name": "propose_allocation",
         "description": "...",
         "parameters": { ... }
       }
     ]
   }

2. LlmProxyService envía a Claude/Gemini/OpenAI

3. Respuesta del LLM:
   {
     "text": "Dado el FOMC inminente, recomiendo reducir exposición...",
     "tool_calls": [
       { "name": "propose_allocation", "arguments": { "symbols": ["SPY"], ... } }
     ]
   }

4. ToolCallValidatorService valida:
   - ¿"propose_allocation" está en la lista de tools del plugin activo? ✓
   - ¿Los parámetros coinciden con el schema declarado? ✓
   - Si falla cualquier check → la tool call se ignora, se loguea el intento

5. SandboxGateway ejecuta propose_allocation en el sandbox Python

6. Resultado devuelto al LLM (si hay más tool calls) o al DecisionService

7. DecisionService aplica guardarraíl:
   - Si el LLM propone AUMENTAR una posición → se ignora (solo puede mantener/recortar)
   - Decisión final guardada en PostgreSQL
```

## Guardarraíl de no-ampliación (innegociable)

```typescript
// apps/api/src/agents/decision.service.ts
applyGuardrail(current: Allocation, proposed: Allocation): Allocation {
  const safe: Allocation = {};
  for (const [symbol, current_exp] of Object.entries(current)) {
    const proposed_exp = proposed[symbol] ?? 0;
    // Solo puede mantener o reducir, NUNCA ampliar
    safe[symbol] = Math.min(current_exp, proposed_exp);
  }
  // Símbolos nuevos que el LLM quiera añadir: descartados
  return safe;
}
```

## Inyección de plugins maliciosos — modelo de amenaza

Un plugin malicioso podría intentar:
1. **Inyección en el prompt**: retornar texto que manipule el comportamiento del LLM
   → Mitigación: el contexto enviado al LLM es construido por NestJS, no por el plugin
   → El plugin solo aporta los resultados de sus tool calls (estructura JSON tipada)

2. **Tool calls falsos**: declarar un tool "execute_arbitrary_code"
   → Mitigación: los tools del plugin son revisados en la verificación manual
   → En el sandbox, aunque el tool exista, no puede hacer network/subprocess

3. **Datos corruptos**: retornar un resultado de tool call con valores extremos
   → Mitigación: el DecisionService aplica el guardarraíl de no-ampliación y rangos válidos

4. **Timing attacks**: tardar mucho para afectar el ciclo
   → Mitigación: timeout configurable por plugin, kill automático
