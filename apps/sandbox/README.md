# neurotrader-sandbox

Proceso Python que NestJS (`SandboxGateway`) invoca como subproceso para ejecutar plugins de forma aislada. Comunica por **JSON sobre stdin/stdout**. Sin acceso a red.

---

## Stack

| Componente | Detalle |
|---|---|
| Runtime | Python 3.12 (imagen Docker `python:3.12-slim`) |
| Dependencias | `pandas >= 2.2`, `numpy >= 1.26`, `scipy >= 1.13`, `scikit-learn >= 1.4` |
| Manifiestos de plugins | `tomllib` (stdlib desde Python 3.11) |
| Carga dinámica | `importlib.util.spec_from_file_location` |

---

## Conexión con el resto del sistema

```
NestJS (SandboxGateway)
  └─► stdin  → runner.py → stdout ─► NestJS
```

NestJS escribe un JSON en stdin, `runner.py` lee TODO el stdin de una sola vez (`sys.stdin.read()`), ejecuta el comando, y escribe exactamente **una línea JSON** en stdout con `flush=True`. No hay conexión HTTP ni sockets; el único canal es stdin/stdout.

---

## Protocolo JSON

**Request** (NestJS → runner):
```json
{ "cmd": "<comando>", ...campos_según_cmd }
```

**Response exitosa** (runner → NestJS):
```json
{ "ok": true, "result": <data> }
```

**Response de error**:
```json
{ "ok": false, "error": "<mensaje>" }
```

Errores manejados: `json.JSONDecodeError`, `PermissionError`, `FileNotFoundError`, `AttributeError` (devuelven `str(e)`); cualquier otra excepción devuelve el traceback completo (máx. 5 frames). Si `cmd` está ausente, el runner usa `"call_plugin"` como default (compatibilidad hacia atrás).

---

## Comandos

### `list_plugins`

Lista todos los plugins instalados en `NEUROTRADER_PLUGINS_DIR`.

```json
// request
{ "cmd": "list_plugins", "active_ids": ["plugin-a"] }

// result: array de objetos
[{ "id", "name", "version", "type", "description", "author", "skills", "active" }]
```

`active_ids` es opcional; si se pasa, el campo `active` refleja si el plugin está en esa lista.

---

### `get_skills`

Devuelve los skills declarados por los plugins activos.

```json
// request
{ "cmd": "get_skills", "active_ids": ["plugin-a"] }

// result
[{ "plugin_id": "plugin-a", "key": "plugin-a.mi_skill" }]
```

---

### `get_symbols`

Llama a `get_universe()` en cada plugin activo de tipo `universe_provider` y devuelve la lista de símbolos deduplicada.

```json
// request
{ "cmd": "get_symbols", "active_ids": ["mi-universe-plugin"] }

// result
["AAPL", "MSFT", "BTC/USDT"]
```

---

### `call_plugin`

Ejecuta una función declarada en el manifest del plugin. La función debe figurar en `manifest.skills.keys`; si no, se lanza `PermissionError`.

```json
// request
{
  "cmd": "call_plugin",
  "plugin_id": "mi-plugin",
  "function": "mi-plugin.analizar",
  "args": { "symbol": "AAPL" },
  "context": { "operator": "principal" }
}

// result: lo que devuelva la función del plugin
```

La función recibe `**args` más un kwarg `_context` con un objeto `_SdkContext` (o fallback plain dict si el SDK no está instalado).

---

### `run_hook`

Ejecuta uno de los hooks del ciclo de vida de un plugin.

```json
// request
{
  "cmd": "run_hook",
  "plugin_id": "mi-plugin",
  "hook": "on_cycle",
  "context": { "config": { "umbral": 0.5 } }
}

// result
{ "signals": [...], "logs": [...] }
```

Hooks permitidos: `on_cycle`, `on_activate`, `on_deactivate`. Cualquier otro valor devuelve `ValueError`. Si el archivo del hook no existe, devuelve `{ "signals": [], "logs": [{ "level": "debug", "msg": "..." }] }` sin error. Los defaults de config definidos en `manifest.config` se fusionan con el `context.config` que llega.

---

### `emit_signal`

Valida y anota el origen de una señal. Actualmente solo valida el formato; la persistencia la maneja el caller (NestJS).

```json
// request
{
  "cmd": "emit_signal",
  "plugin_id": "mi-plugin",
  "signal": { "type": "order", "symbol": "AAPL", "action": "buy" }
}

// result
{ "accepted": true, "signal": { "type": "order", "symbol": "AAPL", "action": "buy", "_plugin": "mi-plugin" } }
```

Campos obligatorios en `signal`: `type`, `symbol`, `action`. Si falta alguno, devuelve `ValueError`.

---

### `run_cycle`

Pipeline completo del agente en tres etapas:

