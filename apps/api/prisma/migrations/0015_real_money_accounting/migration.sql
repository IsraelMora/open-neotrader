-- Real-money accounting foundation (slice 1, additive only): local ledger tables for
-- broker order lifecycle (RealOrder), real position snapshots (RealPosition), and real
-- NAV history (RealNavSnapshot). No existing tables are modified beyond the additive
-- back-relation on TradeIntent (relation only, no column added).
-- CreateTable
CREATE TABLE "real_orders" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "trade_intent_id" TEXT NOT NULL,
    "broker_plugin_id" TEXT NOT NULL,
    "client_order_id" TEXT NOT NULL,
    "broker_order_id" TEXT,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "order_type" TEXT NOT NULL DEFAULT 'market',
    "requested_qty" REAL NOT NULL,
    "limit_price" REAL,
    "status" TEXT NOT NULL DEFAULT 'pending_submit',
    "filled_qty" REAL NOT NULL DEFAULT 0,
    "filled_avg_price" REAL,
    "submitted_at" DATETIME,
    "filled_at" DATETIME,
    "last_reconciled_at" DATETIME,
    "broker_raw_json" TEXT,
    "error" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "real_orders_trade_intent_id_fkey" FOREIGN KEY ("trade_intent_id") REFERENCES "trade_intents" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "real_positions" (
    "symbol" TEXT NOT NULL PRIMARY KEY,
    "broker_plugin_id" TEXT NOT NULL,
    "qty" REAL NOT NULL,
    "avg_entry" REAL NOT NULL,
    "market_value" REAL NOT NULL,
    "unrealized_pnl" REAL NOT NULL,
    "side" TEXT NOT NULL,
    "last_synced_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "real_nav_snapshots" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ts" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "broker_plugin_id" TEXT NOT NULL,
    "equity" REAL NOT NULL,
    "cash" REAL NOT NULL,
    "buying_power" REAL NOT NULL,
    "positions" TEXT NOT NULL,
    "total_pnl" REAL NOT NULL DEFAULT 0,
    "hwm" REAL NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'poll',
    "meta" TEXT
);

-- CreateIndex
CREATE UNIQUE INDEX "real_orders_client_order_id_key" ON "real_orders"("client_order_id");

-- CreateIndex
CREATE INDEX "real_orders_status_idx" ON "real_orders"("status");

-- CreateIndex
CREATE INDEX "real_orders_broker_order_id_idx" ON "real_orders"("broker_order_id");

-- CreateIndex
CREATE INDEX "real_orders_client_order_id_idx" ON "real_orders"("client_order_id");

-- CreateIndex
CREATE INDEX "real_orders_trade_intent_id_idx" ON "real_orders"("trade_intent_id");

-- CreateIndex
CREATE INDEX "real_nav_snapshots_ts_idx" ON "real_nav_snapshots"("ts");

-- CreateIndex
CREATE INDEX "real_nav_snapshots_broker_plugin_id_ts_idx" ON "real_nav_snapshots"("broker_plugin_id", "ts");
