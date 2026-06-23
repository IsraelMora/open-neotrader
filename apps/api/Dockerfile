# Build context: monorepo root (docker-compose uses context: .)

# ── Deps: compile native modules (better-sqlite3 needs build tools) ────────
FROM node:22-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY apps/api/package.json apps/api/package-lock.json ./
RUN npm ci
# Generate the Prisma client INTO node_modules here in deps: both the builder
# (tsc needs the client types) and the runner (runtime needs the client) copy
# node_modules from this stage, so generating once here covers both.
COPY apps/api/prisma ./prisma
RUN npx prisma generate

# ── Build TypeScript ────────────────────────────────────────────────────────
FROM node:22-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY apps/api/ .
RUN npm run build

# ── Runner: Node + Python (sandbox subprocess) ──────────────────────────────
FROM node:22-slim AS runner
WORKDIR /app

# Python 3 + pip for sandbox; curl for healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip curl gosu \
    && rm -rf /var/lib/apt/lists/*

# Plugin SDK + sandbox deps
COPY packages/plugin-sdk /opt/plugin-sdk
COPY apps/sandbox/requirements.txt /tmp/sandbox-requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages \
    -r /tmp/sandbox-requirements.txt && \
    pip3 install --no-cache-dir --break-system-packages /opt/plugin-sdk

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
# Prisma schema + migrations needed at runtime (MigrationRunnerService reads
# ../../../prisma/migrations relative to dist/src/prisma → /app/prisma/migrations).
COPY apps/api/prisma ./prisma

# Sandbox runner + sibling modules (runner.py lazy-imports isolation.py / analyzer.py)
COPY apps/sandbox/*.py /sandbox/
# Strategy + backtester plugins baked into the image (PLUGINS_DIR=/plugins).
# chown so runtime plugin installs (POST /api/plugins/install) can still write.
COPY plugins/ /plugins/
RUN chown -R node:node /plugins

# Entrypoint fixes the SQLite data-volume ownership at runtime, then drops to the
# unprivileged `node` user via gosu (see docker-entrypoint.sh). We deliberately do
# NOT set `USER node` here: the container starts as root so the entrypoint can
# chown /data (named volumes mount as root), then runs the app as `node`.
COPY apps/api/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
# nest build preserves src/, so the entrypoint is dist/src/main.js (not dist/main.js)
CMD ["node", "dist/src/main"]
