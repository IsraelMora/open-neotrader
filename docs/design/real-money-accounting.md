# Real-Money Trading Accounting & Reconciliation — Design Document

Repo: `/home/alex/claude/neurotrader` (NestJS / Prisma / TypeScript + Python plugins)
Status: DESIGN ONLY — no code written. This file is the build spec.

---

## 1. Current-state findings (with exact file:line)

### Order placement is fire-and-forget, not fill-confirmed
- `apps/api/src/providers/provider-gateway.service.ts:465-489` — `placeOrder(pluginId, order)` dispatches to `placeAlpacaOrder` (line 491) or `placeBinanceOrder` (line 532) by format, and returns `res.json()` from a single synchronous POST — whatever Alpaca's initial response body is.
- `provider-gateway.service.ts:505-529` (`placeAlpacaOrder`) — POSTs to `${base_url}/v2/orders` with body `{ symbol, qty, side, type, time_in_force }`. **No `client_order_id` is ever sent** (body object, lines 507-513, has no such field). Alpaca's initial response for a market order is typically `status: "accepted"` / `"pending_new"`, **NOT a fill**.
- The return value of `placeOrder` is trusted as-is; nothing ever calls a get-order / poll-status endpoint. Order lifecycle after submission is invisible to the system.

### `_executeReal` fabricates the fill price
- `apps/api/src/trade-intent/trade-intent.service.ts:859-1051` (`_executeReal`) — computes `price` from a **pre-order** `getQuote` call (lines 877-892) and persists that quote price as `fill_price` (lines 1038-1043), alongside the broker's raw JSON blob in `result_json.order` (line 1047).
- Consequence: the recorded `fill_price`/`quantity` are the **pre-trade quote**, never reconciled against what Alpaca actually filled. This is silently-wrong accounting today, independent of the "no ledger" gap. Order type is hardcoded `type: 'market'` (line 1015).

### No broker order-status / cancel / list capability exists anywhere
- `plugins/alpaca-provider/manifest.toml:27-33` — `[api.endpoints]` declares only `ohlcv`, `quote`, `portfolio` (`{base_url}/v2/account`), `positions` (`{base_url}/v2/positions`), `account`, `orders` (`{base_url}/v2/orders`, POST-only, used solely by `placeOrder`). No `order_status`, `cancel_order`, or `list_orders` endpoint declared.
- `provider-gateway.service.ts` has no method that would consume such an endpoint even if declared. Missing surface: `get_order_by_id`, `get_order_by_client_id`, `cancel_order`, `list_orders`.

### Alpaca API reality (confirmed via context7 `/alpacahq/alpaca-py`)
- Order lifecycle is **asynchronous**: statuses include `new`, `accepted`, `pending_new`, `partially_filled`, `filled`, `canceled`, `rejected`, `expired`. A submitted order is NOT an immediate fill.
- `client_order_id` is supported for **idempotent submission** and lookup via `get_order_by_client_id`. `get_order_by_id` fetches by Alpaca's order id.
- `cancel_order_by_id` cancels an open/partially-filled order (already-filled qty stays filled).
- Fractional / notional orders supported (`qty=0.023` or `notional=250`).
- Account endpoint returns `equity`, `cash`, `buying_power`, `long_market_value`, etc. Positions endpoint returns per-symbol `qty`, `avg_entry_price`, `market_value`, `unrealized_pl`, `side`.
- Fills observed via polling (`get_order_by_id`) or streaming trade-updates websocket. This design uses polling (streaming deferred).

### Schema has zero broker/order linkage
- `apps/api/prisma/schema.prisma:248-271` (`TradeIntent`) — fields: `id, cycle_id, symbol, action, confidence, rationale, timeframe, mode, status, created_at, decided_at, decided_by, reject_reason, fill_price, quantity, realized_pnl, result_json`. **No `broker_order_id`, no `client_order_id`, no broker-status column.** The only place a broker order id survives is inside the free-form `result_json` string (line 1047), unindexed and unqueryable.
- `schema.prisma:65-71` (`Portfolio`) — `{ name (PK), data (JSON string), updatedAt }`, a single KV row per named portfolio; only `name="paper"` is ever used by `TradeIntentService`.
- `schema.prisma:75-90` (`NavSnapshot`) — `id, ts, cycle_id, provider_id, strategy_id, equity, cash, positions(JSON), total_pnl, meta`. Equity source is whatever `getPortfolio(null)` returns — conflates paper and real (see below).
- `schema.prisma:94-112` (`Strategy`) — carries `walk_forward_verdict` / `walk_forward_checked_at`, used by the gate, irrelevant to accounting.
- Repo-wide `rg` for `cron|@Cron|@Interval|setInterval|schedule` found **no reconciliation/polling job**. Closest infrastructure: `apps/api/src/scheduler/cycle-scheduler.service.ts:86-99` — a `setInterval` ticker driven by KV config (`SchedulerConfig`), used only to run agent cycles. Usable *pattern* (KV-configured interval + circuit breaker), unrelated to order reconciliation.

