# Build context: apps/store (compose usa context: ./apps/store)

# ── Deps: compila módulos nativos (better-sqlite3) + genera el cliente Prisma ──
FROM node:22-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
# pnpm vía corepack (versión fijada en package.json → packageManager).
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
# Genera el cliente Prisma una vez aquí; builder y runner copian node_modules.
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN pnpm exec prisma generate

# ── Build TypeScript ──────────────────────────────────────────────────────────
FROM node:22-slim AS builder
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# ── Runner ────────────────────────────────────────────────────────────────────
FROM node:22-slim AS runner
WORKDIR /app

# curl para healthcheck; gosu para soltar privilegios tras chown del volumen.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl gosu \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
# Schema + migraciones + config: el entrypoint corre `prisma migrate deploy` al arrancar.
COPY prisma ./prisma
COPY prisma.config.ts ./
COPY package.json ./

# El entrypoint fija la propiedad del volumen SQLite en runtime, aplica migraciones
# y luego baja a `node` vía gosu (igual patrón que apps/api).
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production
ENV PORT=3002

EXPOSE 3002
ENTRYPOINT ["docker-entrypoint.sh"]
# nest build preserva src/ (hay prisma.config.ts en la raíz) → entry en dist/src/main.js
CMD ["node", "dist/src/main"]
