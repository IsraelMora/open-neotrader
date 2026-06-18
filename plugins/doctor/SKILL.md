# Doctor — Diagnóstico del Sistema

Plugin de tipo `extra` que actúa como **watchdog al inicio de cada ciclo**. Verifica que el entorno está en condiciones antes de que el agente tome decisiones.

## Checks implementados

| Check | Descripción | Impacto si falla |
|---|---|---|
| `plugin_files` | manifest.toml presente para cada plugin activo | Warning en log |
| `credentials` | Variables de entorno requeridas presentes | Warning (o abort si `fail_on_missing_credentials=true`) |
| `context_health` | Tamaño del contexto < 100KB, pending_signals es lista | Warning en log |

## Integración

El hook `hooks/cycle.py` se ejecuta **al inicio de cada ciclo** y escribe `doctor_report` en el contexto. El LLM puede leer este reporte para tomar decisiones informadas (ej: no enviar señales de compra si las credenciales del broker faltan).

Si `fail_on_missing_credentials = true` y las credenciales faltan, escribe `cycle_abort = true` en el contexto para señalizar que el ciclo debe cancelarse.

## Herramienta disponible

### `run_diagnostics`
```json
{
  "active_plugin_ids": ["alpaca-provider", "risk-envelope"],
  "required_credentials": ["ALPACA_API_KEY", "ALPACA_SECRET_KEY"],
  "context": {}
}
```

**Respuesta:**
```json
{
  "ok": false,
  "summary": { "total": 3, "passed": 2, "failed": 1 },
  "errors": ["Credenciales faltantes: ALPACA_API_KEY"],
  "checks": [...]
}
```