### Kernel gates read the PAPER account even for real trades
- `trade-intent.service.ts:213-222` (autoProcess) and `:318-327` (approve) — both load `paperState` from `db.portfolio.findUnique({ where: { name: 'paper' } })` **unconditionally**, including on the real-mode path (comment line 212: "Also needed in real mode for exit qty lookup and risk gate state").
- `trade-intent.service.ts:239-252` — `_passesAutoRisk(paperState, policy)` (drawdown-halt + max-open-positions gate, defined at lines 1078-1098) runs against `paperState` for both real and paper intents. Comment at line 253: `exit` always passes.
- `trade-intent.service.ts:913-920, 936-945` — real long/short qty sizing calls `_clampToPositionCeiling(..., paperState.equity, price, policy.max_position_pct, ...)`. **Real order sizing is a function of the PAPER account's equity.**
- `trade-intent.service.ts:1065-1068` (`_computeDrawdownPct`) reads `state.hwm` — the paper portfolio's HWM. No real-account HWM field or table exists.
- Real exits are the only place broker truth is consulted live: `_resolveRealExitQty` (lines 748-796) and `_resolveExitRouting` (lines 555-594) call `gateway.getPortfolio(brokerPluginId)` on every exit — correct in spirit but no cache/ledger, extra broker round-trip on hot path, no fallback if the call fails.
- `_effectiveMode` / `_resolveMode` already branch on paper vs real; the real branch is where new wiring inserts. Preconditions gate: `_checkExecuteRealPreconditions` (lines 810-857).

### Snapshot service is paper/default-provider only
- `apps/api/src/snapshot/snapshot.service.ts:42-105` (`takeSnapshot`) — calls `this.gateway.getPortfolio(null)` (line 45), i.e. `getDefaultProvider()` (first active provider with credentials), and writes one `NavSnapshot` row per call. No distinction between "paper NAV curve" and "real NAV curve." If Alpaca is the only active provider, this already captures broker equity — but it is not tagged as such, not linked to a real HWM, and NOT what `_computeDrawdownPct`/`_passesAutoRisk` read (those read `Portfolio.name="paper"`, a disconnected write path). Two independent equity histories exist with no reconciliation.

---

## 2. Target architecture

### 2.1 New Prisma models

```prisma
// Broker-truth order ledger — one row per broker order attempt, crash-safe via client_order_id.
model RealOrder {
  id                 String    @id @default(cuid())
  trade_intent_id    String                          // FK → TradeIntent.id — every real order MUST trace to an intent
  broker_plugin_id   String
  client_order_id    String    @unique               // idempotency key, generated BEFORE the network call
  broker_order_id    String?                         // Alpaca's `id`; null until POST succeeds
  symbol             String
  side               String                          // "buy" | "sell"
  order_type         String    @default("market")    // "market" | "limit"
  requested_qty      Float
  limit_price        Float?
  status             String    @default("pending_submit")
  // "pending_submit"  — row written, POST not yet sent (crash-safety anchor)
  // "submit_failed"   — POST threw / network error (retryable via client_order_id)
  // "submitted"       — POST ok, broker status not yet observed
  // "accepted" | "partially_filled" | "filled" | "canceled" | "rejected" | "expired"
  filled_qty         Float     @default(0)
  filled_avg_price   Float?
  submitted_at       DateTime?
  filled_at          DateTime?
  last_reconciled_at DateTime?
  broker_raw_json    String?                         // last raw broker response, for debugging
  error              String?
  created_at         DateTime  @default(now())
  updated_at         DateTime  @updatedAt

  tradeIntent        TradeIntent @relation(fields: [trade_intent_id], references: [id])

  @@index([status])
  @@index([broker_order_id])
  @@index([client_order_id])
  @@index([trade_intent_id])
  @@map("real_orders")
}

// Local cache of broker-truth positions — refreshed wholesale by reconciliation, never hand-mutated.
model RealPosition {
  symbol            String    @id
  broker_plugin_id  String
  qty               Float
  avg_entry         Float
  market_value      Float
  unrealized_pnl    Float
  side              String                           // "long" | "short"
  last_synced_at    DateTime  @updatedAt

  @@map("real_positions")
}

// Separate equity curve + HWM for the REAL account. Paper NavSnapshot/Portfolio untouched.
// Kernel drawdown/sizing reads THIS in real mode.
model RealNavSnapshot {
  id                String    @id @default(uuid())
  ts                DateTime  @default(now())
  broker_plugin_id  String
  equity            Float
  cash              Float
  buying_power      Float
  positions         String                           // JSON: Position[]
  total_pnl         Float     @default(0)
  hwm               Float                             // high-water-mark AT this row = max(prev hwm, equity), monotonic
  source            String    @default("poll")        // "poll" | "startup_reconcile" | "post_order"
  meta              String?

  @@index([ts])
  @@index([broker_plugin_id, ts])
  @@map("real_nav_snapshots")
}
```

