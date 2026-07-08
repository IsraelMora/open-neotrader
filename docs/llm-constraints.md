# OpenNeoTrader — Restricciones del LLM

## Principio fundamental: kernel neutral

El LLM en OpenNeoTrader es un **lector y consejero**, no un ejecutor.

El kernel es neutral **a nivel de invocación de skills**: el LLM solo puede llamar funciones
whitelisteadas declaradas en el manifest del plugin activo. Pero el riesgo es **seguro por
defecto** (opt-out, no opt-in): `TradeIntentService` aplica un piso de riesgo del kernel
independiente de los plugins activos — un halt por drawdown máximo y un techo de tamaño por
operación (`max_position_pct`), tanto en el camino autónomo como en el de aprobación humana.
`exit`/`hold` siempre evitan cualquier gate (una posición siempre debe poder cerrarse). La
disciplina y el veto ADICIONALES son responsabilidad de los plugins de tipo `discipline`,
evaluados en la capa de veto (`_runVetoLayer()` en `agents.service.ts`): solo pueden AÑADIR
más restricción sobre el piso del kernel, nunca relajarlo. Esta separación permite que
distintos operadores configuren disciplina extra mediante plugins, sin parches en el núcleo.

```
LO QUE PUEDE HACER EL LLM:
  ✓ Leer contexto de texto (noticias, eventos macro, resumen de portfolio)
  ✓ Devolver texto (análisis, justificación de decisión)
  ✓ Proponer acciones a través de funciones declaradas en el plugin activo

LO QUE NO PUEDE HACER EL LLM:
  ✗ Ejecutar código Python/JS/bash (no hay tool "execute_code")
  ✗ Llamar funciones no declaradas en el manifest del plugin activo
  ✗ Acceder a series de precios crudas (solo resúmenes)
  ✗ Leer/escribir archivos (solo a través de tools del plugin)
  ✗ Hacer peticiones HTTP directas
     (bajo SANDBOX_STRICT=true, el sandbox bloquea la red en-proceso vía import guard;
      además SandboxGateway aplica aislamiento de red a nivel OS por subprocess con
      `unshare -rn` según SANDBOX_NETNS_ISOLATION — solo el modo `require` es garantía
      dura; `auto` degrada con warning si el host no lo soporta)
```

## Flujo completo de una consulta LLM

```
1. AgentsService construye el contexto:
   {
     "system": "...",
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

2. LlmService envía a Claude/Gemini/OpenAI/OpenRouter

3. Respuesta del LLM:
   {
     "text": "Dado el FOMC inminente, recomiendo reducir exposición...",
     "tool_calls": [ { "name": "propose_allocation", "arguments": { ... } } ]
   }
   Los tool calls nativos del LLM SÍ se ejecutan: runGovernedTurn()
   (agents.service.ts) corre un loop ReAct acotado. En cada iteración
   (_runSingleIteration) los tool calls se validan contra la whitelist
   (_validateToolCalls: manifests de los plugins activos + KERNEL_TOOL_REGISTRY)
   y solo los aprobados se ejecutan (_executeToolCalls). Límites: máximo de
   iteraciones (REACT_MAX_TURNS, configurable por KV) y presupuesto
   anti-amplificación de tool calls compartido entre TODAS las iteraciones
   del turno (REACT_MAX_TOOL_CALLS, default 3). Un tool call no declarado en
   el manifest de un plugin activo ni en el registro del kernel se descarta.

4. SandboxGateway ejecuta los tool calls aprobados en el sandbox Python

5. Resultado auditado en SQLite vía Prisma + better-sqlite3
   (AuditEntry, NavSnapshot, AlertEntry)
```

## Veto y disciplina — piso del kernel + opt-in

El kernel ya aplica un piso de riesgo obligatorio vía `TradeIntentService` (halt por drawdown
máximo, techo de tamaño por operación) independientemente de qué plugins estén activos. Sobre
ese piso, la disciplina ADICIONAL se implementa mediante plugins de tipo `discipline`:

- Los plugins `discipline` se ejecutan en la capa de veto (`_runVetoLayer()`)
- Pueden aprobar, modificar o vetar señales pendientes (`pending_signals`), siempre por encima
  del piso del kernel — nunca pueden relajarlo
- Si no hay ningún plugin `discipline` activo, sigue aplicándose el piso del kernel (drawdown +
  tamaño por operación); solo se pierde la disciplina extra opt-in
- Cada operador configura disciplina adicional instalando los plugins que necesita

Ejemplo de plugin discipline activado:

```
on_cycle (plugins skill) → pending_signals[]
  → _runVetoLayer() invoca on_cycle de plugins discipline
    → VetoSummary: { proposed, approved, vetoed }
  → Solo las señales aprobadas llegan al LLM
```

## Inyección de plugins maliciosos — modelo de amenaza

Un plugin malicioso podría intentar:

1. **Inyección en el prompt**: retornar texto que manipule el comportamiento del LLM
   → Mitigación: el contexto enviado al LLM es construido por NestJS, no por el plugin
   → El plugin solo aporta los resultados de sus funciones (estructura JSON tipada)

2. **Acceso a red desde el sandbox**: importar `requests`, `socket`, etc.
   → Mitigación: bajo `SANDBOX_STRICT=true`, `isolation.py` bloquea en-proceso los módulos
     de red (`socket`, `requests`, `urllib`, `http`, `subprocess`, etc.) antes de cargar
     cualquier código de plugin
   → Nota: este bloqueo es en-proceso Python (advisory) — un atacante con acceso nativo
     podría eludirlo. El aislamiento a nivel OS lo aplica `SandboxGateway` por subprocess
     con `unshare -rn` (network namespace sin privilegios), controlado por
     `SANDBOX_NETNS_ISOLATION`: `require` es garantía dura (falla el arranque si no está
     disponible); `auto` (default) degrada silenciosamente a solo-warning si el host no lo
     soporta; `off` lo desactiva. En desarrollo bare-metal, `SANDBOX_STRICT=false` desactiva
     los guards en-proceso con un aviso explícito en stderr.

3. **Acceso a archivos del host**: intentar abrir `/etc/passwd` u otras rutas del sistema
   → Mitigación: bajo `SANDBOX_STRICT=true`, `open()` está restringido a rutas bajo
     `NEUROTRADER_PLUGINS_DIR` (via `install_open_guard()` en `isolation.py`)

4. **Datos corruptos**: retornar un resultado con valores extremos
   → Mitigación: el piso de riesgo del kernel (`TradeIntentService`: halt por drawdown,
     techo de tamaño por operación) acota el daño aunque no haya plugins; además los
     plugins `discipline` pueden vetar señales fuera de rango por encima de ese piso

5. **Timing attacks**: tardar mucho para afectar el ciclo
   → Mitigación: timeout configurable por plugin, kill automático
     (`SANDBOX_CPU_SECONDS`, `SANDBOX_MEM_MB` via `resource` limits en runner.py)

6. **Acceso a secretos vía variables de entorno**
   → Mitigación: el sandbox no recibe `process.env` del host; solo recibe un conjunto
     explícito de variables de control (PATH, NEUROTRADER_PLUGINS_DIR, PYTHONPATH, etc.)
   → Las credenciales de proveedores se inyectan por llamada en el contexto de la request
     (`context.credentials`), no en el entorno del proceso (implementado en F1 / PR2)
