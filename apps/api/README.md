# OpenNeoTrader API

API REST del núcleo de la plataforma OpenNeoTrader. Orquesta agentes de IA para trading, gestiona plugins Python en sandbox aislado y sirve de única puerta de salida a internet.

---

## Qué es

Backend NestJS v11 + Fastify que expone `GET|POST /api/*` y un WebSocket en `:3001/api/ws`. Actúa como shell de la plataforma: no contiene estrategias de trading; toda la lógica de decisión vive en plugins Python que se cargan en tiempo de ejecución.

---

## Stack

| Capa | Tecnología |
|---|---|
| Framework | NestJS 11 + `@nestjs/platform-fastify` (Fastify 5) |
| Base de datos | SQLite vía `better-sqlite3` + adaptador Prisma 7 |
| Auth | JWT (Passport) + TOTP (`speakeasy`) |
| Transporte WS | `@nestjs/platform-ws` + `ws` |
| Docs | Swagger (`@nestjs/swagger`) — solo en `NODE_ENV !== production` |
| Seguridad | `@fastify/helmet`, rate limiting (`@nestjs/throttler`: 120 req/min, 10/min en auth), `CorrelationMiddleware` |
| Lint / formato | ESLint 9, `typescript-eslint`, `eslint-plugin-sonarjs`, Prettier |
| Tests | Jest 30 (`ts-jest`), `supertest` para E2E |
| Runtime | Node.js ≥ 22, TypeScript 5.8 |

---

## Arquitectura: shell + plugins

```
NestJS API
  ├── ProviderGateway  ← único punto de salida a internet
  │     lee manifest.toml de cada plugin provider
  │     normaliza OHLCV/Quote/Portfolio a formato estándar
  │
  ├── SandboxGateway   ← invoca Python sin red
  │     spawn python3 runner.py  (stdin JSON → stdout JSON)
  │     env aislada, SIGKILL por timeout
  │
  └── AgentsService    ← ciclo del agente
        LlmService → LLM devuelve tool_calls (funciones declaradas en manifest)
        VetoLayer  → discipline plugins aprueban/rechazan señales
        SandboxGateway → ejecuta funciones aprobadas en Python
```

**La plataforma es un shell.** Los plugins deciden estrategias:

| Tipo de plugin | Rol |
|---|---|
| `skill` | Expone funciones que el LLM puede invocar |
| `provider` | Declara endpoints de un broker/exchange en `manifest.toml`; la API hace las llamadas HTTP |
| `discipline` | Reglas de veto: aprueba o rechaza señales antes de ejecutarlas |
| `universe` | Define el universo de activos disponibles |
| `stack` | Combina varios plugins en un stack predefinido |
| `extra` | Extensiones de plataforma (e.g. `claude-subscription`) |

El LLM **nunca ve series de precios** ni ejecuta código arbitrario. Solo invoca funciones incluidas en la whitelist del `manifest.toml` del plugin activo (máximo 3 tool calls por ciclo).

---

## Módulos principales

| Módulo | Responsabilidad |
|---|---|
| `AuthModule` | Login local (Passport), JWT, TOTP con QR — guards globales `JwtAuthGuard` + `ThrottlerGuard` |
| `UsersModule` | Gestión de usuarios y perfiles |
| `PluginsModule` | Ciclo de vida de plugins: instalar, activar, desactivar, watcher de cambios |
| `SandboxModule` | `SandboxGateway` — invoca `runner.py` como subprocess aislado sin red |
| `LlmModule` | Abstracción de backends LLM; enruta según `LLM_BACKEND` |
| `ProvidersModule` | `ProviderGatewayService` — único punto HTTP saliente hacia brokers/exchanges; `OhlcvCacheService` |
| `AgentsModule` | Ciclo del agente: contexto → LLM → veto → sandbox → auditoría |
| `PanelModule` | Endpoints del panel de control (estado, config, chat) |
| `CycleSchedulerModule` | Planificación y ejecución automática de ciclos del agente |
| `AuditModule` | Registro inmutable de ciclos y decisiones (requiere TOTP para lectura) |
| `AlertsModule` | Creación y consulta de alertas de mercado |
| `SnapshotModule` | Snapshots de cartera en base a datos del provider activo |
| `BackupModule` | Exportación e importación de configuración/estado |
| `PretestModule` | Validación previa a la activación de plugins (sandbox + LLM) |
| `RegistryModule` | Registro interno de plugins disponibles (enlaza `PluginsModule` + `StoreModule`) |
| `StoreModule` | Integración con la tienda de plugins externa |
| `WsModule` | Gateway WebSocket bidireccional; autenticado vía JWT |
| `NotifierModule` | Envío de notificaciones (Telegram) |
| `EventsModule` | Bus de eventos interno vía `@nestjs/event-emitter` |
| `ContextMemoryModule` | Memoria de contexto persistente para el agente (requiere TOTP) |
| `CredentialsModule` | Gestión segura de API keys de proveedores |
| `OnboardingModule` | Flujo guiado de configuración inicial |
| `DashboardModule` | Datos agregados para el dashboard |
| `HealthModule` | `GET /api/health` — verifica DB y estado del proceso |