Additive relation on existing model (no column change — FK lives on `RealOrder`):
```prisma
model TradeIntent {
  // ...existing fields unchanged...
  realOrders  RealOrder[]
}
```

**Why three models:**
- `RealOrder` — crash-safe order/fill ledger. The single highest-value artifact. Idempotency + fill truth.
- `RealPosition` — a **cache**, not a source of truth. Always fully rebuilt from `getPortfolio()`, never incrementally patched, so it cannot drift into a partial-inconsistent state. Exists so kernel/UI reads don't hit the broker every time.
- `RealNavSnapshot` — breaks the "kernel reads paper equity" bug at the root. It is what `_computeDrawdownPct` / `_passesAutoRisk` / `_clampToPositionCeiling` read in real mode.

### 2.2 New services

**`RealOrderService`** — `apps/api/src/real-order/real-order.service.ts` (+ `real-order.module.ts`)
- `generateClientOrderId(tradeIntentId): string` — deterministic prefix off the intent id: `nt-${intentId.slice(0,8)}-${crypto.randomUUID().slice(0,8)}`. Generated once, persisted before the network call, never regenerated on retry.
- `submit(tradeIntentId, brokerPluginId, order): Promise<RealOrder>` — writes `RealOrder(status=pending_submit)` and commits → calls `gateway.placeOrder(..., clientOrderId)` → updates row to `submitted` (+ `broker_order_id`, `submitted_at`) or `submit_failed` (+ `error`). Fail-soft: never throws to the caller (matches existing `_executeReal` conventions).
- `recoverInflight(): Promise<void>` — startup helper: find `pending_submit` rows and resolve via `get_order_by_client_id` before ever re-POSTing.

**`RealBrokerReconciliationService`** — `apps/api/src/real-reconciliation/real-broker-reconciliation.service.ts`
- `reconcileOrder(realOrderId): Promise<void>` — fetch `RealOrder` → `gateway.getOrderStatus`/`getOrderByClientId` → update fields → if newly `filled`, transactionally update linked `TradeIntent` to `executed` with real `fill_price`/`quantity`; if `rejected`/`canceled`/`expired`, set `TradeIntent.status="failed"` + `reject_reason`.
- `fastPollOrder(realOrderId): Promise<void>` — immediate post-submit polling (2s/4s/8s/16s up to ~30s), early-exit on terminal status.
- `reconcileAllOpenOrders(): Promise<void>` — the steady-state tick body: query all `RealOrder` in `{submitted, accepted, partially_filled}`, reconcile each.
- `syncPortfolio(brokerPluginId): Promise<void>` — call `gateway.getPortfolio`, full-replace `RealPosition` (transaction), append one `RealNavSnapshot` with computed `hwm`, run drift detection.
- `onModuleInit()` — startup: `recoverInflight()`, then `reconcileAllOpenOrders()`, then one forced `syncPortfolio()`, THEN enable the `setInterval` steady-state loop (KV-configurable `execution.real_reconciliation_interval_ms`, default 15000, min 5000). Own circuit breaker (like `scheduler:circuit_breaker`).
- `detectDrift(brokerPositions, cachedPositions): void` — any broker position with no explaining `RealOrder` chain → `CRITICAL` `AlertEntry` (`type="BROKER_DRIFT"`) + auto-set kill-switch; cache still updated to broker truth.

