# OpenNeoTrader Plugin Store — Verificación y Stacks

## Estados de verificación

```
unverified  → El autor acaba de subir el plugin. Badge: ninguno.
pending     → El autor solicitó verificación. Badge: "En revisión"
verified    → Revisado y aprobado por el equipo OpenNeoTrader. Badge: ✓ Verificado
rejected    → No pasó la revisión. Motivo visible para el autor, no para el público.
```

## Checklist de verificación manual

Cuando un plugin está en estado `pending`, el revisor de OpenNeoTrader comprueba:

### Seguridad
- [ ] No hay imports de red (`requests`, `socket`, `urllib`, `httpx`, etc.)
- [ ] No hay `subprocess`, `os.system`, `eval`, `exec`
- [ ] No hay acceso a rutas fuera de `/data/{plugin-id}/`
- [ ] Los tools declarados tienen names y parámetros coherentes con lo que hacen
- [ ] No hay intentos de inyección en el prompt (texto diseñado para manipular al LLM)
- [ ] No se almacenan datos del usuario fuera del volumen del plugin

### Corrección
- [ ] El plugin carga sin errores en un sandbox limpio
- [ ] Cada tool declarado funciona con parámetros válidos y devuelve el tipo prometido
- [ ] Los errores se manejan gracefully (no excepciones no capturadas)
- [ ] `requirements.txt` especifica versiones exactas (sin `>=` sin bound superior)

### Calidad
- [ ] `README.md` explica qué hace el plugin, sus parámetros y sus limitaciones
- [ ] Los nombres de tools son descriptivos y no colisionan con tools de otros plugins conocidos
- [ ] El plugin declara `max_memory_mb` y `max_cpu_seconds` realistas

### Para stacks
- [ ] Todos los plugins del stack están verificados individualmente
- [ ] La combinación tiene sentido semántico (no instala plugins contradictorios)
- [ ] El README del stack explica la sinergia entre los plugins

## Flujo de subida y verificación

```
Autor                          Sistema                        Revisor OpenNeoTrader
  │                               │                                │
  ├─ POST /store/plugins          │                                │
  │   { tarball, manifest }       │                                │
  │                               ├─ Valida manifest schema        │
  │                               ├─ Ejecuta en sandbox (smoke)    │
  │                               ├─ Estado: unverified            │
  │◄──────────────────────────────┤                                │
  │   { plugin_id, status }       │                                │
  │                               │                                │
  ├─ POST /store/plugins/{id}/    │                                │
  │   request-verification        │                                │
  │                               ├─ Estado: pending               │
  │                               ├─ Notifica al revisor           │
  │                               ├────────────────────────────────►
  │                               │                                │
  │                               │              GET /admin/plugins/pending
  │                               │              GET /admin/plugins/{id}/source
  │                               │                                │
  │                               │              [checklist manual]
  │                               │                                │
  │                               │◄───────────────────────────────┤
  │                               │   POST /admin/plugins/{id}/    │
  │                               │   verify { approved: true,     │
  │                               │            notes: "..." }      │
  │                               │                                │
  │                               ├─ Firma el tarball              │
  │                               ├─ Estado: verified              │
  │◄──────────────────────────────┤                                │
  │   notificación                │                                │
```

## API del store

```
# Pública (sin auth)
GET  /store/plugins                          → lista con filtros (type, verified)
GET  /store/plugins/{id}                     → detalle del plugin
GET  /store/plugins/{id}/download            → tar.gz (solo verified)
GET  /store/stacks                           → lista de stacks

# Autenticada (operador con cuenta)
POST /store/plugins                          → subir plugin
POST /store/plugins/{id}/request-verification → solicitar revisión
PATCH /store/plugins/{id}                   → actualizar (nueva versión)

# Admin OpenNeoTrader
GET  /admin/plugins/pending                 → cola de revisión
GET  /admin/plugins/{id}/source             → ver código fuente (solo admin)
POST /admin/plugins/{id}/verify             → aprobar / rechazar
POST /admin/plugins/{id}/revoke             → revocar verificación (incidente)
```

## Plugin Stack — modelo de datos

```sql
CREATE TABLE plugins (
  id          TEXT PRIMARY KEY,   -- "ensemble-signals"
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,       -- skill|universe|discipline|...|stack
  version     TEXT NOT NULL,
  author_id   UUID REFERENCES users(id),
  tarball_url TEXT,
  manifest    JSONB NOT NULL,
  status      TEXT DEFAULT 'unverified',  -- unverified|pending|verified|rejected
  verified_at TIMESTAMPTZ,
  verified_by TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE plugin_stack_members (
  stack_id    TEXT REFERENCES plugins(id),
  plugin_id   TEXT NOT NULL,        -- puede no estar en la tabla (externo)
  version_req TEXT NOT NULL,        -- ">=1.0.0"
  order_idx   INT NOT NULL,         -- orden de instalación
  PRIMARY KEY (stack_id, plugin_id)
);
```
