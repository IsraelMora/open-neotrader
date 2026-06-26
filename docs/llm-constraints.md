# OpenNeoTrader — Restricciones del LLM

## Principio fundamental: kernel neutral

El LLM en OpenNeoTrader es un **lector y consejero**, no un ejecutor.

El kernel (AgentsService) es **neutral por diseño**: no impone restricciones de riesgo ni
guardarraíles propios. La disciplina y el veto son responsabilidad exclusiva de los plugins
de tipo `discipline`, evaluados en la capa de veto (`_runVetoLayer()` en `agents.service.ts`).
Esta separación permite que distintos operadores configuren su propia política de riesgo
mediante plugins, sin parches en el núcleo.

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
      el aislamiento completo a nivel OS se aplica en F5 / despliegue en Docker)
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
     "tool_calls": []
   }
   Nota: tool_calls es actualmente siempre [] — el pipeline de ejecución de
   tool calls LLM→sandbox NO está implementado todavía (previsto para F2).
   AgentsService parsea texto estructurado; los tool calls nativos del LLM
   no se procesan en la versión actual.

4. SandboxGateway ejecuta las acciones resultantes en el sandbox Python

5. Resultado guardado en PostgreSQL (AuditEntry, NavSnapshot, AlertEntry)
```

## Veto y disciplina — mecanismo opt-in

El kernel no implementa ningún servicio de decisión ni guardarraíl de no-ampliación propios.
El control de riesgo se implementa mediante plugins de tipo `discipline`:

- Los plugins `discipline` se ejecutan en la capa de veto (`_runVetoLayer()`)
- Pueden aprobar, modificar o vetar señales pendientes (`pending_signals`)
- Si no hay ningún plugin `discipline` activo, no se aplica ningún veto
- Cada operador configura su política de riesgo instalando los plugins que necesita

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
   → Nota: este bloqueo es en-proceso Python (no a nivel OS). Un atacante con acceso nativo
     podría eludirlo. El aislamiento OS completo (Docker `--network=none`, seccomp) se
     aplica en despliegue (F5). En desarrollo bare-metal, `SANDBOX_STRICT=false` desactiva
     los guards con un aviso explícito en stderr.

3. **Acceso a archivos del host**: intentar abrir `/etc/passwd` u otras rutas del sistema
   → Mitigación: bajo `SANDBOX_STRICT=true`, `open()` está restringido a rutas bajo
     `NEUROTRADER_PLUGINS_DIR` (via `install_open_guard()` en `isolation.py`)

4. **Datos corruptos**: retornar un resultado con valores extremos
   → Mitigación: plugins `discipline` pueden vetar señales fuera de rango;
     la política de riesgo es responsabilidad del operador vía plugins, no del kernel

5. **Timing attacks**: tardar mucho para afectar el ciclo
   → Mitigación: timeout configurable por plugin, kill automático
     (`SANDBOX_CPU_SECONDS`, `SANDBOX_MEM_MB` via `resource` limits en runner.py)

6. **Acceso a secretos vía variables de entorno**
   → Mitigación: el sandbox no recibe `process.env` del host; solo recibe un conjunto
     explícito de variables de control (PATH, NEUROTRADER_PLUGINS_DIR, PYTHONPATH, etc.)
   → Las credenciales de proveedores se inyectan por llamada en el contexto de la request
     (`context.credentials`), no en el entorno del proceso (implementado en F1 / PR2)