**`ProviderGatewayService`** additions:
- `placeOrder(pluginId, order, clientOrderId)` — new required param, forwarded into Alpaca body as `client_order_id`.
- `getOrderStatus(pluginId, brokerOrderId): Promise<OrderStatusResult>`
- `getOrderByClientId(pluginId, clientOrderId): Promise<OrderStatusResult>`
- `cancelOrder(pluginId, brokerOrderId): Promise<void>`
- `listOrders(pluginId, { status }): Promise<OrderStatusResult[]>` (used for startup reconcile fallback)
- New type: `OrderStatusResult = { broker_order_id, client_order_id, status, filled_qty, filled_avg_price, raw }`.

### 2.3 Data flow

```
_executeReal (real long/short)
  └─> preconditions pass (broker configured, walk-forward, kill-switch not halted, qty/notional ok)
  └─> RealOrderService.submit()
        1. generate client_order_id
        2. WRITE RealOrder(status=pending_submit)  ── commit (crash-safety anchor)
        3. gateway.placeOrder(order, client_order_id)  ── network
        4a. ok    → RealOrder{status=submitted, broker_order_id, submitted_at}
        4b. error → RealOrder{status=submit_failed, error}   (no inline retry)
  └─> TradeIntent.status = "real_pending"   (NOT "executed"; fill_price/quantity left null)
  └─> RealBrokerReconciliationService.fastPollOrder()  (2s/4s/8s/16s ≤30s)

Steady-state loop (setInterval, default 15s):
  reconcileAllOpenOrders()
    for each open RealOrder:
      getOrderStatus / getOrderByClientId → update RealOrder
      if filled → TRANSACTION { RealOrder.filled_* , TradeIntent(executed, fill_price, quantity) }
      if rejected/canceled/expired → TradeIntent(failed, reject_reason)
      if partially_filled beyond timeout → cancelOrder(remainder)

  syncPortfolio() (every pass, or every ~60s):
    getPortfolio(brokerPluginId)
    TRANSACTION full-replace RealPosition[]
    append RealNavSnapshot{ equity, cash, buying_power, hwm=max(prevHwm, equity) }
    detectDrift() → CRITICAL AlertEntry + kill-switch on unexplained position

Kernel gates (real mode):
  _computeDrawdownPct(mode=real)   → latest RealNavSnapshot (equity, hwm)
  _passesAutoRisk(mode=real)       → RealNavSnapshot state + RealPosition count
  _clampToPositionCeiling(real)    → RealNavSnapshot.equity / buying_power
  no snapshot yet → FAIL CLOSED (block new entries)
```

---

## 3. Order lifecycle

- **Idempotency (`client_order_id`)**: generated once from `TradeIntent.id`, persisted in `RealOrder` **before** the outbound POST, never regenerated. Alpaca dedupes on `client_order_id`, so a retry with the same key cannot double-submit.
- **Crash-safe submission**: "log intent, then act." The `pending_submit` row is committed before the POST. On any crash between DB-write and POST-confirmation, `recoverInflight()` (startup) finds `pending_submit` / stale `submitted` rows and resolves them via `get_order_by_client_id` FIRST — it never blind-resubmits without checking whether the broker already received it.
- **Async fills via polling**: a submitted order is `real_pending` until the broker reports `filled`. `fastPollOrder` covers the common few-seconds fill; the steady-state loop catches the rest.
- **Partial fills**: `RealOrder.filled_qty` / `filled_avg_price` track cumulative broker-reported fill. `TradeIntent` flips to `executed` only on full `filled`. A `partially_filled` intent stays `real_pending`, visible to operators. Configurable `partial_fill_timeout_minutes` (KV) auto-cancels the unfilled remainder via `cancelOrder` (already-filled qty preserved).
- **Rejected / canceled / expired**: `TradeIntent.status="failed"`, `reject_reason` from broker. Never auto-retried (rejection usually = insufficient buying power / PDT / market closed; retrying compounds misconfiguration). A fresh intent from the next cycle is the recovery path.
- **What is transactional**:
  1. `RealOrder(pending_submit)` write commits **before** the POST (sequential ordering, not wrapped with the network call — impossible to make atomic with an external call, but write-first ordering is the guarantee).
  2. Fill recording: `RealOrder.status/filled_*` update **and** the linked `TradeIntent.status/fill_price/quantity` update are ONE Prisma `$transaction`. A fill must never appear on one side without the other.
  3. `RealPosition` full-replace is ONE transaction (delete-all-then-insert, or upsert-then-delete-stale) so readers never see a half-updated position set.

