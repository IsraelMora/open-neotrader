-- Estrategias: perfiles nombrados de configuración del ciclo que pueden estar activos
-- simultáneamente y competir en paper. config es un JSON Record<string,string> con el
-- snapshot de las claves KV del ciclo.
CREATE TABLE "strategies" (
  "id"          TEXT     NOT NULL PRIMARY KEY,
  "name"        TEXT     NOT NULL,
  "description" TEXT,
  "config"      TEXT     NOT NULL,
  "active"      BOOLEAN  NOT NULL DEFAULT false,
  "mode"        TEXT     NOT NULL DEFAULT 'test',
  "created_at"  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "strategies_name_key" ON "strategies"("name");

-- NAV por estrategia: permite separar las curvas de equity de cada estrategia en competencia.
ALTER TABLE "nav_snapshots" ADD COLUMN "strategy_id" TEXT;
CREATE INDEX "nav_snapshots_strategy_id_ts_idx" ON "nav_snapshots"("strategy_id", "ts");
