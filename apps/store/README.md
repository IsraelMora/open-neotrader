# neurotrader-store — backend de la tienda de plugins

Parte del monorepo **NeuroTrader** (`apps/store`). Permite
publicar, explorar y votar plugins de la comunidad, de forma anónima.

> **Servicio de negocio privado.** Este código vive en el monorepo para facilitar el mantenimiento,
> pero **no está pensado para ser desplegado por usuarios**. El cliente (`apps/api`) apunta por defecto
> a `https://store.neurotrader.app`; aunque ejecutes tu propio servidor, el agente no lo usará
> salvo que sobreescribas la variable `STORE_URL` en tu `.env`.

> Diseño: `docs/specs/2026-06-12-tienda-backend-design.md` · Plan:
> `docs/plans/2026-06-12-tienda-backend-v1.md`

## Stack

- **NestJS 11** (TypeScript, strict)
- **Prisma 7** (generador `prisma-client-js`, CommonJS) + **SQLite** vía
  `@prisma/adapter-better-sqlite3` (datasource portable a Postgres)
- Firma **Ed25519** (`node:crypto`) para autenticación anónima
- Tests: **Jest** (unit co-localizados en `src/`, e2e con supertest en `test/`)

## Cómo correr

```bash
pnpm install
pnpm exec prisma migrate dev      # crea/actualiza dev.db con el esquema
pnpm start:dev                    # arranca en http://localhost:3000 (PORT configurable)
```

Variables de entorno (`.env`, nunca commiteado):

```
DATABASE_URL="file:./dev.db"      # SQLite local; cambia a postgresql://… para Postgres
PORT=3000                         # opcional
```

Tests:

```bash
pnpm test           # unit (firma, guard, validador de manifiesto)
pnpm test:e2e       # e2e (publicar/explorar/descargar/votar/nombre) sobre test.db
```

## Identidad y autenticación (anónima, sin cuentas)

No hay registro ni datos personales. El agente genera localmente un par de
claves **Ed25519**; su identidad es un **id opaco** = `base64url(sha256(clave
pública))`. Toda petición que **muta** va firmada con estas cabeceras:

| Cabecera | Contenido |
|---|---|
| `x-publisher-id` | id opaco (debe ser `hash(x-public-key)`) |
| `x-public-key` | clave pública Ed25519 (base64, formato SPKI/DER) |
| `x-timestamp` | epoch ms (ventana anti-replay de 5 min) |
| `x-signature` | firma de `timestamp\nMÉTODO\npath\nsha256(body)` (base64) |

Los `GET` (explorar/descargar) son públicos. El nombre de publicador es
**opcional** (opt-in); por defecto se es anónimo.

## API v1

| Método | Ruta | Firma | Descripción |
|---|---|---|---|
| `POST` | `/plugins` | sí | Publica una versión. Body `{ manifestToml, payloadBase64 }`. Valida el manifiesto y **rechaza `type=provider`** (código, fase 2). |
| `GET` | `/plugins` | no | Lista/busca. Query: `type`, `q`, `sort` (`votes`\|`recent`), `page`, `pageSize`. |
| `GET` | `/plugins/:publisherId/:manifestId` | no | Detalle: versiones + publicador + contadores (likes/dislikes/reports). |
| `GET` | `/plugins/:publisherId/:manifestId/:version/download` | no | Descarga manifiesto + payload (base64). |
| `POST` | `/plugins/:id/vote` | sí | Body `{ kind: 'like'\|'dislike' }`. Upsert por (plugin, votante). |
| `POST` | `/plugins/:id/report` | sí | Body `{ reason }`. Denuncia (p.ej. malware). |
| `POST` | `/publishers/name` | sí | Body `{ displayName: string\|null }`. Fija/quita el nombre opt-in. |

## Privacidad

La tienda **no guarda** configuración del agente, credenciales, carteras ni
datos personales. Solo: id opaco + clave pública + nombre opt-in + los plugins
publicados (públicos por naturaleza) + votos/reports. Es esencialmente un
registro + leaderboard.

## Qué NO está en v1 (diferido)

- **Track-record forward verificado** (anti-trampa) — la señal de calidad
  primaria; v2.
- **Capa social** (buscar/seguir por id) — v2.
- **Plugins de código** (provider/cartera/señales) + escaneo — fase 2.
- Frontend web de la tienda (lo consumirá la web pública del proyecto, F17 del
  agente).

Nota técnica: el campo `signature` de `PluginVersion` se persiste vacío en v1
(la firma se verifica en el guard al publicar; persistir la firma del contenido
para auditoría posterior se difiere a v2 junto al track-record).
