#!/bin/sh
set -e

# Igual que apps/api: el volumen nombrado (store-data → /data) se crea como root.
# Arrancamos como root, fijamos propiedad a `node`, y nos re-ejecutamos como `node`
# para aplicar migraciones y arrancar la app sin privilegios.
if [ "$(id -u)" = "0" ]; then
  mkdir -p /data
  chown -R node:node /data
  exec gosu node "$0" "$@"
fi

# Ya como `node`: aplica migraciones pendientes a la DB del volumen (idempotente).
npx prisma migrate deploy --schema=prisma/schema.prisma

exec "$@"