1. **Universe** — `get_universe()` sobre plugins `universe_provider` activos → lista de símbolos.
2. **Disciplines** — función `run_discipline` (configurable en `manifest.discipline.function`) sobre plugins `discipline` activos, pasando el universo → lista de señales con `_plugin` inyectado.
3. **Skills enrichment** — para cada señal, ejecuta todos los skills declarados de plugins `skill` activos; el resultado se guarda en la señal bajo la clave del skill.

Los errores por etapa se capturan y acumulan en `result.errors`; nunca se propagan.

```json
// request
{ "cmd": "run_cycle", "active_ids": ["univ-plugin", "disc-plugin"], "context": { "operator": "principal" } }

// result
{ "universe": ["AAPL", ...], "signals": [...], "errors": [] }
```

---

## Descubrimiento de plugins

- Directorio raíz: `$NEUROTRADER_PLUGINS_DIR` (default `/opt/neurotrader/plugins`).
- Un plugin = cualquier subdirectorio que contenga `manifest.toml`.
- Código principal: `<plugin_dir>/plugin.py`.
- El directorio del plugin se antepone a `sys.path` en cada carga.
- Nombre de módulo dinámico: `_nt_<plugin_id>`.

### Estructura mínima de `manifest.toml`

```toml
[plugin]
id = "mi-plugin"
name = "Mi Plugin"
version = "1.0.0"
type = "skill"            # skill | universe_provider | discipline
description = "..."
author = "..."

[skills]
keys = ["mi-plugin.mi_funcion"]

[hooks]
on_cycle = "hooks/on_cycle.py"   # opcional; este es el default

[discipline]
function = "run_discipline"       # opcional; este es el default

[config]
umbral = { default = 0.5 }       # fusionado en context.config para hooks
```

---

## Restricciones del sandbox

| Restricción | Mecanismo |
|---|---|
| Sin red | `--network=none` (Docker) o `bubblewrap` (nativo) — a nivel OS, no Python |
| CPU | `RLIMIT_CPU` = 60 s (override: `$SANDBOX_CPU_SECONDS`) |
| Memoria virtual | `RLIMIT_AS` = 512 MB (override: `$SANDBOX_MEM_MB`) |
| File descriptors | `RLIMIT_NOFILE` = 64 (hardcoded) |
| Usuario | `sandbox` (UID 1001, sin root) — definido en `Dockerfile` |

Los rlimits se aplican vía el módulo `resource` de Python al arrancar. Se omiten silenciosamente en Windows o en contenedores que ya los restringen.

---

## Variables de entorno

| Variable | Default | Descripción |
|---|---|---|
| `NEUROTRADER_PLUGINS_DIR` | `/opt/neurotrader/plugins` | Directorio raíz de plugins |
| `SANDBOX_CPU_SECONDS` | `60` | Límite de tiempo CPU (segundos) |
| `SANDBOX_MEM_MB` | `512` | Límite de memoria virtual (MB) |
| `PYTHONUNBUFFERED` | `1` | Stdout sin buffer (fijado en Dockerfile) |
| `PYTHONDONTWRITEBYTECODE` | `1` | Sin archivos `.pyc` (fijado en Dockerfile) |

---

## Cómo correr

**Con Docker** (recomendado para aislar red y recursos):
```bash
docker build -t neurotrader-sandbox .
echo '{"cmd":"list_plugins"}' | docker run --rm -i --network=none \
  -v /opt/neurotrader/plugins:/opt/neurotrader/plugins \
  neurotrader-sandbox
```

**Local (desarrollo/debug)**:
```bash
pip install -r requirements.txt
echo '{"cmd":"list_plugins"}' | python3 runner.py
```

En modo local, las restricciones de red dependen del entorno del sistema operativo. Los rlimits sí se aplican.

---

## Gotchas

- **Una sola lectura de stdin**: el runner llama `sys.stdin.read()` una vez. No es un protocolo de múltiples mensajes por invocación — NestJS lanza un proceso nuevo por cada llamada.
- **Python 3.14 en dev vs 3.12 en Docker**: el `__pycache__` generado localmente puede ser `cpython-314.pyc`. El `Dockerfile` usa `python:3.12-slim`. No mezclar los bytecodes.
- **SDK opcional**: `from neurotrader_sdk import Context` se importa con try/except. Si el SDK no está instalado, `_SdkContext` es un plain object con `__init__(**kw)`. Los plugins no deben asumir que reciben una instancia del SDK real.
- **Hooks ausentes no son error**: si el archivo `.py` del hook no existe, `run_hook` devuelve `{ "signals": [], "logs": [] }` con nivel `debug`. NestJS no debe tratar esto como fallo.
- **Plugins montados como volumen**: en producción Docker, el directorio `/opt/neurotrader/plugins` se monta como volumen externo. No está incluido en la imagen.