---

## 4. Kernel rewiring

Call sites to change (all in `trade-intent.service.ts`):

- **`_effectiveMode` / `_resolveMode`** — unchanged logic; it already returns `'real' | 'paper'`. It is the branch point: the new real-state loader runs inside the existing `effectiveMode === 'real'` block.
- **New real-state loader** — instead of only `paperState = db.portfolio.findUnique({name:'paper'})` (lines 213-222, 318-327), in real mode also load `realState` = latest `RealNavSnapshot` (equity, hwm) + `RealPosition[]` (open-position count). Paper mode is untouched.
- **`_computeDrawdownPct(state, mode)`** (currently lines 1065-1068 reading `state.hwm`) — gains a `mode` param. Real mode reads `RealNavSnapshot.equity` and `RealNavSnapshot.hwm`. **Fail-closed**: if no `RealNavSnapshot` exists yet, do NOT default to 0% drawdown (that is the paper-mode convenience default) — return a value that blocks entry, or have the caller treat "no real state" as `pass=false`.
- **`_passesAutoRisk(state, policy, mode)`** (currently lines 239-252 / 1078-1098) — real mode: drawdown check from `RealNavSnapshot`, max-open-positions from `RealPosition` count (not `paperState.positions`). Real mode with no snapshot → `pass=false` for `long`/`short`. `exit` always passes (preserve line 253 behavior).
- **`_clampToPositionCeiling(..., equity, ...)`** (call sites lines 913-920, 936-945) — real mode passes `RealNavSnapshot.buying_power` (preferred; accounts for margin/reserved funds) or `equity` instead of `paperState.equity`. No real snapshot → refuse to size (fail closed).
- **Fail-closed rationale**: for real money, "we don't know the drawdown / equity" must NEVER be silently treated as "drawdown is 0% / equity is fine." This is the deliberate opposite of paper mode's forgiving default.

---

## 5. Provider-gateway + alpaca-provider plugin additions

`plugins/alpaca-provider/manifest.toml` `[api.endpoints]` gains:
- `order_status` → `{base_url}/v2/orders/{broker_order_id}` (GET)
- `order_by_client_id` → `{base_url}/v2/orders:by_client_order_id={client_order_id}` (GET)
- `cancel_order` → `{base_url}/v2/orders/{broker_order_id}` (DELETE)
- `list_orders` → `{base_url}/v2/orders?status={status}` (GET)

`ProviderGatewayService` gains:
- `placeOrder(pluginId, order, clientOrderId)` — `placeAlpacaOrder` body now includes `client_order_id: clientOrderId`.
- `getOrderStatus(pluginId, brokerOrderId)` → normalized `OrderStatusResult`.
- `getOrderByClientId(pluginId, clientOrderId)` → normalized `OrderStatusResult`.
- `cancelOrder(pluginId, brokerOrderId)` → DELETE, tolerate 404/already-canceled.
- `listOrders(pluginId, { status })` → `OrderStatusResult[]` (startup fallback).
- Normalization maps Alpaca fields → `{ broker_order_id: id, client_order_id, status, filled_qty, filled_avg_price, raw }`.

---

## 6. Kill-switch design

- KV flag `real_execution.halted` (boolean), operator- and auto-settable.
- Checked at the top of `_executeReal`, in `_checkExecuteRealPreconditions` (lines 810-857), for **new-risk actions only** (`long` / `short`). `exit` and `hold` are exempt — mirrors the existing walk-forward/drawdown exemption already in the code (`_passesAutoRisk` only gates long/short; `exit` always passes, line 253). Halting must block entries but NEVER block exits.
- Auto-set triggers (from `RealBrokerReconciliationService`): reconciliation circuit-breaker trip, `CRITICAL` broker-drift alert, or repeated `submit_failed` within a short window.
- Clearing the flag is a manual operator action (auto-clear would re-arm a broken system).

---

## 7. Ordered 13-step TDD implementation plan

