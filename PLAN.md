# NeuroTrader — Plan de arquitectura y refactorización

> **Juego de palabras:** NEUROredes (IA) + TRADER (operativa de mercados)
> Fecha: 2026-06-14 | Estado: planificación

---

## 1. ¿Qué es NeuroTrader?

Una **plataforma para agentes de IA especializados en trading**, no un agente único.

- El motor de ciencia de datos (algoritmos, backtesting, señales) vive en **plugins Python**.
- La orquestación, autenticación y API las gestiona un **backend NestJS**.
- El **LLM** solo puede leer contexto y llamar a funciones declaradas en el plugin activo; no ejecuta código arbitrario.
- El código Python corre en un **sandbox sin acceso a red**, garantizando que los plugins no filtran datos ni ejecutan código malicioso.
- `trading-test/` permanece intacto como referencia; todo el trabajo nuevo va en `neurotrader/`.

---

## 2. Principios de diseño

| Principio | Implicación concreta |
|-----------|----------------------|
| **Plugins first** | Toda lógica de dominio es un plugin. El core no tiene algoritmos embebidos. |
| **Sandbox estricto** | Python = sin red, sin escritura fuera del volumen de datos del plugin. |
| **LLM read-only** | El LLM recibe contexto texto plano; sus "acciones" son tool calls a funciones declaradas por el plugin, no ejecución de código. |
| **Auth real** | JWT + TOTP (@otplib), sin claves físicas cifradas. |
| **Plugin store verificado** | Plugins y stacks con badge de verificación manual por el equipo NeuroTrader. |
| **Monorepo** | Una sola repo (Turborepo) con apps/ y packages/ bien separados. |

---

## 3. Estructura del monorepo

```
neurotrader/
├── apps/
│   ├── api/                   # NestJS — orchestrador principal
│   │   ├── src/
│   │   │   ├── auth/          # JWT + TOTP (Passport.js)
│   │   │   ├── plugins/       # Registro, ciclo de vida, store
│   │   │   ├── sandbox/       # Gateway al sandbox Python
│   │   │   ├── llm/           # Proxy LLM con restricciones
│   │   │   ├── agents/        # Agentes (combinan plugins + LLM)
│   │   │   └── panel/         # API del panel de administración
│   │   └── test/
│   │
│   ├── web/                   # Panel de administración (Next.js + shadcn/ui)
│   │   └── src/
│   │       ├── app/           # App Router
│   │       ├── components/    # shadcn/ui
│   │       └── lib/           # Clientes API
│   │
│   └── sandbox/               # Sandbox Python (FastAPI mínimo + aislamiento)
│       ├── runner.py          # Servidor de ejecución de plugins
│       ├── isolation.py       # Restricciones de red/fs (seccomp/nsjail)
│       └── protocol.py        # Protocolo NeuroTrader Plugin Protocol (NTPP)
│
├── packages/
│   ├── plugin-sdk/            # SDK Python para desarrollar plugins
│   │   ├── neurotrader_sdk/
│   │   │   ├── plugin.py      # Clase base Plugin
│   │   │   ├── context.py     # Tipos de contexto (readonly)
│   │   │   ├── tool.py        # Decorador @tool para tool calls del LLM
│   │   │   └── manifest.py    # Schema del manifest.toml
│   │   └── pyproject.toml
│   │
│   └── types/                 # Tipos compartidos TypeScript
│       └── src/
│           ├── plugin.ts      # PluginManifest, PluginStack
│           ├── agent.ts       # AgentConfig, AgentRun
│           └── llm.ts         # LLMRequest, ToolCall, ToolResult
│
├── plugins/                   # Plugins built-in (migrados de trading-test)
│   ├── skills-base/           # Skills fundacionales (Python)
│   ├── universo-base/         # Universo de símbolos
│   ├── disciplina-dsr/        # Perfil disciplina DSR>=0.95
│   ├── ensemble-signals/      # Motor de señales (strategy.py migrado)
│   └── data-providers/        # Adaptadores Tiingo/Alpaca/Stooq/Coinbase
│
├── turbo.json
├── package.json               # workspace root
└── docker-compose.yml         # api + sandbox + postgres + redis
```

