# neurotrader-web

Panel de control del agente de trading. Interfaz estática generada con **Astro 6** (output `static`) que consume la API REST del backend NestJS.

---

## Stack

| Capa | Tecnología |
|---|---|
| Framework | Astro 6 (`output: 'static'`) |
| UI | React 19 + componentes Radix UI |
| Estilos | Tailwind CSS v4 (plugin Vite) |
| Gráficos | Recharts |
| HTTP client | `ky` |
| Animaciones | Motion (Framer) + Magic UI |
| Markdown | `react-markdown` + `remark-gfm` |

---

## Conexión con el resto del sistema

```
Browser → /api/* → NestJS (puerto 3000)
```

- **Desarrollo**: el servidor Vite proxea `/api` a `http://127.0.0.1:3000` (configurado en `astro.config.mjs`).
- **Producción**: el `dist/` estático se sirve con nginx; el `nginx.conf` incluido maneja el proxy inverso a NestJS.
- **Autenticación**: token JWT almacenado en `localStorage` bajo la clave `nt_token`. Requests autenticados usan `Authorization: Bearer <token>`. Un 401 limpia el token y redirige a `/login`.

El cliente HTTP está en `src/lib/api.ts` y expone el objeto `api` con todos los endpoints agrupados (auth, panel, credenciales, plugins, store). Para chat con streaming se usa SSE directamente sobre `client.post('api/chat/stream')`.

---

## Estructura de carpetas

```
src/
├── pages/           # Una ruta por página (thin wrappers de Layout.astro)
│   ├── index.astro          # Dashboard
│   ├── chat.astro           # Chat con streaming SSE
│   ├── config.astro         # Configuración (secciones llm, loop, alerts…)
│   ├── credentials.astro    # Variables de entorno/credenciales
│   ├── journal.astro        # Evidencia JSON (solo lectura)
│   ├── logs.astro           # Streams: agent_cycles, alerts, nav…
│   ├── notifications.astro  # Notificaciones del sistema
│   ├── parametros.astro     # Parámetros de riesgo y señales
│   ├── plugins.astro        # Gestión de plugins instalados
│   ├── providers.astro      # Alpaca / Binance (modos paper/live)
│   ├── skills.astro         # Skills de plugins + skills aprendidas
│   ├── store.astro          # Tienda de plugins
│   ├── strategies.astro     # Estrategias y capas activables
│   ├── trades.astro         # Historial de operaciones
│   ├── universe.astro       # Universo de símbolos
│   └── login.astro          # Login / registro / TOTP (standalone)
├── layouts/
│   └── Layout.astro         # Shell con sidebar, reloj, tema
├── components/
│   ├── AppSidebar.tsx       # Shell principal + guard de autenticación
│   ├── Dashboard.tsx        # Portfolios + doctor (polling 15s)
│   ├── Chat.tsx             # Chat SSE con historial de 6 mensajes
│   ├── NavChart.tsx         # Gráfico NAV normalizado (polling 30s)
│   ├── Trades.tsx           # Tabla paginada (50/página, fuzzy search)
│   ├── Logs.tsx             # Streams de logs con filtro por severidad
│   ├── Plugins.tsx          # Install / activate / config / uninstall
│   ├── Store.tsx            # Browse / vote / report / install
│   ├── Strategies.tsx       # Capas activables con toggle→saveConfig
│   ├── Parametros.tsx       # Parámetros de riesgo con jerarquía de autonomía
│   ├── Config.tsx           # Editor de configuración por sección
│   ├── Providers.tsx        # Modos de broker Alpaca y Binance
│   ├── Universe.tsx         # Añadir/quitar símbolos con verificación
│   ├── Skills.tsx           # Skills de plugins + aprendidas (add/delete)
│   ├── Credentials.tsx      # Configuradas vs pendientes
│   ├── Notifications.tsx    # Panel de notificaciones (polling 20s)
│   ├── Journal.tsx          # Evidencia raw JSON (solo lectura)
│   ├── magic/               # Efectos visuales (BorderBeam, ShinyText…)
│   └── ui/                  # Primitivos shadcn/Radix
└── lib/
    ├── api.ts               # Cliente HTTP + todos los endpoints
    ├── fuzzy.ts             # Levenshtein + fuzzyFilter para búsquedas
    └── utils.ts             # cn(), fmt.money(), fmt.pct(), fmt.num()
```

---

## Cómo correr

```bash
# Desde la raíz del monorepo o desde apps/web/
npm run dev        # Astro dev en :4321, proxea /api a :3000
npm run build      # Genera dist/ estático
npm run preview    # Sirve dist/ localmente
npm run lint       # ESLint + Prettier check
npm run format     # Prettier write
```

Requiere que el backend NestJS esté corriendo en `http://127.0.0.1:3000` para que el proxy funcione en dev.

---

## Gotchas

- **Login standalone**: `login.astro` no usa `Layout.astro`. Si `nt_token` existe en localStorage, redirige directo a `/` sin renderizar el formulario.
- **TOTP en dos pasos**: login devuelve `{ totp_required: true, access_token }` con un token parcial. El token final se obtiene recién tras `POST api/auth/totp/verify`.
- **Tema dark-first**: el HTML arranca con `class="dark"`. Solo se quita si `localStorage.getItem('panel-mode') === 'light'`. El script está inline en `<head>` para evitar flash.
- **Config filtrada por página**: `Config.tsx` recibe una prop `only` que filtra qué secciones renderiza. La página `/config` muestra `['llm','loop','alerts','data_quality','providers','notifications']`; la página `/parametros` muestra `['risk','signals']`. Las secciones `risk` y `ensemble` no son editables desde `/config`.
- **Autonomía en Parámetros**: hay una jerarquía de tres niveles (`ia_first.enabled` > `advisor.auto_mode` > manual). Cuando `ia_first.enabled` es `true`, ciertos parámetros de riesgo se muestran como "adoptados automáticamente" y no son editables.
- **Streaming de chat**: no usa el objeto `api` sino `client.post('api/chat/stream')` directamente, parseando líneas `data:` del stream y extrayendo el campo `delta`.
- **Docker**: el `Dockerfile` genera la imagen con el build estático + nginx. El `nginx.conf` está en la raíz de `apps/web/`.
