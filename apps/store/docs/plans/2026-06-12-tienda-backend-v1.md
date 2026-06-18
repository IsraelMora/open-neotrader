# Tienda de plugins — backend v1 — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Backend NestJS de la tienda de plugins: publicar/explorar/descargar/votar plugins de datos, con identidad anónima por par de claves Ed25519 firmando las mutaciones.

**Architecture:** NestJS 11 modular (auth/publishers/plugins/votes/prisma) + Prisma 7 (driver adapter better-sqlite3, SQLite). Mutaciones protegidas por un SignatureGuard que verifica firma Ed25519 + id=hash(pubkey) + anti-replay. La tienda no guarda datos personales: ids opacos, clave pública, nombre opt-in, plugins publicados y votos.

**Tech Stack:** NestJS 11, Prisma 7 (`@prisma/adapter-better-sqlite3`, `better-sqlite3`), TypeScript, class-validator, Jest + supertest, `node:crypto` (Ed25519), `tar`/gzip para el payload.

**Spec:** `docs/specs/2026-06-12-tienda-backend-design.md`

**Convención:** repo `~/claude/trading-store` (independiente, cerrado). Commits en español terminando con `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Staging git explícito. Tests: `npm test` (unit) y `npm run test:e2e`.

---

## Estructura de archivos (se crea a lo largo del plan)

```
prisma/schema.prisma            # modelos + datasource sqlite + generator
prisma/migrations/              # prisma migrate dev
generated/prisma/               # cliente Prisma generado (gitignored)
src/main.ts                     # bootstrap (ValidationPipe global)
src/app.module.ts               # raíz
src/prisma/prisma.service.ts    # PrismaClient + adapter better-sqlite3
src/prisma/prisma.module.ts     # global
src/auth/signature.util.ts      # firma/verificación Ed25519 (PURO, testeable)
src/auth/signature.guard.ts     # guard de mutaciones
src/auth/publisher.decorator.ts # @Publisher() → id del firmante
src/common/manifest.validator.ts# validación de manifiesto TOML (PURO)
src/publishers/*                # módulo nombre opt-in
src/plugins/*                   # publish/list/detail/download
src/votes/*                     # vote/report
test/*.e2e-spec.ts              # e2e supertest
```

---

## Task 1: Scaffold NestJS + Prisma (toolchain al día)

**Files:** `package.json`, `tsconfig*.json`, `nest-cli.json`, `prisma/schema.prisma`, `.env`, `.gitignore`, `src/main.ts`, `src/app.module.ts`.

- [ ] **Step 1: Crear el proyecto Nest en el repo actual**

Run (desde `~/claude/trading-store`, que ya es git repo con docs/):
```bash
npx -y @nestjs/cli@latest new . --skip-git --package-manager npm --strict
```
Si pregunta por sobrescribir/carpeta no vacía, acepta conservar `docs/`, `.gitignore` y `.git`. Esperado: instala NestJS 11, crea `src/`, `test/`, `tsconfig.json`.

- [ ] **Step 2: Instalar Prisma 7 + driver adapter SQLite**

Run:
```bash
npm i @prisma/client @prisma/adapter-better-sqlite3 better-sqlite3
npm i -D prisma
npx prisma init --datasource-provider sqlite
```
Esperado: crea `prisma/schema.prisma` y añade `DATABASE_URL` a `.env`.

- [ ] **Step 3: Configurar el generador y datasource en `prisma/schema.prisma`**

Reemplaza el contenido por:
```prisma
generator client {
  provider = "prisma-client-js"
  output   = "../generated/prisma"
}

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}
```
Y asegura en `.env`: `DATABASE_URL="file:./dev.db"`.

- [ ] **Step 4: Ignorar artefactos y fijar la base de datos de test**

Añade a `.gitignore` (ya existe del repo): `generated/`, `dev.db`, `test.db`. Crea `.env.test` con `DATABASE_URL="file:./test.db"`.

- [ ] **Step 5: Verificar build y arranque**

Run:
```bash
npx prisma generate
npm run build
```
Esperado: compila sin errores (aún sin modelos reales, el cliente se genera vacío de modelos).

- [ ] **Step 6: Commit**
```bash
git add package.json package-lock.json tsconfig.json tsconfig.build.json nest-cli.json prisma/schema.prisma .gitignore src/ test/
git commit -m "chore: scaffold NestJS 11 + Prisma 7 (driver adapter sqlite)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Esquema de datos Prisma + migración inicial

**Files:** `prisma/schema.prisma`, `prisma/migrations/`.

- [ ] **Step 1: Definir los modelos en `prisma/schema.prisma`** (añadir tras el datasource)

```prisma
model Publisher {
  id          String   @id            // base64url(sha256(publicKey))
  publicKey   String   @unique        // Ed25519, base64
  displayName String?                 // opt-in
  createdAt   DateTime @default(now())
  plugins     Plugin[]
  votes       Vote[]
  reports     Report[]
}

model Plugin {
  id            String          @id @default(uuid())
  publisherId   String
  publisher     Publisher       @relation(fields: [publisherId], references: [id])
  manifestId    String
  type          String          // skill|universe|preset|discipline-profile
  name          String
  description   String
  latestVersion String
  createdAt     DateTime        @default(now())
  updatedAt     DateTime        @updatedAt
  versions      PluginVersion[]
  votes         Vote[]
  reports       Report[]
  @@unique([publisherId, manifestId])
}

model PluginVersion {
  id           String   @id @default(uuid())
  pluginId     String
  plugin       Plugin   @relation(fields: [pluginId], references: [id])
  version      String
  manifestToml String
  payload      Bytes
  checksum     String
  signature    String
  publishedAt  DateTime @default(now())
  @@unique([pluginId, version])
}

model Vote {
  id        String   @id @default(uuid())
  pluginId  String
  plugin    Plugin   @relation(fields: [pluginId], references: [id])
  voterId   String
  voter     Publisher @relation(fields: [voterId], references: [id])
  kind      String   // like|dislike
  createdAt DateTime @default(now())
  @@unique([pluginId, voterId])
}

model Report {
  id         String   @id @default(uuid())
  pluginId   String
  plugin     Plugin   @relation(fields: [pluginId], references: [id])
  reporterId String
  reporter   Publisher @relation(fields: [reporterId], references: [id])
  reason     String
  createdAt  DateTime @default(now())
}
```

- [ ] **Step 2: Crear la migración**

Run:
```bash
npx prisma migrate dev --name init
```
Esperado: crea `prisma/migrations/<ts>_init/migration.sql`, aplica a `dev.db`, regenera el cliente.

- [ ] **Step 3: Verificar el cliente generado tipa los modelos**

Run:
```bash
npx prisma generate && npm run build
```
Esperado: compila; `generated/prisma` contiene los tipos `Publisher`, `Plugin`, etc.

- [ ] **Step 4: Commit**
```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(db): esquema Prisma (publisher/plugin/version/vote/report) + migración init

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: PrismaService + módulo global

**Files:** `src/prisma/prisma.service.ts`, `src/prisma/prisma.module.ts`, `src/app.module.ts`.

- [ ] **Step 1: Crear `src/prisma/prisma.service.ts`**
```typescript
import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '../../generated/prisma';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  constructor() {
    const url = process.env.DATABASE_URL ?? 'file:./dev.db';
    super({ adapter: new PrismaBetterSqlite3({ url }) });
  }
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }
}
```

- [ ] **Step 2: Crear `src/prisma/prisma.module.ts`**
```typescript
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
```

- [ ] **Step 3: Importar `PrismaModule` en `src/app.module.ts`**
```typescript
import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';

@Module({ imports: [PrismaModule] })
export class AppModule {}
```

- [ ] **Step 4: ValidationPipe global en `src/main.ts`**
```typescript
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(process.env.PORT ? Number(process.env.PORT) : 3000);
}
bootstrap();
```

- [ ] **Step 5: Verificar arranque**

Run: `npm run build && timeout 8 npm run start || true`
Esperado: build OK; el server arranca y conecta a SQLite sin error (ignora el corte por timeout).

- [ ] **Step 6: Commit**
```bash
git add src/prisma src/app.module.ts src/main.ts
git commit -m "feat(prisma): PrismaService con driver adapter + módulo global + ValidationPipe

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Firma Ed25519 (utilidad pura, TDD)

**Files:** `src/auth/signature.util.ts`, `test/signature.util.spec.ts`.

- [ ] **Step 1: Escribir el test que falla** en `test/signature.util.spec.ts`
```typescript
import { generateKeyPairSync } from 'node:crypto';
import { publisherIdFromPublicKey, buildSignedMessage, verifySignature, signMessage } from '../src/auth/signature.util';

function newKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return { pub, privateKey };
}

describe('signature.util', () => {
  it('id deriva determinista de la clave pública', () => {
    const { pub } = newKeys();
    expect(publisherIdFromPublicKey(pub)).toBe(publisherIdFromPublicKey(pub));
    expect(publisherIdFromPublicKey(pub)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('firma y verifica un mensaje', () => {
    const { pub, privateKey } = newKeys();
    const msg = buildSignedMessage('1700000000000', 'POST', '/plugins', 'abc');
    const sig = signMessage(privateKey, msg);
    expect(verifySignature(pub, msg, sig)).toBe(true);
  });

  it('rechaza firma de otra clave', () => {
    const a = newKeys(); const b = newKeys();
    const msg = buildSignedMessage('1700000000000', 'POST', '/plugins', 'abc');
    const sig = signMessage(a.privateKey, msg);
    expect(verifySignature(b.pub, msg, sig)).toBe(false);
  });
});
```

- [ ] **Step 2: Correr y ver fallar**

Run: `npm test -- signature.util`
Esperado: FAIL (módulo inexistente).

- [ ] **Step 3: Implementar `src/auth/signature.util.ts`**
```typescript
import { createHash, createPublicKey, verify, sign, KeyObject } from 'node:crypto';

export function publisherIdFromPublicKey(publicKeyBase64: string): string {
  return createHash('sha256').update(publicKeyBase64).digest('base64url');
}

export function buildSignedMessage(
  timestamp: string, method: string, path: string, bodyHashHex: string,
): string {
  return [timestamp, method.toUpperCase(), path, bodyHashHex].join('\n');
}

export function sha256Hex(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

export function signMessage(privateKey: KeyObject, message: string): string {
  return sign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64');
}

export function verifySignature(
  publicKeyBase64: string, message: string, signatureBase64: string,
): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeyBase64, 'base64'),
      format: 'der', type: 'spki',
    });
    return verify(null, Buffer.from(message, 'utf8'), key,
      Buffer.from(signatureBase64, 'base64'));
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Correr y ver pasar**

Run: `npm test -- signature.util`
Esperado: PASS (3 tests).

- [ ] **Step 5: Commit**
```bash
git add src/auth/signature.util.ts test/signature.util.spec.ts
git commit -m "feat(auth): utilidad Ed25519 pura (id=hash(pubkey), firmar/verificar)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: SignatureGuard + decorador @Publisher

**Files:** `src/auth/signature.guard.ts`, `src/auth/publisher.decorator.ts`, `src/auth/auth.module.ts`, `test/signature.guard.spec.ts`.

- [ ] **Step 1: Escribir el test que falla** en `test/signature.guard.spec.ts`
```typescript
import { ExecutionContext, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { SignatureGuard } from '../src/auth/signature.guard';
import { buildSignedMessage, signMessage, sha256Hex, publisherIdFromPublicKey } from '../src/auth/signature.util';

function keys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return { pub, privateKey };
}
function ctx(headers: Record<string, string>, method = 'POST', url = '/plugins', body: any = {}): ExecutionContext {
  const req: any = { headers, method, url, body };
  return { switchToHttp: () => ({ getRequest: () => req }) } as any;
}
function signedHeaders(k: ReturnType<typeof keys>, body: any, ts = String(Date.now())) {
  const bodyHash = sha256Hex(JSON.stringify(body ?? {}));
  const msg = buildSignedMessage(ts, 'POST', '/plugins', bodyHash);
  return {
    'x-publisher-id': publisherIdFromPublicKey(k.pub),
    'x-public-key': k.pub,
    'x-timestamp': ts,
    'x-signature': signMessage(k.privateKey, msg),
  };
}

describe('SignatureGuard', () => {
  const guard = new SignatureGuard(300_000);

  it('acepta una firma válida y fija req.publisherId', () => {
    const k = keys(); const body = { a: 1 };
    const c = ctx(signedHeaders(k, body), 'POST', '/plugins', body);
    expect(guard.canActivate(c)).toBe(true);
    expect((c.switchToHttp().getRequest() as any).publisherId).toBe(publisherIdFromPublicKey(k.pub));
  });

  it('rechaza id que no coincide con la clave (403)', () => {
    const k = keys(); const body = {};
    const h = signedHeaders(k, body); h['x-publisher-id'] = 'otro';
    expect(() => guard.canActivate(ctx(h, 'POST', '/plugins', body))).toThrow(ForbiddenException);
  });

  it('rechaza timestamp viejo (401)', () => {
    const k = keys(); const body = {};
    const h = signedHeaders(k, body, String(Date.now() - 10 * 60 * 1000));
    expect(() => guard.canActivate(ctx(h, 'POST', '/plugins', body))).toThrow(UnauthorizedException);
  });

  it('rechaza firma inválida (401)', () => {
    const k = keys(); const body = {};
    const h = signedHeaders(k, body); h['x-signature'] = Buffer.from('mala').toString('base64');
    expect(() => guard.canActivate(ctx(h, 'POST', '/plugins', body))).toThrow(UnauthorizedException);
  });
});
```

- [ ] **Step 2: Correr y ver fallar**

Run: `npm test -- signature.guard`
Esperado: FAIL (módulo inexistente).

- [ ] **Step 3: Implementar `src/auth/signature.guard.ts`**
```typescript
import {
  CanActivate, ExecutionContext, Injectable,
  UnauthorizedException, ForbiddenException,
} from '@nestjs/common';
import {
  buildSignedMessage, sha256Hex, verifySignature, publisherIdFromPublicKey,
} from './signature.util';

@Injectable()
export class SignatureGuard implements CanActivate {
  constructor(private readonly windowMs = 300_000) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const h = req.headers as Record<string, string>;
    const id = h['x-publisher-id'];
    const pub = h['x-public-key'];
    const ts = h['x-timestamp'];
    const sig = h['x-signature'];
    if (!id || !pub || !ts || !sig) {
      throw new UnauthorizedException('faltan cabeceras de firma');
    }
    if (publisherIdFromPublicKey(pub) !== id) {
      throw new ForbiddenException('el id no corresponde a la clave pública');
    }
    const edad = Math.abs(Date.now() - Number(ts));
    if (!Number.isFinite(edad) || edad > this.windowMs) {
      throw new UnauthorizedException('timestamp fuera de la ventana (replay)');
    }
    const bodyHash = sha256Hex(JSON.stringify(req.body ?? {}));
    const path = (req.url as string).split('?')[0];
    const msg = buildSignedMessage(ts, req.method, path, bodyHash);
    if (!verifySignature(pub, msg, sig)) {
      throw new UnauthorizedException('firma inválida');
    }
    req.publisherId = id;
    req.publicKey = pub;
    return true;
  }
}
```

- [ ] **Step 4: Implementar `src/auth/publisher.decorator.ts`**
```typescript
import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const Publisher = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): { id: string; publicKey: string } => {
    const req = ctx.switchToHttp().getRequest();
    return { id: req.publisherId, publicKey: req.publicKey };
  },
);
```

- [ ] **Step 5: Implementar `src/auth/auth.module.ts`**
```typescript
import { Module } from '@nestjs/common';
import { SignatureGuard } from './signature.guard';

@Module({ providers: [SignatureGuard], exports: [SignatureGuard] })
export class AuthModule {}
```

- [ ] **Step 6: Correr y ver pasar**

Run: `npm test -- signature.guard`
Esperado: PASS (4 tests).

- [ ] **Step 7: Commit**
```bash
git add src/auth test/signature.guard.spec.ts
git commit -m "feat(auth): SignatureGuard (id=hash(pubkey), firma, anti-replay) + @Publisher

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Validador de manifiesto (puro, TDD)

**Files:** `src/common/manifest.validator.ts`, `test/manifest.validator.spec.ts`. Instala `smol-toml` (parser TOML TS): `npm i smol-toml`.

- [ ] **Step 1: Escribir el test que falla** en `test/manifest.validator.spec.ts`
```typescript
import { parseAndValidateManifest, ManifestError } from '../src/common/manifest.validator';

const UNI = `
[plugin]
id = "tech-momentum"
name = "Tech"
type = "universe"
version = "1.0.0"
author = "alex"
description = "d"
[universe]
symbols = { NVDA = "equity" }
`;

describe('manifest.validator', () => {
  it('acepta un universe válido', () => {
    const m = parseAndValidateManifest(UNI);
    expect(m.id).toBe('tech-momentum');
    expect(m.type).toBe('universe');
  });
  it('rechaza type=provider (código, fase 2)', () => {
    expect(() => parseAndValidateManifest(UNI.replace('universe', 'provider')))
      .toThrow(ManifestError);
  });
  it('rechaza id no kebab', () => {
    expect(() => parseAndValidateManifest(UNI.replace('tech-momentum', 'Tech X')))
      .toThrow(ManifestError);
  });
  it('rechaza skill con file traversal', () => {
    const skill = `
[plugin]
id = "s"
name = "S"
type = "skill"
version = "1.0.0"
author = "a"
description = "d"
[skill]
name = "x"
file = "../../etc/passwd"
`;
    expect(() => parseAndValidateManifest(skill)).toThrow(ManifestError);
  });
});
```

- [ ] **Step 2: Correr y ver fallar**

Run: `npm test -- manifest.validator`
Esperado: FAIL.

- [ ] **Step 3: Implementar `src/common/manifest.validator.ts`** (espeja la versión Python de F15.A)
```typescript
import { parse as parseToml } from 'smol-toml';

export class ManifestError extends Error {}

const CLASES_ACTIVO = new Set(['equity', 'etf', 'crypto', 'commodity']);
const TIPOS_DATOS = new Set(['skill', 'universe', 'preset', 'discipline-profile']);
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface Manifest {
  id: string; name: string; type: string; version: string;
  author: string; description: string;
  payload: Record<string, unknown>;
  configSpec: Record<string, unknown>;
  raw: Record<string, unknown>;
}

export function parseAndValidateManifest(text: string): Manifest {
  let data: any;
  try { data = parseToml(text); }
  catch (e) { throw new ManifestError(`TOML inválido: ${(e as Error).message}`); }

  const meta = data.plugin;
  if (typeof meta !== 'object' || meta === null) throw new ManifestError('falta [plugin]');
  for (const c of ['id', 'name', 'type', 'version', 'author', 'description']) {
    if (typeof meta[c] !== 'string' || !meta[c].trim()) {
      throw new ManifestError(`[plugin].${c} requerido`);
    }
  }
  if (!KEBAB.test(meta.id)) throw new ManifestError(`id '${meta.id}' no es kebab-case`);
  if (meta.type === 'provider') throw new ManifestError('type=provider es fase 2 (código)');
  if (!TIPOS_DATOS.has(meta.type)) throw new ManifestError(`type '${meta.type}' desconocido`);

  const bloque: Record<string, string> = {
    skill: 'skill', universe: 'universe', preset: 'preset',
    'discipline-profile': 'discipline',
  };
  const payload = data[bloque[meta.type]];
  if (typeof payload !== 'object' || payload === null) {
    throw new ManifestError(`falta el bloque [${bloque[meta.type]}]`);
  }
  validatePayload(meta.type, payload);

  const cfg = (typeof data.config === 'object' && data.config) ? data.config : {};
  const configSpec: Record<string, unknown> = {};
  if (cfg.fields != null) configSpec.fields = cfg.fields;
  if (cfg.form != null) configSpec.form = cfg.form;

  return {
    id: meta.id, name: meta.name, type: meta.type, version: meta.version,
    author: meta.author, description: meta.description,
    payload, configSpec, raw: data,
  };
}

function validatePayload(type: string, payload: any): void {
  if (type === 'universe') {
    const syms = payload.symbols;
    if (typeof syms !== 'object' || syms === null || !Object.keys(syms).length) {
      throw new ManifestError('[universe].symbols debe ser un objeto no vacío');
    }
    for (const [sym, clase] of Object.entries(syms)) {
      if (!CLASES_ACTIVO.has(clase as string)) {
        throw new ManifestError(`clase '${clase}' inválida para ${sym}`);
      }
    }
  } else if (type === 'skill') {
    if (typeof payload.name !== 'string') throw new ManifestError('[skill].name requerido');
    const file = payload.file;
    if (typeof file === 'string') {
      const partes = file.split('/');
      if (file.startsWith('/') || partes.includes('..')) {
        throw new ManifestError('[skill].file debe ser relativo sin ".."');
      }
    }
    if (typeof payload.prompt !== 'string' && typeof file !== 'string') {
      throw new ManifestError('[skill] necesita prompt o file');
    }
  } else if (type === 'preset') {
    if (typeof payload.config !== 'object' || payload.config === null
        || !Object.keys(payload.config).length) {
      throw new ManifestError('[preset].config no vacío requerido');
    }
  } else if (type === 'discipline-profile') {
    const reqs: [string, string][] = [
      ['dsr_threshold', 'number'], ['min_sources', 'number'],
      ['stress_windows', 'object'], ['ex_ante_discount', 'number'],
      ['require_preregistration', 'boolean'],
    ];
    for (const [campo, t] of reqs) {
      if (typeof payload[campo] !== t) throw new ManifestError(`[discipline].${campo} inválido`);
    }
  }
}
```

- [ ] **Step 4: Correr y ver pasar**

Run: `npm test -- manifest.validator`
Esperado: PASS (4 tests).

- [ ] **Step 5: Commit**
```bash
git add src/common/manifest.validator.ts test/manifest.validator.spec.ts package.json package-lock.json
git commit -m "feat(common): validador de manifiesto en TS (espejo de F15.A) + smol-toml

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Publicar plugin (POST /plugins) — e2e

**Files:** `src/plugins/plugins.service.ts`, `src/plugins/plugins.controller.ts`, `src/plugins/dto/publish.dto.ts`, `src/plugins/plugins.module.ts`, `test/plugins.e2e-spec.ts`.

- [ ] **Step 1: DTO en `src/plugins/dto/publish.dto.ts`**
```typescript
import { IsString, IsNotEmpty, IsBase64 } from 'class-validator';

export class PublishDto {
  @IsString() @IsNotEmpty() manifestToml!: string;
  @IsString() @IsBase64() payloadBase64!: string;
}
```

- [ ] **Step 2: Escribir el e2e que falla** en `test/plugins.e2e-spec.ts`

```typescript
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildSignedMessage, sha256Hex, signMessage, publisherIdFromPublicKey } from '../src/auth/signature.util';

function keys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return { pub, privateKey };
}
const UNI = `
[plugin]
id = "demo-uni"
name = "Demo"
type = "universe"
version = "1.0.0"
author = "a"
description = "d"
[universe]
symbols = { NVDA = "equity" }
`;
function headersFor(k: ReturnType<typeof keys>, method: string, path: string, body: any) {
  const ts = String(Date.now());
  const msg = buildSignedMessage(ts, method, path, sha256Hex(JSON.stringify(body)));
  return {
    'x-publisher-id': publisherIdFromPublicKey(k.pub),
    'x-public-key': k.pub, 'x-timestamp': ts,
    'x-signature': signMessage(k.privateKey, msg),
  };
}

describe('Plugins (e2e)', () => {
  let app: INestApplication; let prisma: PrismaService;
  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
  });
  afterAll(async () => { await app.close(); });
  beforeEach(async () => {
    await prisma.vote.deleteMany(); await prisma.report.deleteMany();
    await prisma.pluginVersion.deleteMany(); await prisma.plugin.deleteMany();
    await prisma.publisher.deleteMany();
  });

  it('publica un plugin válido (firmado)', async () => {
    const k = keys();
    const body = { manifestToml: UNI, payloadBase64: Buffer.from('x').toString('base64') };
    const res = await request(app.getHttpServer())
      .post('/plugins').set(headersFor(k, 'POST', '/plugins', body)).send(body);
    expect(res.status).toBe(201);
    expect(res.body.manifestId).toBe('demo-uni');
  });

  it('rechaza sin firma (401)', async () => {
    const body = { manifestToml: UNI, payloadBase64: 'eA==' };
    const res = await request(app.getHttpServer()).post('/plugins').send(body);
    expect(res.status).toBe(401);
  });

  it('rechaza type=provider (400)', async () => {
    const k = keys();
    const body = { manifestToml: UNI.replace('universe', 'provider'), payloadBase64: 'eA==' };
    const res = await request(app.getHttpServer())
      .post('/plugins').set(headersFor(k, 'POST', '/plugins', body)).send(body);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 3: Configurar el e2e para usar la BD de test**

Crea `test/jest-e2e.json` si no existe (Nest lo trae); añade en `package.json` script `"test:e2e": "DATABASE_URL=file:./test.db jest --config ./test/jest-e2e.json"`. Antes de e2e, aplica migraciones a test.db: añade script `"pretest:e2e": "DATABASE_URL=file:./test.db npx prisma migrate deploy"`.

- [ ] **Step 4: Correr y ver fallar**

Run: `npm run test:e2e -- plugins`
Esperado: FAIL (ruta /plugins inexistente → 404).

- [ ] **Step 5: Implementar `src/plugins/plugins.service.ts`**
```typescript
import { Injectable, BadRequestException, ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { parseAndValidateManifest, ManifestError } from '../common/manifest.validator';

@Injectable()
export class PluginsService {
  constructor(private readonly prisma: PrismaService) {}

  async publish(publisherId: string, publicKey: string, manifestToml: string, payloadBase64: string) {
    let m;
    try { m = parseAndValidateManifest(manifestToml); }
    catch (e) {
      if (e instanceof ManifestError) throw new BadRequestException(e.message);
      throw e;
    }
    const payload = Buffer.from(payloadBase64, 'base64');
    const checksum = createHash('sha256').update(payload).digest('hex');

    await this.prisma.publisher.upsert({
      where: { id: publisherId },
      create: { id: publisherId, publicKey },
      update: {},
    });

    const plugin = await this.prisma.plugin.upsert({
      where: { publisherId_manifestId: { publisherId, manifestId: m.id } },
      create: {
        publisherId, manifestId: m.id, type: m.type, name: m.name,
        description: m.description, latestVersion: m.version,
      },
      update: { name: m.name, description: m.description, latestVersion: m.version },
    });

    const dup = await this.prisma.pluginVersion.findUnique({
      where: { pluginId_version: { pluginId: plugin.id, version: m.version } },
    });
    if (dup) throw new ConflictException(`versión ${m.version} ya publicada`);

    await this.prisma.pluginVersion.create({
      data: {
        pluginId: plugin.id, version: m.version, manifestToml,
        payload, checksum, signature: '',
      },
    });
    return { id: plugin.id, manifestId: m.id, version: m.version };
  }
}
```

- [ ] **Step 6: Implementar `src/plugins/plugins.controller.ts`**
```typescript
import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { SignatureGuard } from '../auth/signature.guard';
import { Publisher } from '../auth/publisher.decorator';
import { PluginsService } from './plugins.service';
import { PublishDto } from './dto/publish.dto';

@Controller('plugins')
export class PluginsController {
  constructor(private readonly plugins: PluginsService) {}

  @Post()
  @UseGuards(SignatureGuard)
  async publish(@Publisher() pub: { id: string; publicKey: string }, @Body() dto: PublishDto) {
    return this.plugins.publish(pub.id, pub.publicKey, dto.manifestToml, dto.payloadBase64);
  }
}
```

- [ ] **Step 7: Implementar `src/plugins/plugins.module.ts` y registrarlo**
```typescript
import { Module } from '@nestjs/common';
import { PluginsController } from './plugins.controller';
import { PluginsService } from './plugins.service';
import { AuthModule } from '../auth/auth.module';

@Module({ imports: [AuthModule], controllers: [PluginsController], providers: [PluginsService] })
export class PluginsModule {}
```
Añade `PluginsModule` a `imports` de `AppModule`.

- [ ] **Step 8: Correr y ver pasar**

Run: `npm run test:e2e -- plugins`
Esperado: PASS (3 tests).

- [ ] **Step 9: Commit**
```bash
git add src/plugins src/app.module.ts test/plugins.e2e-spec.ts package.json
git commit -m "feat(plugins): POST /plugins firmado (valida manifiesto, rechaza código, versiona)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Explorar, detalle y descargar (GET públicos) — e2e

**Files:** `src/plugins/plugins.service.ts` (+métodos), `src/plugins/plugins.controller.ts` (+rutas), `test/plugins.e2e-spec.ts` (+casos).

- [ ] **Step 1: Añadir e2e** (a `test/plugins.e2e-spec.ts`, dentro del describe)
```typescript
  it('lista y filtra por tipo', async () => {
    const k = keys();
    const body = { manifestToml: UNI, payloadBase64: Buffer.from('x').toString('base64') };
    await request(app.getHttpServer()).post('/plugins').set(headersFor(k, 'POST', '/plugins', body)).send(body);
    const res = await request(app.getHttpServer()).get('/plugins?type=universe');
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(1);
    expect(res.body.items[0].manifestId).toBe('demo-uni');
  });

  it('descarga el payload', async () => {
    const k = keys(); const pid = publisherIdFromPublicKey(k.pub);
    const body = { manifestToml: UNI, payloadBase64: Buffer.from('hola').toString('base64') };
    await request(app.getHttpServer()).post('/plugins').set(headersFor(k, 'POST', '/plugins', body)).send(body);
    const res = await request(app.getHttpServer()).get(`/plugins/${pid}/demo-uni/1.0.0/download`);
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body.payloadBase64, 'base64').toString()).toBe('hola');
  });
```

- [ ] **Step 2: Correr y ver fallar**

Run: `npm run test:e2e -- plugins`
Esperado: FAIL (404 en GET).

- [ ] **Step 3: Añadir métodos al servicio** (`src/plugins/plugins.service.ts`)
```typescript
  async list(params: { type?: string; q?: string; sort?: string; page?: number; pageSize?: number }) {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20));
    const where: any = {};
    if (params.type) where.type = params.type;
    if (params.q) where.OR = [
      { name: { contains: params.q } }, { description: { contains: params.q } },
    ];
    const orderBy = params.sort === 'recent'
      ? { updatedAt: 'desc' as const } : { createdAt: 'desc' as const };
    const [items, total] = await Promise.all([
      this.prisma.plugin.findMany({
        where, orderBy, skip: (page - 1) * pageSize, take: pageSize,
        include: { _count: { select: { votes: true, reports: true } } },
      }),
      this.prisma.plugin.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  async detail(publisherId: string, manifestId: string) {
    const plugin = await this.prisma.plugin.findUnique({
      where: { publisherId_manifestId: { publisherId, manifestId } },
      include: {
        versions: { orderBy: { publishedAt: 'desc' }, select: { version: true, publishedAt: true, checksum: true } },
        publisher: { select: { id: true, displayName: true } },
      },
    });
    if (!plugin) throw new (await import('@nestjs/common')).NotFoundException('plugin no encontrado');
    const likes = await this.prisma.vote.count({ where: { pluginId: plugin.id, kind: 'like' } });
    const dislikes = await this.prisma.vote.count({ where: { pluginId: plugin.id, kind: 'dislike' } });
    const reports = await this.prisma.report.count({ where: { pluginId: plugin.id } });
    return { ...plugin, counts: { likes, dislikes, reports } };
  }

  async download(publisherId: string, manifestId: string, version: string) {
    const plugin = await this.prisma.plugin.findUnique({
      where: { publisherId_manifestId: { publisherId, manifestId } },
    });
    if (!plugin) throw new (await import('@nestjs/common')).NotFoundException('plugin no encontrado');
    const v = await this.prisma.pluginVersion.findUnique({
      where: { pluginId_version: { pluginId: plugin.id, version } },
    });
    if (!v) throw new (await import('@nestjs/common')).NotFoundException('versión no encontrada');
    return { manifestToml: v.manifestToml, payloadBase64: Buffer.from(v.payload).toString('base64'), checksum: v.checksum };
  }
```

- [ ] **Step 4: Añadir rutas al controlador** (`src/plugins/plugins.controller.ts`)
```typescript
import { Get, Param, Query } from '@nestjs/common';
// ...dentro de la clase:
  @Get()
  list(@Query('type') type?: string, @Query('q') q?: string,
       @Query('sort') sort?: string, @Query('page') page?: string,
       @Query('pageSize') pageSize?: string) {
    return this.plugins.list({ type, q, sort,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined });
  }

  @Get(':publisherId/:manifestId')
  detail(@Param('publisherId') p: string, @Param('manifestId') m: string) {
    return this.plugins.detail(p, m);
  }

  @Get(':publisherId/:manifestId/:version/download')
  download(@Param('publisherId') p: string, @Param('manifestId') m: string, @Param('version') v: string) {
    return this.plugins.download(p, m, v);
  }
```

- [ ] **Step 5: Correr y ver pasar**

Run: `npm run test:e2e -- plugins`
Esperado: PASS (5 tests).

- [ ] **Step 6: Commit**
```bash
git add src/plugins test/plugins.e2e-spec.ts
git commit -m "feat(plugins): GET lista/detalle/descarga (públicos, con contadores)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Votos y reports (POST firmados) — e2e

**Files:** `src/votes/votes.service.ts`, `src/votes/votes.controller.ts`, `src/votes/dto/*.ts`, `src/votes/votes.module.ts`, `test/votes.e2e-spec.ts`.

- [ ] **Step 1: DTOs** en `src/votes/dto/vote.dto.ts` y `report.dto.ts`
```typescript
// vote.dto.ts
import { IsIn } from 'class-validator';
export class VoteDto { @IsIn(['like', 'dislike']) kind!: 'like' | 'dislike'; }
// report.dto.ts
import { IsString, IsNotEmpty, MaxLength } from 'class-validator';
export class ReportDto { @IsString() @IsNotEmpty() @MaxLength(500) reason!: string; }
```

- [ ] **Step 2: Escribir e2e** en `test/votes.e2e-spec.ts` (reusa los helpers; publica un plugin y vota)
```typescript
// Reusa el patrón de plugins.e2e-spec (keys/headersFor/UNI, beforeAll/afterAll/beforeEach idénticos).
// Casos:
//  - like incrementa likes a 1; segundo like del MISMO id sigue en 1 (upsert)
//  - cambiar like→dislike del mismo id deja likes=0, dislikes=1
//  - report inserta y aparece en counts.reports
//  - votar sin firma → 401
```
Implementa esos 4 casos concretos copiando `headersFor`/`keys`/`UNI` del archivo de plugins, publicando primero el plugin y usando su `id` devuelto en `POST /plugins/:id/vote`.

- [ ] **Step 3: Correr y ver fallar**

Run: `npm run test:e2e -- votes`
Esperado: FAIL (404).

- [ ] **Step 4: Implementar `src/votes/votes.service.ts`**
```typescript
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class VotesService {
  constructor(private readonly prisma: PrismaService) {}

  async vote(pluginId: string, voterId: string, voterKey: string, kind: 'like' | 'dislike') {
    const plugin = await this.prisma.plugin.findUnique({ where: { id: pluginId } });
    if (!plugin) throw new NotFoundException('plugin no encontrado');
    await this.prisma.publisher.upsert({
      where: { id: voterId }, create: { id: voterId, publicKey: voterKey }, update: {},
    });
    await this.prisma.vote.upsert({
      where: { pluginId_voterId: { pluginId, voterId } },
      create: { pluginId, voterId, kind },
      update: { kind },
    });
    return { ok: true };
  }

  async report(pluginId: string, reporterId: string, reporterKey: string, reason: string) {
    const plugin = await this.prisma.plugin.findUnique({ where: { id: pluginId } });
    if (!plugin) throw new NotFoundException('plugin no encontrado');
    await this.prisma.publisher.upsert({
      where: { id: reporterId }, create: { id: reporterId, publicKey: reporterKey }, update: {},
    });
    await this.prisma.report.create({ data: { pluginId, reporterId, reason } });
    return { ok: true };
  }
}
```

- [ ] **Step 5: Implementar `src/votes/votes.controller.ts`**
```typescript
import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { SignatureGuard } from '../auth/signature.guard';
import { Publisher } from '../auth/publisher.decorator';
import { VotesService } from './votes.service';
import { VoteDto } from './dto/vote.dto';
import { ReportDto } from './dto/report.dto';

@Controller('plugins/:id')
export class VotesController {
  constructor(private readonly votes: VotesService) {}

  @Post('vote')
  @UseGuards(SignatureGuard)
  vote(@Param('id') id: string, @Publisher() pub: { id: string; publicKey: string }, @Body() dto: VoteDto) {
    return this.votes.vote(id, pub.id, pub.publicKey, dto.kind);
  }

  @Post('report')
  @UseGuards(SignatureGuard)
  report(@Param('id') id: string, @Publisher() pub: { id: string; publicKey: string }, @Body() dto: ReportDto) {
    return this.votes.report(id, pub.id, pub.publicKey, dto.reason);
  }
}
```

- [ ] **Step 6: Módulo `src/votes/votes.module.ts` + registrar en AppModule**
```typescript
import { Module } from '@nestjs/common';
import { VotesController } from './votes.controller';
import { VotesService } from './votes.service';
import { AuthModule } from '../auth/auth.module';

@Module({ imports: [AuthModule], controllers: [VotesController], providers: [VotesService] })
export class VotesModule {}
```
Añade `VotesModule` a `AppModule`.

- [ ] **Step 7: Correr y ver pasar**

Run: `npm run test:e2e -- votes`
Esperado: PASS (4 casos).

- [ ] **Step 8: Commit**
```bash
git add src/votes src/app.module.ts test/votes.e2e-spec.ts
git commit -m "feat(votes): vote (upsert) y report firmados + contadores

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: Nombre de publicador opt-in (POST /publishers/name) — e2e

**Files:** `src/publishers/publishers.service.ts`, `publishers.controller.ts`, `dto/set-name.dto.ts`, `publishers.module.ts`, `test/publishers.e2e-spec.ts`.

- [ ] **Step 1: DTO** `src/publishers/dto/set-name.dto.ts`
```typescript
import { IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';
export class SetNameDto {
  @ValidateIf((o) => o.displayName !== null)
  @IsOptional() @IsString() @MaxLength(40)
  displayName!: string | null;
}
```

- [ ] **Step 2: e2e** `test/publishers.e2e-spec.ts`: fija nombre (firmado) → detalle del publicador lo muestra; pone `null` → lo quita; sin firma → 401. (Reusa helpers `keys`/`headersFor`.)

- [ ] **Step 3: Correr y ver fallar** — `npm run test:e2e -- publishers` → FAIL (404).

- [ ] **Step 4: Servicio** `src/publishers/publishers.service.ts`
```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PublishersService {
  constructor(private readonly prisma: PrismaService) {}
  async setName(id: string, publicKey: string, displayName: string | null) {
    await this.prisma.publisher.upsert({
      where: { id }, create: { id, publicKey, displayName },
      update: { displayName },
    });
    return { id, displayName };
  }
}
```

- [ ] **Step 5: Controlador** `src/publishers/publishers.controller.ts`
```typescript
import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { SignatureGuard } from '../auth/signature.guard';
import { Publisher } from '../auth/publisher.decorator';
import { PublishersService } from './publishers.service';
import { SetNameDto } from './dto/set-name.dto';

@Controller('publishers')
export class PublishersController {
  constructor(private readonly publishers: PublishersService) {}
  @Post('name')
  @UseGuards(SignatureGuard)
  setName(@Publisher() pub: { id: string; publicKey: string }, @Body() dto: SetNameDto) {
    return this.publishers.setName(pub.id, pub.publicKey, dto.displayName);
  }
}
```

- [ ] **Step 6: Módulo + registrar en AppModule**
```typescript
import { Module } from '@nestjs/common';
import { PublishersController } from './publishers.controller';
import { PublishersService } from './publishers.service';
import { AuthModule } from '../auth/auth.module';

@Module({ imports: [AuthModule], controllers: [PublishersController], providers: [PublishersService] })
export class PublishersModule {}
```

- [ ] **Step 7: Correr y ver pasar** — `npm run test:e2e -- publishers` → PASS.

- [ ] **Step 8: Commit**
```bash
git add src/publishers src/app.module.ts test/publishers.e2e-spec.ts
git commit -m "feat(publishers): nombre opt-in firmado (set/clear)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 11: Cierre — README + suite completa

**Files:** `README.md`, `docs/`.

- [ ] **Step 1: README** con: qué es, stack, cómo correr (`npm i`, `npx prisma migrate dev`, `npm run start:dev`), variables `.env`, y resumen de la API v1.
- [ ] **Step 2: Suite completa**

Run: `npm test && npm run test:e2e`
Esperado: todo verde.

- [ ] **Step 3: Lint/format** (si Nest configuró eslint/prettier): `npm run lint`.
- [ ] **Step 4: Commit**
```bash
git add README.md
git commit -m "docs: README de la tienda + v1 completa (publicar/explorar/descargar/votar)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review (cobertura de la spec)

- NestJS + Prisma + SQLite (driver adapter), estructura modular → Task 1, 3. ✓
- Modelo de datos (Publisher/Plugin/PluginVersion/Vote/Report) → Task 2. ✓
- Auth por firma Ed25519 (id=hash(pubkey), anti-replay, id↔clave) → Task 4, 5. ✓
- Validación de manifiesto (rechaza provider, file-traversal) → Task 6. ✓
- POST /plugins firmado → Task 7. ✓
- GET lista/búsqueda/detalle/descarga + contadores → Task 8. ✓
- Votos (upsert) + report → Task 9. ✓
- Nombre opt-in → Task 10. ✓
- Privacidad (no guarda datos personales): garantizado por el modelo (Task 2 no tiene campos personales) — sin tarea extra. ✓
- Pruebas unit + e2e → en cada task. ✓
- NOTA: el campo `signature` de PluginVersion se guarda vacío en v1 (la verificación de la firma ocurre en el guard al publicar; persistir la firma del contenido para auditoría posterior se difiere a v2 junto al track-record). Documentar en el README.
