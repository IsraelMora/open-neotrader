# Tienda de plugins — backend (F15.D, v1) — diseño — 2026-06-12

Servidor de la tienda de plugins del agente de trading. Proyecto **independiente
y cerrado** (el agente es open-source; esto NO). Sirve el contrato de plugin de
F15.A (`trading-test`). Diseño validado con Alex (skill brainstorming).

## Objetivo

Permitir que la comunidad **publique, explore, descargue y vote** plugins de
DATOS, de forma **100% anónima por ids opacos**, sin que el servidor guarde
ningún dato de configuración ni personal de los usuarios. Es la pieza que cierra
el bucle de retroalimentación open-source.

## Alcance v1

DENTRO: registrar/publicar plugins de datos, explorar/buscar, descargar, votos
(like/dislike/report), identidad anónima por par de claves, nombre de publicador
opt-in.

FUERA (v2+): track-record forward verificado (anti-trampa), capa social
(seguir por id), plugins de código (provider/cartera/señales) + su escaneo,
frontend web de la tienda, moderación automatizada.

## Stack y estructura

- **NestJS** (TypeScript), **Prisma** (ORM) + **SQLite** (datasource portable a
  Postgres cambiando el `provider` del datasource). DTOs validados
  (`class-validator`), `ConfigModule` tipado, guards/interceptors. Acceso a datos
  vía un `PrismaService` inyectable (patrón Nest estándar: `PrismaModule` global
  que expone el cliente generado).
- Módulos: `auth` (firma), `publishers`, `plugins`, `votes`, `prisma` (servicio
  global). `AppModule` cablea.
- Carpeta `~/claude/trading-store` (repo propio). `.env` (nunca commiteado) para
  config (`DATABASE_URL`, puerto, ventana anti-replay).

```
prisma/
  schema.prisma      # modelos + datasource SQLite + generator client
  migrations/        # prisma migrate
src/
  main.ts
  app.module.ts
  config/            # ConfigModule tipado + validación de env
  prisma/            # PrismaModule + PrismaService (onModuleInit connect)
  auth/              # SignatureGuard, verificación Ed25519, anti-replay
  publishers/        # servicio + controlador (nombre opt-in)
  plugins/           # publish/list/detail/download
  votes/             # vote + report
  common/            # DTOs compartidos, validación de manifiesto (TS)
test/                # e2e (Jest + supertest)
```

## Modelo de datos (Prisma — `prisma/schema.prisma`)

Modelos declarativos en `schema.prisma` (datasource `sqlite`, generator
`prisma-client-js`). El `payload` binario usa el tipo Prisma `Bytes`. Campos:

**Publisher**
- `id: string` (PK) — opaco = `base64url(sha256(publicKey))`.
- `publicKey: string` — Ed25519 (base64), para verificar firmas.
- `displayName: string | null` — opt-in; nullable; no único (se desambigua por id).
- `createdAt: Date`.

**Plugin**
- `id: string` (PK, uuid) · `publisherId: string` (FK) · `manifestId: string`
  (el id del manifiesto) · `type: 'skill'|'universe'|'preset'|'discipline-profile'`
  · `name: string` · `description: string` · `latestVersion: string`
  · `createdAt` · `updatedAt`.
- Único `(publisherId, manifestId)` — un publicador no repite manifestId.

**PluginVersion**
- `id: string` (PK) · `pluginId: string` (FK) · `version: string` (semver)
  · `manifestToml: string` · `payload: Bytes` (tarball gzip de la carpeta; los
  de datos son pequeños) · `checksum: string` (sha256 del payload)
  · `signature: string` (firma del publicador sobre checksum+version)
  · `publishedAt: Date`.
- Único `(pluginId, version)`.

**Vote**
- `id` · `pluginId` (FK) · `voterId` (FK Publisher) · `kind: 'like'|'dislike'`
  · `createdAt`. Único `(pluginId, voterId)` → un voto por publicador (upsert).

**Report**
- `id` · `pluginId` (FK) · `reporterId` (FK) · `reason: string` · `createdAt`.
  (separado de Vote: un report es una denuncia con motivo, no excluye like/dislike).

Contadores `likeCount/dislikeCount/reportCount` se calculan por consulta (v1;
denormalizar si hace falta luego).

## Autenticación por firma (anónima, sin cuentas)

Toda petición que **muta** (publish, vote, report, set-name) va firmada. Headers:
- `x-publisher-id`, `x-public-key` (Ed25519 base64), `x-timestamp` (epoch ms),
  `x-signature` (base64).
- Mensaje firmado = `x-timestamp + "\n" + METHOD + "\n" + path + "\n" + sha256(body)`.