---

## 4. Componentes clave en detalle

### 4.1 apps/api — NestJS

**Módulos principales:**

```
auth/
  AuthModule
    - Passport LocalStrategy (usuario + contraseña)
    - Passport JwtStrategy (Bearer token)
    - TotpService (@otplib/preset-node: generateSecret, verify, qrcode-svg)
    - AuthController: POST /auth/login, /auth/totp/setup, /auth/totp/verify,
                      /auth/totp/disable, /auth/logout
    - UserService (PostgreSQL vía TypeORM o Prisma)
    - Sin llave física cifrada: recuperación por admin reset o email OTP.

plugins/
  PluginsModule
    - PluginRegistryService: instalar, activar, desactivar, desinstalar
    - PluginStoreService: buscar en store, descargar, verificar firma
    - PluginStackService: resolver dependencias de un stack
    - PluginVerificationService: flujo de verificación manual (admin)
    - PluginsController: CRUD + store + stacks

sandbox/
  SandboxModule
    - SandboxGateway: HTTP al runner Python (localhost, sin salida a red)
    - SandboxRunnerService: invocar función Python, pasar contexto, recibir resultado
    - Timeout + kill automático si el plugin excede el tiempo

llm/
  LlmModule
    - LlmProxyService: llama a Claude/Gemini/OpenAI con contexto read-only
    - ToolCallValidatorService: solo permite tool calls declarados en el plugin activo
    - NO permite ejecutar código, solo retorna texto + tool call results
    - LlmController: POST /llm/query (para uso del panel y plugins)

agents/
  AgentsModule
    - AgentService: ciclo de vida de un agente (conjunto de plugins + LLM)
    - AgentRunService: ejecutar un ciclo del agente
    - DecisionService: aplicar reglas de veto (solo puede mantener/recortar)
```

### 4.2 apps/sandbox — Python Runner

```python
# Protocolo: NeuroTrader Plugin Protocol (NTPP) v1
# Transporte: HTTP local (Unix socket en producción)
# El sandbox NO tiene acceso a internet (iptables DROP + --network=none en Docker)

# POST /run
{
  "plugin_id": "ensemble-signals",
  "function": "compute_signals",
  "context": {  # read-only, enviado por el api
    "portfolio": {...},
    "config": {...},
    "market_snapshot": {...}  # sin precios crudos al LLM
  },
  "params": {}
}

# Response
{
  "ok": true,
  "result": {...},
  "stdout": "...",   # logs del plugin
  "duration_ms": 42
}
```

**Aislamiento:**
- Docker con `--network=none` (red completamente cortada)
- Filesystem read-only excepto `/data/plugin-{id}/` (volumen del plugin)
- Sin acceso a `/proc`, `/sys` sensibles (seccomp profile)
- Timeout máximo configurable por plugin (default 30s)
- El runner Python usa `importlib` para cargar el plugin; si el plugin intenta hacer `import requests`, falla en silencio o retorna error

### 4.3 LLM con restricciones estrictas

```
Flujo:
  Plugin declara → { tools: [{ name, description, parameters }] }
  NestJS construye → system prompt con contexto read-only + tool definitions
  LLM devuelve  → texto + [tool_call: { name, arguments }]
  NestJS valida → ¿está el tool en la lista declarada? ¿parámetros válidos?
  NestJS ejecuta → SandboxGateway.call(plugin_id, tool_name, arguments)
  Resultado      → devuelto al LLM / al panel

Restricciones innegociables:
  ✗ El LLM no puede ejecutar código (ni Python, ni bash, ni eval)
  ✗ Los tool calls no pueden invocar funciones no declaradas en el plugin
  ✗ El contexto enviado al LLM es texto plano (no series de precios crudas)
  ✓ El LLM puede leer: noticias, eventos macro, resumen de portfolio, skills
  ✓ El LLM puede llamar: funciones del plugin activo con parámetros tipados
```

