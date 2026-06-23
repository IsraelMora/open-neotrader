#!/bin/sh
set -e

# Ensure the SQLite data volume is writable by the unprivileged `node` user.
#
# Named volumes (api-data → /data) are created owned by root, so a container that
# runs as `node` cannot create the DB file there (SqliteError: SQLITE_CANTOPEN).
# We start as root, fix ownership at runtime (this also repairs pre-existing
# root-owned volumes without recreating them), then drop privileges to `node`
# for the actual application process.
if [ "$(id -u)" = "0" ]; then
  mkdir -p /data
  chown -R node:node /data
  exec gosu node "$@"
fi

exec "$@"