`SignatureGuard` (Nest):
1. Verifica `x-publisher-id === base64url(sha256(x-public-key))` (ata id↔clave).
2. Verifica `x-signature` con `x-public-key` sobre el mensaje (Ed25519, `node:crypto`).
3. Rechaza si `|now − x-timestamp| > VENTANA` (p.ej. 300 s) → anti-replay.
4. Si el Publisher existe, su `publicKey` almacenada debe coincidir con
   `x-public-key` (no se puede secuestrar un id). Si no existe, se auto-registra
   en la primera publicación.

Los GET (explorar/descargar) son **públicos**, sin firma.

## API v1

| Método | Ruta | Firma | Descripción |
|---|---|---|---|
| POST | `/plugins` | sí | Publica una versión. Body: `{ manifestToml, payloadBase64 }`. Valida manifiesto (ver abajo), rechaza `type=provider`. Crea Plugin (si nuevo) + PluginVersion; actualiza `latestVersion`. |
| GET | `/plugins` | no | Lista/busca. Query: `type`, `q` (texto en name/description), `sort` (`votes`\|`recent`), `page`, `pageSize`. Devuelve items + contadores + paginación. |
| GET | `/plugins/:publisherId/:manifestId` | no | Detalle: plugin + versiones + contadores + publisher (id + displayName). |
| GET | `/plugins/:publisherId/:manifestId/:version/download` | no | Descarga el payload (tarball) + manifiesto. |
| POST | `/plugins/:id/vote` | sí | Body `{ kind: 'like'\|'dislike' }`. Upsert por (plugin, voter). |
| POST | `/plugins/:id/report` | sí | Body `{ reason }`. Inserta Report. |
| POST | `/publishers/name` | sí | Body `{ displayName: string\|null }`. Fija/quita el nombre opt-in del publicador firmante. |

Errores: 400 (manifiesto/DTO inválido), 401 (firma/timestamp), 403 (id↔clave no
coincide), 404, 409 (versión duplicada).

## Validación de manifiesto (reimplementada en TS)

Mismas reglas que `application/plugins/manifest.py` de F15.A: cabecera `[plugin]`
completa, `id` kebab-case, `type` ∈ tipos de DATOS (rechaza `provider`), bloque
del tipo presente y válido (universe.symbols con clases válidas; skill name +
prompt/file con **file relativo sin `..`**; preset.config no vacío; discipline
con sus campos). Se valida en `common/manifest.validator.ts` (con tests que
espejan los de Python).

## Privacidad (qué NUNCA se guarda)

Config del agente, credenciales, carteras/posiciones, ni datos personales
impuestos. Solo: id opaco + clave pública + nombre opt-in (elegido) + el plugin
publicado (público por naturaleza) + votos/reports + timestamps. No se registran
IPs en logs de aplicación (documentar; si el proxy las registra, fuera de alcance
de la app). El servidor es casi sin estado de usuario: un leaderboard + registro.

## Integración con el agente (agent-side, fuera de este repo)

El agente (panel, ampliación F15.D en `trading-test`) genera su par de claves
local en el primer arranque (id = hash(pubkey)), firma y hace POST a la URL de la
tienda (configurable en el agente). La clave privada local es su identidad y
**reutiliza la "llave virtual" de F16** (misma clave para recuperar la cuenta).
Esa parte se construye en `trading-test`, no aquí; este repo expone solo el
contrato HTTP.

## Pruebas

Jest unit + e2e (supertest):
- `SignatureGuard`: firma válida acepta; inválida/expirada/replay rechaza;
  id↔clave no coincide → 403.
- Publish: manifiesto válido crea Plugin+Version; `type=provider` → 400;
  manifiesto roto → 400; versión duplicada → 409.
- Validación de manifiesto: casos espejo de los tests de Python (incluido
  file-traversal del skill).
- Votos: upsert (un voto por publicador), cambio like→dislike; report inserta.
- Búsqueda/paginación: filtros por tipo/texto, orden por votos/recientes.
- Nombre opt-in: set y clear; solo el firmante cambia el suyo.

## Decisiones abiertas / riesgos

- **Sybil/voto inflado:** con ids gratis (un keypair cuesta nada), un actor puede
  crear muchos ids y votar. v1 lo acepta (los votos son señal secundaria; el
  track-record forward de v2 es la señal primaria y resistente). Mitigación
  futura: peso por antigüedad/actividad del id, o proof-of-work al registrar.
- **Tamaño del payload:** límite por versión (p.ej. 256 KB para datos); los
  plugins de código (con binarios) son v2 y tendrán otro tratamiento.
- **Prisma/SQLite → Postgres:** cambiar `provider` del datasource a `postgresql`
  y regenerar; `Bytes` mapea a BLOB (SQLite) / bytea (Postgres). Migraciones con
  **Prisma Migrate** desde v1. Caveat conocido: SQLite no soporta enums nativos
  de Prisma → los campos `type`/`kind` se modelan como `String` con validación en
  la capa de aplicación (DTO), no como enum de BD.