### 4.4 Sistema de autenticación (sin clave física)

```
Flujo de alta:
  POST /auth/register (solo en self-hosted; en SaaS, invitación por admin)
  POST /auth/totp/setup → { secret, qr_svg }  # qrcode-svg, sin deps externas
  POST /auth/totp/activate { code }            # primer código válido activa TOTP
  → TOTP obligatorio a partir de aquí

Flujo de login:
  POST /auth/login { username, password } → { totp_required: true }
  POST /auth/totp/verify { code } → { access_token, refresh_token }

Recuperación (sin clave física):
  Opción A: Admin reset (self-hosted: un CLI admin en el servidor)
  Opción B: Backup codes (10 códigos de un solo uso, generados al activar TOTP)
  → Elimina la complejidad de AES/PBKDF2 y el riesgo de pérdida del archivo

JWT: access_token (15min) + refresh_token (7 días, rotación al usar)
```

### 4.5 Plugin Store — Stacks y Verificación

```
Plugin normal:
  manifest.toml:
    [plugin]
    id = "ensemble-signals"
    type = "skill" | "universe" | "discipline" | "data-provider" | "strategy"
    
Plugin Stack (nuevo):
  manifest.toml:
    [plugin]
    id = "starter-pack-equities"
    type = "stack"
    [stack]
    plugins = ["ensemble-signals", "universo-base", "disciplina-dsr"]
    # Al instalar el stack, se instalan y activan todos sus plugins

Verificación manual:
  Estado: unverified | pending | verified | rejected
  Flujo:
    Autor sube plugin a la tienda (unverified)
    Autor solicita verificación (pending)
    Equipo NeuroTrader revisa: código, seguridad, declaraciones del manifest
    Si OK: verified (badge en la store)
    Si KO: rejected con motivo
  
  La verificación implica:
    - Revisión manual del código Python del plugin
    - Comprobación de que no hace imports de red en el sandbox
    - Test de ejecución en sandbox limpio
    - Firma del paquete con la clave de NeuroTrader
```

---

## 5. Migración desde trading-test

| Componente en trading-test | Destino en NeuroTrader |
|----------------------------|------------------------|
| `domain/strategy.py` | Plugin `ensemble-signals` (Python) |
| `application/skills.py` | Plugin `skills-base` (Python) |
| `application/analysis.py` | Plugin `disciplina-dsr` (Python) |
| `application/data_access.py` | Plugin `data-providers` (Python) |
| `adapters/alpaca_broker.py` | Plugin `broker-alpaca` (Python) |
| `adapters/binance_broker.py` | Plugin `broker-binance` (Python) |
| `ui/server.py` + `ui/api.py` | `apps/api` (NestJS) + `apps/web` (Next.js) |
| `application/plugins/` (registry, lifecycle) | `apps/api/src/plugins/` (NestJS) |
| `application/totp.py` + `application/totp_state.py` | `apps/api/src/auth/` (@otplib, Passport) |
| `data.db` (SQLite) | PostgreSQL (producción) / SQLite (dev con TypeORM) |
| `.env` | `.env` (mismo patrón, variables nuevas para NestJS) |

---

## 6. Fases de desarrollo

### Fase 0 — Scaffolding (1-2 días)
- [ ] Turborepo monorepo con workspaces: `apps/api`, `apps/web`, `apps/sandbox`, `packages/plugin-sdk`, `packages/types`
- [ ] NestJS base en `apps/api` (sin módulos de negocio aún)
- [ ] Next.js 14 + shadcn/ui en `apps/web`
- [ ] FastAPI mínimo en `apps/sandbox` (solo endpoint `/health`)
- [ ] Docker Compose: api + sandbox (--network=none) + postgres + redis
- [ ] `packages/types` con los tipos compartidos base

