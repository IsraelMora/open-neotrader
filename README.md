# OpenNeoTrader

Plataforma self-hosted de agentes de IA para trading. El LLM actúa como orquestador que analiza contexto textual (noticias, eventos) y ejecuta skills declarados en plugins Python. Nunca ve series de precios directamente ni ejecuta código arbitrario.

> **Instalación y operación autónoma:** ver **[INSTALL.md](INSTALL.md)** (o `scripts/setup.sh` para dejarlo configurado en un comando). Tool-calling nativo (estándar OpenAI/MCP); funciona con LLMs **free** (OpenRouter) y broker **paper** (Alpaca).
>
> ⚠️ **Expectativa honesta:** es un marco de research/automatización con disciplina de riesgo, **no** una máquina de ingresos garantizados. En backtests honestos las estrategias incluidas rinden retornos modestos y a menudo **por debajo de comprar y aguantar un índice** (alpha negativo). Empezá SIEMPRE en paper. No inviertas dinero que no puedas perder.

## Arquitectura

```
Browser
  └─► nginx :8080
        ├─ /        → Astro (panel estático, shadcn/ui)
        └─ /api/*   → NestJS :3000
                          ├─ plugins, config, portfolios (SQLite)
                          ├─ LLM  (Anthropic — clave desde env)
                          └─ sandbox Python (subprocess por llamada)
                                └─ runner.py → plugins/<id>/plugin.py
```

**Garantías de seguridad:**
- El LLM solo invoca funciones listadas en `manifest.toml` de plugins activos (whitelist explícita).
- El LLM nunca recibe series de precios; solo texto/noticias/eventos.
- Máximo 3 tool calls por ciclo (anti-amplificación).
- API keys solo por passthrough de entorno — nunca en imagen ni repo.

## Inicio rápido (Docker)

```bash
# 1. Variables de entorno
cp .env.example .env
# Editar .env: JWT_SECRET + un LLM (OpenRouter free o Anthropic) — ver .env.example

# 2. Levantar
docker compose up -d

# 3. Configurar autónomo (un comando) — ver INSTALL.md para el detalle
#   API_URL=http://localhost:8080 ADMIN_USER=admin ADMIN_PASS=... LLM_API_KEY=sk-or-v1-... \
#   bash scripts/setup.sh

# Panel en http://localhost:8080
# API docs en http://localhost:3000/api/docs (solo dev)
```

## .env.example

```env
# Requerida para ciclos del agente con LLM
ANTHROPIC_API_KEY=sk-ant-...

# Modelo (default: haiku — más económico)
LLM_MODEL=claude-haiku-4-5-20251001

# Tienda de plugins (dejar por defecto)
STORE_URL=https://store.neurotrader.app
```

## Desarrollo local

```bash
# Backend NestJS
cd apps/api && pnpm install && pnpm dev    # :3000

# Frontend Astro
cd apps/web && pnpm install && pnpm dev    # :4321 (proxy /api → :3000)

# Probar sandbox directamente
echo '{"cmd":"list_plugins","active_ids":[]}' | python3 apps/sandbox/runner.py
```

## Plugins

Los plugins viven en `plugins/<id>/`:

```
plugins/
  mi-plugin/
    manifest.toml    ← declaración: id, tipo, skills expuestos
    plugin.py        ← implementación de las funciones
```

**manifest.toml mínimo:**
```toml
[plugin]
id      = "mi-plugin"
name    = "Mi Plugin"
version = "0.1.0"
type    = "skill"        # skill | universe_provider | discipline
author  = "tú"

[skills]
keys = ["mi-plugin.analizar"]
```

**plugin.py mínimo:**
```python
def analizar(symbol: str, _context: dict) -> dict:
    return {"symbol": symbol, "signal": "hold", "confidence": 0.5}
```

## Protocolo del sandbox (runner.py)

NestJS llama a `python3 runner.py` como subprocess. Protocolo stdin→stdout:

```json
// Listar plugins
{"cmd": "list_plugins", "active_ids": ["mi-plugin"]}

// Llamar una función de plugin (solo funciones declaradas en manifest.skills)
{"cmd": "call_plugin", "plugin_id": "mi-plugin", "function": "analizar", "args": {"symbol": "BTC"}}

// Ciclo completo del agente
{"cmd": "run_cycle", "active_ids": ["mi-plugin", "universe-crypto-defi"], "context": {}}
```

Respuesta siempre: `{"ok": true, "result": ...}` o `{"ok": false, "error": "..."}`.

## Endpoints API

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | /api/status | Estado del agente y portfolios |
| GET | /api/config | Leer configuración |
| POST | /api/config | Guardar configuración |
| GET | /api/doctor | Diagnóstico del sistema |
| GET | /api/run-status | ¿Hay un ciclo en curso? |
| POST | /api/run-cycle | Lanzar ciclo (`{dry_run: bool}`) |
| POST | /api/chat | Chat con el LLM (`{question, history}`) |
| GET | /api/plugins | Listar plugins instalados |
| POST | /api/plugins/install | Instalar plugin (`{source}`) |
| POST | /api/plugins/:id/activate | Activar plugin |
| POST | /api/plugins/:id/deactivate | Desactivar plugin |
| POST | /api/plugins/:id/config | Guardar config del plugin |
| DELETE | /api/plugins/:id | Desinstalar plugin |
| GET | /api/store/plugins | Explorar tienda |
| POST | /api/store/install | Instalar desde tienda |
| GET | /api/veto-metrics | Métricas del veto LLM |

## Estructura

```
neurotrader/
├── apps/
│   ├── api/         ← NestJS (TypeScript + SQLite)
│   ├── sandbox/     ← runner.py — ejecutado como subprocess por NestJS
│   └── web/         ← Astro + shadcn/ui (panel)
├── packages/
│   └── plugin-sdk/  ← SDK Python para crear plugins
├── plugins/         ← Plugins instalados
└── docker-compose.yml
```