Each step is a self-contained, PR-able unit. Only steps 5 and 11 change existing real-mode behavior; both are gated by the existing `trade-intent.service.spec.ts` real-mode suite (extend, don't replace).

1. **Schema migration — add `RealOrder`, `RealPosition`, `RealNavSnapshot`.**
   Changes: `prisma/schema.prisma`, new migration. Additive relation `realOrders` on `TradeIntent`.
   Test: migration applies cleanly on dev DB; client generates types; smoke test creates+reads one row of each model.
   Deps: none.

2. **Gateway read methods — `getOrderStatus`, `getOrderByClientId`, `cancelOrder`, `listOrders`.**
   Changes: `provider-gateway.service.ts`, `plugins/alpaca-provider/manifest.toml` (new endpoints).
   Test: `provider-gateway.service.spec.ts` mocking `fetch` for GET `/v2/orders/{id}`, GET by client id, DELETE, GET list — assert URL construction, auth headers, `OrderStatusResult` normalization.
   Deps: none.

3. **`placeAlpacaOrder` sends `client_order_id`.**
   Changes: `placeOrder` signature gains `clientOrderId`; `placeAlpacaOrder` body includes it.
   Test: unit test asserts POST body contains `client_order_id`; existing callers updated to pass one.
   Deps: 2 (same file).

4. **`RealOrderService.submit` — idempotent ledger row.**
   Changes: new `real-order.service.ts`, `real-order.module.ts`. `generateClientOrderId`, `submit`, `recoverInflight`.
   Test: mocked gateway + SQLite Prisma — (a) `pending_submit` row exists BEFORE mock `placeOrder` invoked (ordering), (b) success → `submitted` + `broker_order_id`, (c) thrown error → `submit_failed` + `error`, never throws to caller.
   Deps: 1, 3.

5. **`_executeReal` delegates to `RealOrderService`; add `real_pending` status.**
   Changes: `trade-intent.service.ts` (`status` is a free string column — no schema change, new accepted value). Removes the fabricated-fill write.
   Test: `trade-intent.service.spec.ts` — real long/short ends `real_pending` with linked `RealOrder`; `fill_price`/`quantity` NOT set yet (fabrication bug removed). Exit path routes through `RealOrderService` too, behavior otherwise unchanged.
   Deps: 4. **Changes existing behavior.**

6. **`RealBrokerReconciliationService.reconcileOrder` — single-order (no loop yet).**
   Changes: new `real-broker-reconciliation.service.ts`.
   Test: status transitions (submitted→partially_filled, partially_filled→filled, submitted→rejected, submitted→canceled); transactional `TradeIntent` update on `filled`; defensive handling of `filled_qty < requested_qty`.
   Deps: 1, 2, 5.

7. **Immediate post-submit fast-poll.**
   Changes: `fastPollOrder` (2s/4s/8s/16s ≤30s), invoked after `submit`.
   Test: fake-timers — poll cadence, early-exit on terminal status, give-up after window leaving the order for the steady-state loop.
   Deps: 6.

8. **Steady-state polling loop + startup reconciliation.**
   Changes: `onModuleInit`, `setInterval`, KV `execution.real_reconciliation_interval_ms`; `reconcileAllOpenOrders`, `recoverInflight` at boot.
   Test: tick body in isolation (query non-terminal `RealOrder`, reconcile each); startup path calls reconcile-all once before enabling the interval; circuit-breaker trip halts spinning.
   Deps: 6, 7.

9. **`RealPosition` cache + `RealNavSnapshot` writer (`syncPortfolio`).**
   Changes: extend tick to call `getPortfolio`, full-replace `RealPosition` (transaction), append `RealNavSnapshot` with computed `hwm`.
   Test: full-replace transaction (disappeared positions deleted, not left stale); HWM monotonicity (never decreases when equity drops).
   Deps: 1, 8.

10. **Drift detection + `AlertEntry`.**
    Changes: `detectDrift` in reconciliation service; reuse existing `AlertEntry` model.
    Test: broker position with no `RealOrder` history → `CRITICAL` `AlertEntry` (`type="BROKER_DRIFT"`); cache still updated (broker wins).
    Deps: 9.

11. **Kernel real-mode gates read `RealNavSnapshot`.**
    Changes: `_computeDrawdownPct`, `_passesAutoRisk`, `_clampToPositionCeiling` gain mode/real-state; `_executeReal` passes real state instead of `paperState` for sizing/gating.
    Test: **core bug-fix test** — open real position, drive `RealNavSnapshot.equity` down via fabricated row, assert subsequent real long is REJECTED by drawdown halt (impossible to write today). Fail-closed test: no `RealNavSnapshot` → real long rejected, not silently allowed. Paper-mode gate tests unchanged.
    Deps: 9. **Changes existing behavior.**

12. **Global kill-switch (`real_execution.halted`).**
    Changes: `_checkExecuteRealPreconditions` gates `long`/`short` (exit/hold exempt); reconciliation service auto-sets flag on repeated `submit_failed` / circuit-breaker / CRITICAL drift.
    Test: `long`/`short` rejected when halted, `exit` still executes; auto-set fires under trigger conditions.
    Deps: 5, 10.

13. **Snapshot / dashboard read-path — real equity curve distinct from paper.**
    Changes: `snapshot.service.ts` adds `getRealEquityCurve()` reading `RealNavSnapshot`, parallel to existing paper curve; controller/API surface consuming it.
    Test: new read returns `RealNavSnapshot` series sorted, independent of paper `NavSnapshot`; regression that `takeSnapshot()` paper behavior is byte-for-byte unchanged.
    Deps: 9.

**Mandatory-before-real-money** (no shortcuts): steps 1, 4, 5, 6, 8 (order ledger + idempotency + reconciliation), 9 + 11 (real equity/HWM + kernel rewiring + fail-closed), 12 (kill-switch), and transactional consistency in 6.
**Deferred**: streaming trade-updates websocket (polling suffices); automatic orphan-position exit on plugin deactivation (own design); multi-broker (Binance) parity; cancel/replace order modification; operator drift-review dashboard; limit-order-specific nuances (system is market-order primary).

---

## 8. Real-money risk table

| Risk | Mitigation |
|---|---|
| Double order submission on crash / network-timeout retry | `client_order_id` generated once, persisted before the POST, checked via `get_order_by_client_id` before any resubmission (steps 3-4, `recoverInflight`) |
| Drawdown-halt doesn't protect the real account (reads paper equity) — the documented gap | `RealNavSnapshot` + real HWM; kernel gates branch on mode (step 11) — headline fix |
| Silent fill-price/quantity fabrication (`_executeReal` persists the pre-order quote) | Reconciliation confirms real `filled_avg_price`/`filled_qty` before `TradeIntent` → `executed`; intermediate `real_pending` makes "unconfirmed" visible (steps 5-6) |
| Silent fill-status drift (rejected/partial and nobody notices) | Fast-poll + steady-state loop + startup reconcile catch every terminal/partial transition (steps 6-8) |
| Real position exists the system doesn't know about (manual trade / bug / missed event) | Drift detection every `syncPortfolio`, `CRITICAL` `AlertEntry` + auto kill-switch (steps 9-10, 12) |
| Real order sizing against paper equity → over-leverage | Sizing reads `RealNavSnapshot.equity`/`buying_power`, fail-closed when no snapshot (step 11) |
| Broken/misconfigured system keeps submitting new real risk | Global `real_execution.halted` kill-switch, exit-exempt, operator- and auto-settable (step 12) |
| Partial fill left open indefinitely, unclear position size | `partial_fill_timeout_minutes` auto-cancels remainder via `cancelOrder`, keeps filled qty (section 3) |
| Fill recorded on ledger but not on intent (or vice versa) | Single Prisma `$transaction` wraps `RealOrder` fill + `TradeIntent` update (section 3) |
| Paper mode regresses from real-money work | All new tables additive; paper paths (`_runPaperExecution`, `Portfolio` name="paper", `NavSnapshot`) untouched; existing paper test suite is the regression gate |
| "No data yet" silently treated as "safe" for a fresh real account | Fail-closed defaults in `_computeDrawdownPct`/`_passesAutoRisk`/sizing — block entries until a real snapshot exists (steps 11) |

---

## Files referenced (repo-relative)
- `apps/api/src/providers/provider-gateway.service.ts`
- `apps/api/src/trade-intent/trade-intent.service.ts`
- `apps/api/src/snapshot/snapshot.service.ts`
- `apps/api/src/scheduler/cycle-scheduler.service.ts`
- `apps/api/prisma/schema.prisma`
- `plugins/alpaca-provider/manifest.toml`
- New: `apps/api/src/real-order/`, `apps/api/src/real-reconciliation/`