### Fase 1 — Auth real (2-3 días)
- [ ] `AuthModule` en NestJS: registro, login, JWT, refresh
- [ ] `TotpService` con @otplib: setup (QR SVG inline), verify, disable
- [ ] Backup codes (10 × 8 chars, un solo uso, almacenados hasheados)
- [ ] `UsersModule` con TypeORM: tabla `users`, `totp_secrets`, `backup_codes`
- [ ] Guards: `JwtAuthGuard`, `TotpRequiredGuard`
- [ ] Tests e2e de auth (Jest + Supertest)
- [ ] Panel web: pages de login, setup TOTP, backup codes

### Fase 2 — Plugin SDK y sandbox (3-4 días)
- [ ] `packages/plugin-sdk`: clase `Plugin`, decorador `@tool`, tipo `Context`
- [ ] `apps/sandbox/runner.py`: carga de plugins via importlib, endpoint `/run`
- [ ] `apps/sandbox/isolation.py`: restricciones de red (iptables / seccomp)
- [ ] `SandboxModule` en NestJS: cliente HTTP al sandbox, timeout, kill
- [ ] Plugin de ejemplo: `hello-world` (retorna texto, declara un tool)
- [ ] Tests: plugin con import de red → error controlado

### Fase 3 — Sistema de plugins en NestJS (3-4 días)
- [ ] `PluginsModule`: instalar (tar.gz), activar, desactivar, desinstalar
- [ ] Schema PostgreSQL: `plugins`, `plugin_configs`, `plugin_stacks`
- [ ] Plugin stacks: resolver dependencias, instalar en cadena
- [ ] `PluginVerificationService`: estados, flujo admin
- [ ] `PluginsController`: CRUD REST + endpoints de store
- [ ] Migrar plugins built-in (skills-base, universo-base, disciplina-dsr)

### Fase 4 — LLM proxy con restricciones (2-3 días)
- [ ] `LlmModule`: soporte Claude (Anthropic SDK) + Gemini + OpenAI
- [ ] `ToolCallValidatorService`: whitelist de tools por plugin activo
- [ ] `LlmController`: POST /llm/query (panel) y POST /llm/agent-query (ciclo agente)
- [ ] Tests: tool call no declarado → rechazado 400; código embebido en respuesta → ignorado
- [ ] Documentar el contrato: qué puede y qué no puede hacer el LLM

### Fase 5 — Ciclo del agente (3-4 días)
- [ ] `AgentsModule`: un agente = configuración de plugins + LLM + reglas
- [ ] `AgentRunService`: ejecutar un ciclo completo (propuesta → auditoría → decisión)
- [ ] Migrar lógica de veto/recorte de `trading-test` (solo puede mantener/recortar)
- [ ] `DecisionService`: guardarraíl de no-ampliación
- [ ] Panel web: vista del agente, historial de decisiones, NAV

### Fase 6 — Panel web (2-3 días, paralelo a Fase 5)
- [ ] Next.js App Router + shadcn/ui: layout con sidebar
- [ ] Pages: Dashboard, Plugins, Agentes, LLM, Config, Auth
- [ ] Autenticación SSR con cookies JWT
- [ ] Vista de store: buscar, instalar, ver badge verificado
- [ ] Vista de stacks: instalar un pack de plugins de un click

### Fase 7 — Migración y compatibilidad (2-3 días)
- [ ] Importar `data.db` de trading-test a PostgreSQL (script de migración)
- [ ] Migrar plugins Python con el nuevo SDK (wrapper fino sobre el código existente)
- [ ] Validar que todos los algoritmos dan los mismos resultados
- [ ] Tests de regresión comparando salidas trading-test vs NeuroTrader

---

## 7. Docker Compose de producción

