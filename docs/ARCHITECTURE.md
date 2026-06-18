# Arquitectura de NeuroTrader

> **NTPP v1** — Documento de referencia arquitectónica. Refleja el estado real del código;
> no es un documento de aspiraciones. Última revisión: 2026-06-18.

---

## Tabla de contenidos

1. [Visión general](#1-visión-general)
2. [Diagrama de componentes](#2-diagrama-de-componentes)
3. [Aplicaciones y paquetes](#3-aplicaciones-y-paquetes)
4. [El sistema de plugins](#4-el-sistema-de-plugins)
5. [El ciclo del agente](#5-el-ciclo-del-agente)
6. [Seguridad y límites de confianza](#6-seguridad-y-límites-de-confianza)
7. [Stack y calidad de código](#7-stack-y-calidad-de-código)
8. [Persistencia](#8-persistencia)

---

## 1. Visión general

NeuroTrader es una plataforma **local-first** de agentes de trading impulsada por LLM.
El principio de diseño central es **"shell + plugins"**: el núcleo (API) no decide ninguna
estrategia de trading. Son los plugins quienes aportan señales, criterios de posicionamiento
y reglas de disciplina. El núcleo orquesta, valida y persiste; nunca razona sobre mercados.

Filosofía operativa:

- **Un único usuario** (monousuario autenticado con JWT + TOTP).
- **Sin backend propio en la nube**: toda la lógica corre en el host del operador.
- **Egreso de red controlado**: solo el `ProviderGateway` puede salir a internet; el sandbox Python corre sin red.
- **LLM como orquestador, no como decisor**: el LLM solo puede invocar herramientas declaradas en los manifiestos activos, y solo puede mantener o reducir la exposición propuesta por las señales.

---

## 2. Diagrama de componentes

```
Navegador
    │
    ▼
nginx :8080  (sirve build estático de Astro)
    │  HTTP / WebSocket
    ▼
NestJS API :3000  (@neurotrader/api)
    │
    ├─── SandboxGateway ──────────────► Python subprocess (runner.py)
    │         stdin/stdout JSON              │
    │         (sin red, CPU+RAM limitado)    ├─ plugins/ (hooks cycle.py)
    │                                        └─ neurotrader-sdk (PYTHONPATH)
    │
    ├─── ProviderGateway ────────────► Internet
    │         único punto de egress          ├─ Alpaca REST
    │         (Alpaca / Tiingo / CCXT /      ├─ Tiingo
    │          Binance / Yahoo-genérico)     ├─ CCXT / Binance
    │                                        └─ Yahoo Finance
    │
    ├─── LlmService ─────────────────► LLM externo
    │         (Anthropic / OpenAI /          (solo texto; no usa tool-calls nativos)
    │          Gemini / OpenRouter /
    │          claude CLI subprocess)
    │
    └─── PrismaService ──────────────► SQLite  (api-data volume)
                                        ├─ User, Plugin, ConfigEntry
                                        ├─ AuditEntry, AlertEntry
                                        ├─ NavSnapshot, Portfolio
                                        └─ PretestPortfolio

neurotrader-store :XXXX  (servicio separado)
    │  NestJS + Express + Prisma/SQLite
    └─ Marketplace de plugins; estado de verificación independiente
```

**Nota sobre Docker:** en producción, `api` y `web` corren como contenedores en una red bridge
interna. El sandbox Python se inicializa con el perfil `sandbox-init` (solo en setup);
en runtime el `SandboxGateway` hace `spawn` del proceso directamente dentro del contenedor
`api`. Los plugins se comparten mediante el volumen `plugins-vol`.

---

## 3. Aplicaciones y paquetes

### Monorepo

| Herramienta | Versión mínima |
|-------------|----------------|
| pnpm workspaces | pnpm ≥ 9 |
| Turborepo | ^2.0 |
| Node.js | ≥ 20 |

```
neurotrader/
├── apps/
│   ├── api/        # NestJS — core del agente
│   ├── web/        # Astro — panel de control estático
│   ├── store/      # NestJS — marketplace de plugins
│   └── sandbox/    # Python — runner de plugins
├── packages/
│   ├── plugin-sdk/ # Python SDK (neurotrader-sdk 0.1.0)
│   ├── types/      # Tipos TypeScript compartidos
│   └── dart_sandbox/ # ⚠️ LEGACY: puente Dart para la app Flutter descartada
└── plugins/        # ~58 plugins bundled
```

### apps/api

Motor principal. NestJS v11 sobre **Fastify v5** con WsAdapter.

Módulos registrados en `AppModule`:

| Dominio | Módulos |
|---------|---------|
| Core | PrismaModule, UsersModule, AuthModule |
| Plugins | PluginsModule, RegistryModule, StoreModule |
| Ejecución | SandboxModule, AgentsModule, CycleSchedulerModule |
| LLM | LlmModule |
| Mercado | ProvidersModule |
| Observabilidad | AuditModule, AlertsModule, SnapshotModule, DashboardModule |
| UX/API | PanelModule, CredentialsModule, OnboardingModule, ContextMemoryModule |
| Infra | HealthModule, EventsModule, NotifierModule, BackupModule, WsModule |
| Dev | PretestModule |

Guards globales: `JwtAuthGuard`, `ThrottlerGuard` (120 req/min general; 10 req/min en `/auth`).
Rate limiting global: 120 req/min / usuario.

### apps/web

Astro v6 + React 19 + Tailwind v4. Build estático servido por nginx.
UI: Radix UI, lucide-react, recharts, motion, react-markdown. HTTP via `ky`.

### apps/store

NestJS v11 + **Express** (no Fastify) + Prisma/SQLite independiente.
Gestiona catálogo, estado de verificación y entrega de plugins. Corre como servicio
separado; la API principal lo consulta a través de `StoreModule`.

### apps/sandbox

Runner Python puro. No es un servidor HTTP: se comunica por **stdin/stdout JSON** con el
proceso padre (NestJS `SandboxGateway`).

Comandos soportados:

| Comando | Descripción |
|---------|-------------|
| `list_plugins` | Descubre plugins en `NEUROTRADER_PLUGINS_DIR` |
| `get_skills` | Retorna skills declaradas en manifiestos activos |
| `get_symbols` | Símbolos disponibles por universo activo |
| `call_plugin` | Llama una función de un plugin (con whitelist enforcement) |
| `run_hook` | Ejecuta un hook nombrado de un plugin |
| `emit_signal` | Plugin emite señal de trading |
| `run_cycle` | Ejecuta el ciclo completo de un plugin |

Límites de recursos aplicados al inicio (módulo `resource`):
- CPU: configurable via `SANDBOX_CPU_SECONDS`
- Memoria: configurable via `SANDBOX_MEM_MB`
- File descriptors: máximo 64

Dependencias Python: pandas ≥ 2.2, numpy ≥ 1.26, scipy ≥ 1.13, scikit-learn ≥ 1.4.

### packages/plugin-sdk

`neurotrader-sdk` v0.1.0 (Python, requiere ≥ 3.11).
Exporta: `Context` (dataclass), `@skill`, `@universe_provider`, `@discipline` (decoradores).
Se inyecta al sandbox via `PYTHONPATH`.

### packages/dart_sandbox ⚠️ LEGACY / ABANDONADO

Paquete Dart que replicaba el protocolo JSON del `SandboxGateway` usando `dart:io Process`
para una app Flutter móvil. **La app Flutter fue descartada**; este paquete ya no se usa ni
se integra con el resto del monorepo. Candidato a purga.

---

## 4. El sistema de plugins

### Tipos de plugin

| Tipo | Rol |
|------|-----|
| `skill` | Análisis técnico / señales de trading |
| `discipline` | Reglas de gestión de riesgo y sizing; puede **vetar** señales |
| `universe` | Define el universo de símbolos negociables |
| `provider` | Fuente de datos de mercado (integrada via `ProviderGateway`) |
| `stack` | Meta-plugin: agrupa otros plugins como conjunto instalable |
| `extra` | Utilidades (alertas, exportación, etc.) |

En `plugins-catalog.json` hay 37 plugins oficiales verificados. El directorio `plugins/`
contiene ~70 en total (incluyendo variantes en desarrollo).

### Estructura de un plugin

```
plugins/<nombre>/
├── manifest.toml      # Contrato declarativo (NTPP v1)
├── SKILL.md           # Documentación para el LLM
├── tools.json         # Herramientas expuestas al LLM (OpenAI schema)
├── hooks/
│   ├── cycle.py       # on_cycle: ejecutado cada ciclo
│   ├── activate.py    # on_activate (opcional)
│   └── deactivate.py  # on_deactivate (opcional)
└── scripts/           # Lógica auxiliar importada por los hooks
```

### manifest.toml — campos clave

```toml
[plugin]
id      = "kelly-criterion"
name    = "Kelly Criterion"
version = "1.0.0"
type    = "discipline"          # skill | discipline | universe | provider | stack | extra

[skills]
# Funciones públicas que el LLM puede invocar (whitelist de sandbox)
"kelly-criterion.calculate_position_size" = "..."
"kelly-criterion.get_kelly_stats"         = "..."

[hooks]
on_cycle     = "hooks/cycle.py"
on_activate  = "hooks/activate.py"    # opcional
on_deactivate = "hooks/deactivate.py" # opcional

[config]
kelly_fraction      = 0.5
max_position_pct    = 10
min_trades_required = 30

[permissions]
network = false   # false para todos los plugins que no son provider

[api]
# Solo plugins tipo provider: declaración de endpoints externos
# El ProviderGateway los consume declarativamente

[scheduler]
mode     = "polling"
interval = "1d"
interval_ms = 86400000
```

### SKILL.md — contexto para el LLM

Cada plugin incluye un `SKILL.md` que se inyecta en el system prompt del LLM en cada ciclo
(solo los plugins activos). Contiene:
- Explicación del algoritmo y su evidencia empírica
- Flujo de uso paso a paso (qué funciones llamar y en qué orden)
- Tabla de parámetros según tipo de mercado
- Limitaciones conocidas
- Sección `## Notas aprendidas` (actualizable por el LLM entre ciclos)

### tools.json — contrato con el LLM

Schema compatible con OpenAI tool-calling. El `LlmService` los carga de los plugins activos
y los incluye en el contexto, pero el LLM **no usa tool-calling nativo**: responde texto
estructurado que `AgentsService` parsea y valida antes de enviar al sandbox.

### Ciclo de vida de un plugin

```
Instalación → PluginsModule registra en DB (Plugin model)
            → on_activate hook ejecutado por SandboxGateway
            → ProviderGateway re-descubre providers via evento plugin.activated
            → SKILL.md y tools.json disponibles para el próximo ciclo del agente

Desactivación → on_deactivate hook
              → evento plugin.deactivated
              → ProviderGateway re-descubre providers
```

---

## 5. El ciclo del agente

Implementado en `apps/api/src/agents/agents.service.ts` (método `_executeCycle`).

```
┌─────────────────────────────────────────────────────────┐
│  Ciclo del agente (agents.service.ts::_executeCycle)    │
│                                                         │
│  1. MEMORIA INTER-CICLO                                 │
│     └─ Inyecta contexto de ciclos anteriores           │
│                                                         │
│  2. HOOKS on_cycle (todos los plugins activos)          │
│     └─ SandboxGateway.runPluginCycleHook()             │
│        └─ Resultado: pending_signals[]                  │
│                                                         │
│  3. VETO DE DISCIPLINA                                  │
│     └─ Plugins tipo discipline modifican pending_signals│
│        VetoSummary: proposed / approved / vetoed        │
│                                                         │
│  4. LLM (LlmService.complete)                           │
│     └─ System prompt: SKILL.md de plugins activos      │
│     └─ Context: señales aprobadas + memoria             │
│     └─ Restricción: solo puede mantener o ↓ exposición │
│        (Math.min(current_exp, proposed_exp))            │
│                                                         │
│  5. EJECUCIÓN DE TOOL CALLS                             │
│     └─ ToolCallValidatorService valida contra whitelist │
│     └─ SandboxGateway.callPlugin() por cada tool call  │
│     └─ Máximo 3 tool calls por ciclo                   │
│                                                         │
│  6. PERSISTENCIA                                        │
│     ├─ AuditEntry (inmutable, indexado por cycle_id)   │
│     ├─ NavSnapshot (equity curve)                       │
│     └─ AlertEntry (DRAWDOWN / FLASH_CRASH / etc.)      │
└─────────────────────────────────────────────────────────┘
```

### Restricción del LLM (llm-constraints.md)

El LLM opera bajo guardrails no negociables:

- **Solo invoca herramientas whitelisteadas** en los manifiestos activos.
- **Solo puede reducir exposición**: `Math.min(current_exp, proposed_exp)`. Nunca la aumenta.
- **Responde texto estructurado**, no tool-calls nativos. `AgentsService` parsea y valida.
- **API keys nunca en el prompt**: se pasan como env vars al sandbox.

Amenazas mitigadas: prompt injection, tool declarations falsas, datos corruptos,
timing attacks (ver `docs/llm-constraints.md` para el threat model completo).

### Backends LLM soportados

| Backend | Mecanismo |
|---------|-----------|
| `anthropic` | REST directo a `api.anthropic.com/v1/messages` |
| `openai` | REST directo a OpenAI |
| `gemini` | REST directo a Google |
| `subscription` | Subprocess `claude` CLI |
| `custom` | Cualquier endpoint OpenAI-compatible (incl. OpenRouter) |

Modelo por defecto: `claude-haiku-4-5-20251001`.
Los skills de los plugins activos se inyectan en el system prompt para todos los backends.

---

## 6. Seguridad y límites de confianza

| Capa | Mecanismo |
|------|-----------|
| **Autenticación** | JWT + TOTP (speakeasy). Usuario único (`User` model monousuario). |
| **Rate limiting** | ThrottlerGuard: 120 req/min general, 10 req/min en `/auth`. |
| **Sandbox Python** | `spawn` sin red (`network=false` en manifest). CPU y RAM limitados vía `resource`. Max 64 file descriptors. |
| **Whitelist de funciones** | `call_plugin` en `runner.py` valida nombre de función contra `manifest.skills.keys`. LLM no puede invocar funciones no declaradas. |
| **Egreso de red** | Solo `ProviderGateway` accede a internet. URL parameter sanitization contra injection. |
| **Secretos** | API keys exclusivamente via variables de entorno (`.env`). Nunca en DB ni en prompts. |
| **Reducción de exposición** | `Math.min(current_exp, proposed_exp)` en `AgentsService`. Guardrail en código, no solo en prompt. |
| **Audit log** | `AuditEntry` inmutable por cycle_id. Trazabilidad completa de cada decisión. |
| **Docker** | Contenedor `api` en red bridge interna. Bind a `127.0.0.1:3000` (no expuesto directamente). nginx en :8080 como único ingress. |

---

## 7. Stack y calidad de código

### TypeScript (apps/api, apps/web, apps/store, packages/types)

| Herramienta | Configuración |
|-------------|---------------|
| TypeScript | ≥ 5.4 |
| ESLint 9 + sonarjs + prettier | Configuración en root |
| Jest v30 + ts-jest | Tests unitarios e integración |
| Turborepo | Pipeline: `build → test → lint` |

Scripts raíz: `pnpm dev`, `pnpm build`, `pnpm test`, `pnpm lint`.
Migraciones: `pnpm db:migrate` / `pnpm db:generate` (TypeORM CLI sobre Prisma).

### Python (apps/sandbox, packages/plugin-sdk, plugins/)

| Herramienta | Configuración |
|-------------|---------------|
| Python | ≥ 3.11 |
| ruff | `target-version = "py311"`, `line-length = 100`, rules: E/F/W/I/UP/B/SIM/C4 |
| ruff format | `quote-style = "double"`, `indent-style = "space"` |

`ruff.toml` en la raíz del monorepo aplica a todo el código Python.

### Dart (packages/dart_sandbox) — legacy, sin uso

Dart SDK ≥ 3.6.0. Sin herramientas de lint configuradas en este paquete actualmente.

---

## 8. Persistencia

### SQLite via Prisma v7 (apps/api)

Archivo en el volumen `api-data`. Modelos principales:

| Modelo | Propósito |
|--------|-----------|
| `User` | Usuario único; campos JWT + TOTP |
| `Plugin` | Registro de plugins instalados; `type`, `active`, `verification`, `config` (JSON) |
| `ConfigEntry` | Key-value store general |
| `Portfolio` | Portafolios con datos JSON |
| `NavSnapshot` | Curva de equity por ciclo |
| `AlertEntry` | Alertas tipadas: `DRAWDOWN`, `FLASH_CRASH`, `CORRELATION_SPIKE`, etc. |
| `AuditEntry` | Log inmutable de decisiones; indexado por `cycle_id` |
| `PretestPortfolio` | Portafolios virtuales para backtesting/pretest |

### SQLite via Prisma v7 (apps/store)

Base de datos independiente del store. Modelos: `plugins` y `plugin_stack_members`
para gestión del marketplace y estado de verificación.

### Caché en memoria

`OhlcvCacheService` dentro de `ProviderGateway`: caché in-process de barras OHLCV.
No hay Redis ni caché distribuida; el diseño es explícitamente single-node.

---

## Referencias rápidas

| Documento | Contenido |
|-----------|-----------|
| `docs/plugin-protocol.md` | Especificación completa de NTPP v1: schema de manifest, clase base Python, restricciones del sandbox |
| `docs/llm-constraints.md` | Guardrails del LLM, flujo completo `AgentRunService → LlmProxyService → ToolCallValidatorService → SandboxGateway → DecisionService`, threat model |
| `docs/plugin-store-verification.md` | Flujo de verificación del store: estados, checklist manual, endpoints de la Store API |
| `apps/api/prisma/schema.prisma` | Schema completo de la DB del API |
| `plugins-catalog.json` | Catálogo oficial de 37 plugins verificados con metadata |