---

## Backends LLM

Configurados con `LLM_BACKEND` (default: `anthropic`). El modelo activo se cambia con `LLM_MODEL`.

| Backend | Variable | Descripción |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | API REST de Anthropic (`/v1/messages`) |
| `openai` | `OPENAI_API_KEY` | API de OpenAI (GPT-4o, etc.) |
| `gemini` | `GEMINI_API_KEY` | Google Gemini vía REST |
| `custom` | Variable definida por el provider | Cualquier API compatible con OpenAI (Groq, OpenRouter, Ollama, etc.). Registrar vía `POST /api/llm/providers` |
| `subscription` | — | Invoca el CLI `claude` instalado localmente; no requiere API key. Se activa con `LLM_BACKEND=subscription` o activando el plugin `claude-subscription` |

En todos los backends, los skills activos se inyectan como texto en el system prompt (no hay tool-use nativo del protocolo LLM).

---

## Variables de entorno

No hay `.env.example` en `apps/api/`; el archivo raíz del proyecto documenta las variables principales. Las relevantes para esta app:

| Variable | Default | Descripción |
|---|---|---|
| `API_PORT` | `3000` | Puerto HTTP de la API |
| `API_HOST` | `127.0.0.1` (dev) / `0.0.0.0` (prod) | Host de escucha |
| `WS_PORT` | `3001` | Puerto WebSocket (informativo en logs) |
| `NODE_ENV` | — | `production` desactiva Swagger y ajusta CSP/host |
| `JWT_SECRET` | — | **Requerida.** Clave de firma JWT |
| `JWT_EXPIRES_IN` | `8h` | TTL del token JWT |
| `CORS_ORIGINS` | — | Lista de orígenes separados por coma; sin valor, CORS deshabilitado |
| `DATABASE_URL` | — | URL de conexión Prisma (SQLite: `file:./dev.db`) |
| `LLM_BACKEND` | `anthropic` | Backend LLM activo |
| `LLM_MODEL` | `claude-haiku-4-5-20251001` | Modelo a utilizar |
| `ANTHROPIC_API_KEY` | — | API key de Anthropic (backend `anthropic`) |
| `OPENAI_API_KEY` | — | API key de OpenAI (backend `openai`) |
| `GEMINI_API_KEY` | — | API key de Google (backend `gemini`) |
| `PLUGINS_DIR` | `../../../../plugins` (relativo al build) | Directorio raíz de plugins |
| `PYTHON3_BIN` | `python3` | Intérprete Python para el sandbox (resuelto por PATH; override para Docker/venv) |
| `SANDBOX_RUNNER_PATH` | `../../../../sandbox/runner.py` | Ruta al script del sandbox |
| `SANDBOX_TIMEOUT_MS` | `30000` | Timeout por llamada al sandbox (ms) |
| `SANDBOX_CPU_SECONDS` | `60` | Límite de CPU para el proceso Python |
| `SANDBOX_MEM_MB` | `512` | Límite de memoria para el proceso Python |
| `PLUGIN_SDK_PATH` | `../../../../../packages/plugin-sdk` | PYTHONPATH del SDK de plugins |

---

## Cómo correr

El workspace usa **pnpm**. Todos los comandos se ejecutan desde `apps/api/`.

```bash
# Instalar dependencias (desde la raíz del monorepo)
pnpm install

# Desarrollo con recarga automática
pnpm dev

# Compilar
pnpm build

# Producción (requiere build previo)
pnpm start

# Base de datos
pnpm db:migrate        # aplica migraciones (producción)
pnpm db:migrate:dev    # crea migración + aplica (desarrollo)
pnpm db:migrate:status # estado de migraciones
pnpm db:push           # sincroniza schema sin migración (prototipado)
pnpm db:studio         # Prisma Studio en el navegador

# Tests
pnpm test              # Jest (unitarios)
pnpm test:e2e          # Jest E2E (./test/jest-e2e.json)

# Lint
pnpm lint              # ESLint sobre src/ y test/
```

**URLs en desarrollo:**

| Servicio | URL |
|---|---|
| API REST | `http://127.0.0.1:3000/api` |
| Swagger UI | `http://127.0.0.1:3000/api/docs` |
| WebSocket | `ws://127.0.0.1:3001/api/ws` |

---

## Tests y calidad

- **Jest 30** con `ts-jest`; configuración E2E separada en `test/jest-e2e.json`.
- **ESLint 9** (`typescript-eslint` strict + `eslint-plugin-sonarjs`) sin excepciones de regla en el código fuente.
- **Prettier** integrado como regla ESLint; el lint falla si el formato no es correcto.
- **`@nestjs/testing`** y **`supertest`** disponibles para tests de integración de controladores.