```yaml
# docker-compose.yml (borrador)
services:
  api:
    build: ./apps/api
    environment:
      DATABASE_URL: postgresql://...
      REDIS_URL: redis://redis:6379
      JWT_SECRET: ${JWT_SECRET}
      SANDBOX_URL: http://sandbox:8001
    ports:
      - "127.0.0.1:3000:3000"
    depends_on: [postgres, redis, sandbox]

  web:
    build: ./apps/web
    environment:
      NEXT_PUBLIC_API_URL: http://api:3000
    ports:
      - "127.0.0.1:3001:3001"

  sandbox:
    build: ./apps/sandbox
    network_mode: "none"          # sin acceso a internet
    read_only: true               # filesystem read-only
    volumes:
      - plugin-data:/data         # único volumen escribible (datos de plugins)
    security_opt:
      - no-new-privileges:true
      - seccomp:./sandbox.seccomp.json

  postgres:
    image: postgres:16-alpine
    volumes:
      - pg-data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    command: redis-server --save "" --appendonly no

volumes:
  plugin-data:
  pg-data:
```

---

## 8. NeuroTrader Plugin Protocol (NTPP v1)

Protocolo de comunicación entre NestJS y el sandbox Python.

```
Transporte: HTTP/1.1 sobre Unix socket (producción) o TCP local (dev)
Autenticación: token compartido (variable de entorno, nunca expuesto fuera del compose)

Endpoints del sandbox:
  GET  /health                    → { ok: true, version: "1.0" }
  POST /plugins/{id}/load         → carga el plugin en memoria
  POST /plugins/{id}/unload       → descarga el plugin
  POST /plugins/{id}/run          → ejecuta una función del plugin
  GET  /plugins/{id}/tools        → lista de tools declarados

Body de /run:
  {
    "function": "compute_signals",
    "context": { ... },           # serializable a JSON, sin objetos complejos
    "params": { ... },
    "timeout_ms": 30000
  }

Response:
  {
    "ok": true | false,
    "result": { ... },
    "error": null | "mensaje",
    "duration_ms": 42,
    "stdout": "..."               # capturado, para logs del panel
  }
```

---

## 9. Convenciones del proyecto

- **Idioma del código:** TypeScript (NestJS, Next.js) + Python (plugins, sandbox)
- **Idioma de comentarios y commits:** español (continuidad con trading-test)
- **Tests:** Jest (NestJS + Next.js) + pytest (plugins Python)
- **Linting:** ESLint + Prettier (TS), Ruff + mypy (Python)
- **Commits:** tipo(scope): descripción en español
- **Secretos:** `.env` nunca al repo; Docker secrets o variables de entorno en CI

---

## 10. Orden de implementación recomendado

```
Semana 1:  Fase 0 (scaffolding) + Fase 1 (auth)
Semana 2:  Fase 2 (SDK + sandbox) + inicio Fase 3 (plugins NestJS)
Semana 3:  Fase 3 completa + Fase 4 (LLM proxy)
Semana 4:  Fase 5 (ciclo agente) + Fase 6 (panel web)
Semana 5:  Fase 7 (migración) + hardening + documentación
```

---

## 11. Preguntas abiertas (a decidir antes de iniciar cada fase)

1. **Base de datos dev:** ¿SQLite con TypeORM o PostgreSQL desde el día 1? Recomendación: PostgreSQL desde el principio para no tener dos caminos.
2. **Plugin store:** ¿Auto-hospedada (mismo repo `trading-store`) o integrada en `apps/api`? Recomendación: integrar en `apps/api` primero, extraer si crece.
3. **Multi-usuario:** ¿Un solo operador (Alex) o múltiples? Esto afecta al schema de `users` y al aislamiento de datos de agente.
4. **Sandbox en dev:** ¿Docker con --network=none incluso en desarrollo, o un modo dev sin aislamiento de red? Recomendación: modo dev que inyecta un flag `SANDBOX_DEV=true` que desactiva el aislamiento.
5. **Frontend:** ¿Next.js App Router o mantener el panel vanilla del trading-test como punto de partida? Recomendación: Next.js + shadcn/ui para el salto a largo plazo.
6. **Plugin stack en store:** ¿Un stack puede incluir plugins de autores distintos, o solo del mismo autor? Esto impacta en la verificación.
```
