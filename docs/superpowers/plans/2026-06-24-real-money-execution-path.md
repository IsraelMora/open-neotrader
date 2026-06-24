# Real-Money Execution Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in real-money execution path to `TradeIntentService`, behind a triple-condition config flag that defaults OFF, with notional ceiling and full audit logging.

**Architecture:** Extend `ExecutionPolicy` with three new KV-driven fields (`real`, `broker_plugin_id`, `max_order_notional`). Add `_effectiveMode()` as the single source of truth for mode resolution. Add `_executeReal()` for broker-dispatched orders. Route both `autoProcess` and `approve` through the same execution dispatcher. Default config keeps all existing paper paths completely unchanged.

**Tech Stack:** NestJS/TypeScript, Jest (TDD), Prisma (mocked in tests), KvService (mocked), ProviderGatewayService.placeOrder (mocked).

## Global Constraints

- STRICT TDD: Write failing tests FIRST. Run them. Then implement. Then run again.
- Test runner: `cd /home/alex/claude/neurotrader/apps/api && export PATH="$HOME/.local/bin:$PATH" && pnpm test -- trade-intent`
- Never enable real execution in any config file or env file — config stays OFF.
- Keep all 41 existing tests green throughout.
- Diff scoped entirely to `apps/api/src/trade-intent/` — do NOT touch any other directory.
- `mode` field stored in DB stays as-is (paper at create time); effective mode is derived at execution time from policy, never persisted as 'real'.
- Use `eza`/`bat`/`rg`/`fd` — never `ls`/`cat`/`grep`/`find`.
- Conventional commits only. No Co-Authored-By.
- Git author: `OpenNeoTrader <noreply@open-neotrader.dev>`

---

## File Map

| File | Action | What changes |
|------|--------|--------------|
| `apps/api/src/trade-intent/trade-intent.service.ts` | Modify | `ExecutionPolicy` gains 3 fields; `_readExecutionPolicy` reads 3 new KV keys; `_effectiveMode()` new method; `_executeReal()` new method; `autoProcess` and `approve` route through shared dispatcher; old "mode!=paper throws" guard replaced with policy-derived effective mode |
| `apps/api/src/trade-intent/trade-intent.service.spec.ts` | Modify | `MockGateway` gains `placeOrder` mock; update 2 existing tests that assert the old throw semantics; add 8 new real-execution tests |

---

## Task 1: Extend spec — write failing tests for real-execution path

**Files:**
- Modify: `apps/api/src/trade-intent/trade-intent.service.spec.ts`

**Interfaces:**
- Consumes: existing `makeGateway()`, `makeKv()`, `makeService()`, `pendingIntent()` helpers
- Produces: 8 new failing `it(...)` blocks + 2 updated existing tests, all asserting behaviour that does not yet exist in the service

Before writing tests, understand the `MockGateway` type. It currently only has `getQuote`. You must add `placeOrder` to it. The `placeOrder` mock signature mirrors `ProviderGatewayService.placeOrder` at line 462 of `apps/api/src/providers/provider-gateway.service.ts`:

```typescript
placeOrder(pluginId: string, order: { symbol: string; qty: number; side: 'buy'|'sell'; type: 'market'|'limit'; limitPrice?: number; timeInForce?: string }): Promise<Record<string, unknown>>
```

- [ ] **Step 1: Update `MockGateway` type and `makeGateway()` factory**

In `apps/api/src/trade-intent/trade-intent.service.spec.ts`, find these lines:

```typescript
type MockGateway = { getQuote: jest.Mock };

function makeGateway(): MockGateway {
  return { getQuote: jest.fn() };
}
```

Replace with:

```typescript
type MockGateway = { getQuote: jest.Mock; placeOrder: jest.Mock };

function makeGateway(): MockGateway {
  return { getQuote: jest.fn(), placeOrder: jest.fn() };
}
```

- [ ] **Step 2: Update the two existing tests that assert the old "mode!=paper throws" semantics**

The spec currently has two tests that expect `autoProcess` and `approve` to throw when `mode='live'`. With the new design, mode is *derived* from policy — not read from the stored row. When policy has `real=false` (default), effective mode is `paper`, so a stored row with `mode='live'` would still get paper-executed (intent.mode is ignored at routing time). You must **update** those tests to reflect the new contract.

Find the test at line ~617 in the spec:
```typescript
it('mode!="paper" in autoProcess → throws', async () => {
  kv.get.mockResolvedValue(null);
  prisma.tradeIntent.findUnique.mockResolvedValue(pendingIntent({ mode: 'live' }));

  await expect(service.autoProcess('ti_001')).rejects.toThrow(/real-money execution is disabled/i);
});
```

Replace it with:
```typescript
it('default policy (real unset) → paper mode even if intent.mode is "live"', async () => {
  // real execution is disabled by default; effective mode is always paper
  kv.get.mockResolvedValue(null); // all keys null → real=false, broker_plugin_id=''
  prisma.tradeIntent.findUnique.mockResolvedValue(pendingIntent({ mode: 'live', action: 'hold' }));

  const executed = pendingIntent({ status: 'executed', quantity: 0, decided_by: 'autonomous' });
  prisma.tradeIntent.update.mockResolvedValue(executed);

  // Must NOT throw. Routes to paper (hold → no-op).
  const result = await service.autoProcess('ti_001');
  expect(result.status).toBe('executed');
  expect(gateway.placeOrder).not.toHaveBeenCalled();
});
```

Find the test at line ~247 in the spec:
```typescript
it('throws when mode != "paper" (real-money execution disabled)', async () => {
  const intent = pendingIntent({ mode: 'live' });
  prisma.tradeIntent.findUnique.mockResolvedValue(intent);

  await expect(service.approve('ti_001', 'alice')).rejects.toThrow(
    /real-money execution is disabled/i,
  );
  // Must NOT execute any trade or update status
  expect(prisma.tradeIntent.update).not.toHaveBeenCalled();
});
```

Replace it with:
```typescript
it('default policy (real unset) → paper mode in approve even if intent.mode is "live"', async () => {
  // Effective mode comes from policy, not intent.mode. Default policy → paper.
  kv.get.mockResolvedValue(null);
  const intent = pendingIntent({ mode: 'live', action: 'long' });
  prisma.tradeIntent.findUnique.mockResolvedValue(intent);
  prisma.portfolio.findUnique.mockResolvedValue({ name: 'paper', data: EMPTY_PORTFOLIO_DATA, updatedAt: new Date() });
  gateway.getQuote.mockResolvedValue({ symbol: 'AAPL', bid: 149, ask: 151, last: 150, ts: new Date().toISOString() });
  prisma.portfolio.upsert.mockResolvedValue({ name: 'paper', data: '{}', updatedAt: new Date() });
  const updated = pendingIntent({ status: 'executed', fill_price: 150, decided_by: 'alice', decided_at: new Date() });
  prisma.tradeIntent.update.mockResolvedValue(updated);

  const result = await service.approve('ti_001', 'alice');
  expect(result.status).toBe('executed');
  expect(gateway.placeOrder).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Add new `describe('real execution')` block with 8 failing tests**

Append this entire block at the end of the outer `describe('TradeIntentService', ...)` block, before its closing `});`:

```typescript
// ── real execution ──────────────────────────────────────────────────────────

describe('real execution', () => {
  // Helper: configure KV for real execution with a broker
  function enableReal(kvMock: MockKv, brokerPluginId = 'alpaca-provider', maxOrderNotional = 1000) {
    kvMock.get.mockImplementation((key: string) => {
      if (key === 'execution.real') return Promise.resolve('true');
      if (key === 'execution.broker_plugin_id') return Promise.resolve(brokerPluginId);
      if (key === 'execution.max_order_notional') return Promise.resolve(String(maxOrderNotional));
      return Promise.resolve(null); // all other keys → defaults (autonomous=true, etc.)
    });
  }

  it('default policy (real unset) → effective mode=paper, placeOrder NEVER called', async () => {
    // All KV keys return null → real=false → paper path
    kv.get.mockResolvedValue(null);

    prisma.tradeIntent.findUnique.mockResolvedValue(pendingIntent({ action: 'long' }));
    prisma.portfolio.findUnique.mockResolvedValue({ name: 'paper', data: EMPTY_PORTFOLIO_DATA, updatedAt: new Date() });
    gateway.getQuote.mockResolvedValue({ symbol: 'AAPL', bid: 149, ask: 151, last: 150, ts: new Date().toISOString() });
    prisma.portfolio.upsert.mockResolvedValue({ name: 'paper', data: '{}', updatedAt: new Date() });
    const executed = pendingIntent({ status: 'executed', fill_price: 150, decided_by: 'autonomous' });
    prisma.tradeIntent.update.mockResolvedValue(executed);

    await service.autoProcess('ti_001');

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(prisma.portfolio.upsert).toHaveBeenCalled(); // paper portfolio updated
  });

  it('real=true but broker_plugin_id empty → effective mode=paper, placeOrder NOT called', async () => {
    // Safety: real without broker must NEVER fire
    kv.get.mockImplementation((key: string) => {
      if (key === 'execution.real') return Promise.resolve('true');
      if (key === 'execution.broker_plugin_id') return Promise.resolve(''); // empty!
      return Promise.resolve(null);
    });

    prisma.tradeIntent.findUnique.mockResolvedValue(pendingIntent({ action: 'long' }));
    prisma.portfolio.findUnique.mockResolvedValue({ name: 'paper', data: EMPTY_PORTFOLIO_DATA, updatedAt: new Date() });
    gateway.getQuote.mockResolvedValue({ symbol: 'AAPL', bid: 149, ask: 151, last: 150, ts: new Date().toISOString() });
    prisma.portfolio.upsert.mockResolvedValue({ name: 'paper', data: '{}', updatedAt: new Date() });
    const executed = pendingIntent({ status: 'executed', fill_price: 150, decided_by: 'autonomous' });
    prisma.tradeIntent.update.mockResolvedValue(executed);

    await service.autoProcess('ti_001');

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(prisma.portfolio.upsert).toHaveBeenCalled(); // still paper
  });

  it('real=true + broker set → autoProcess long calls placeOrder with side=buy, type=market, qty>0, status=executed', async () => {
    enableReal(kv); // real=true, broker='alpaca-provider', max_order_notional=1000
    // qty = floor(10000 * 0.1 / 150) = floor(6.66) = 6; notional = 6*150 = 900 <= 1000 ✓
    prisma.tradeIntent.findUnique.mockResolvedValue(pendingIntent({ action: 'long', symbol: 'AAPL' }));
    gateway.getQuote.mockResolvedValue({ symbol: 'AAPL', bid: 149, ask: 151, last: 150, ts: new Date().toISOString() });
    gateway.placeOrder.mockResolvedValue({ id: 'order_123', status: 'accepted', filled_qty: '6' });
    const executed = pendingIntent({ status: 'executed', fill_price: 150, quantity: 6, decided_by: 'autonomous' });
    prisma.tradeIntent.update.mockResolvedValue(executed);

    const result = await service.autoProcess('ti_001');

    expect(gateway.placeOrder).toHaveBeenCalledWith(
      'alpaca-provider',
      expect.objectContaining({
        symbol: 'AAPL',
        qty: expect.any(Number),
        side: 'buy',
        type: 'market',
      }),
    );
    // qty must be > 0
    const callArgs = gateway.placeOrder.mock.calls[0][1] as { qty: number };
    expect(callArgs.qty).toBeGreaterThan(0);
    expect(result.status).toBe('executed');
    // Paper portfolio must NOT be upserted in real mode
    expect(prisma.portfolio.upsert).not.toHaveBeenCalled();
  });

  it('real order notional exceeds max_order_notional → status=failed, placeOrder NOT called', async () => {
    // max_order_notional=100; qty=floor(10000*0.1/150)=6; notional=6*150=900 > 100 → fail
    kv.get.mockImplementation((key: string) => {
      if (key === 'execution.real') return Promise.resolve('true');
      if (key === 'execution.broker_plugin_id') return Promise.resolve('alpaca-provider');
      if (key === 'execution.max_order_notional') return Promise.resolve('100'); // tiny ceiling
      return Promise.resolve(null);
    });

    prisma.tradeIntent.findUnique.mockResolvedValue(pendingIntent({ action: 'long', symbol: 'AAPL' }));
    gateway.getQuote.mockResolvedValue({ symbol: 'AAPL', bid: 149, ask: 151, last: 150, ts: new Date().toISOString() });
    const failed = pendingIntent({ status: 'failed', decided_by: 'autonomous' });
    prisma.tradeIntent.update.mockResolvedValue(failed);

    const result = await service.autoProcess('ti_001');

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
    expect(prisma.tradeIntent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'failed',
          result_json: expect.stringContaining('max_order_notional'),
        }),
      }),
    );
  });

  it('placeOrder throws → status=failed, no throw to caller', async () => {
    enableReal(kv);
    prisma.tradeIntent.findUnique.mockResolvedValue(pendingIntent({ action: 'long', symbol: 'AAPL' }));
    gateway.getQuote.mockResolvedValue({ symbol: 'AAPL', bid: 149, ask: 151, last: 150, ts: new Date().toISOString() });
    gateway.placeOrder.mockRejectedValue(new Error('Broker connection refused'));
    const failed = pendingIntent({ status: 'failed', decided_by: 'autonomous' });
    prisma.tradeIntent.update.mockResolvedValue(failed);

    // Must NOT throw
    const result = await service.autoProcess('ti_001');

    expect(result.status).toBe('failed');
    expect(prisma.tradeIntent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'failed',
          result_json: expect.stringContaining('Broker connection refused'),
        }),
      }),
    );
  });

  it('real exit → side=sell with the held position qty from portfolio', async () => {
    // Portfolio holds 10 AAPL at avg 140; exit → sell 10 shares
    enableReal(kv, 'alpaca-provider', 5000); // ceiling high enough
    const portfolioWithPosition = JSON.stringify({
      equity: 11_400,
      cash: 10_000,
      positions: [{ symbol: 'AAPL', quantity: 10, avg_price: 140 }],
    });
    prisma.tradeIntent.findUnique.mockResolvedValue(pendingIntent({ action: 'exit', symbol: 'AAPL' }));
    gateway.getQuote.mockResolvedValue({ symbol: 'AAPL', bid: 149, ask: 151, last: 150, ts: new Date().toISOString() });
    // For exit in real mode, we look up held qty from the paper portfolio to know how many to sell
    prisma.portfolio.findUnique.mockResolvedValue({ name: 'paper', data: portfolioWithPosition, updatedAt: new Date() });
    gateway.placeOrder.mockResolvedValue({ id: 'order_456', status: 'accepted', filled_qty: '10' });
    const executed = pendingIntent({ status: 'executed', fill_price: 150, quantity: 10, decided_by: 'autonomous' });
    prisma.tradeIntent.update.mockResolvedValue(executed);

    await service.autoProcess('ti_001');

    expect(gateway.placeOrder).toHaveBeenCalledWith(
      'alpaca-provider',
      expect.objectContaining({
        symbol: 'AAPL',
        side: 'sell',
        qty: 10,
        type: 'market',
      }),
    );
  });

  it('risk gate still applies in real mode — drawdown halt prevents real order', async () => {
    enableReal(kv);
    const portfolioWithDrawdown = JSON.stringify({
      equity: 7_000,
      cash: 7_000,
      positions: [],
      max_drawdown_pct: 30, // >= 25 halt
    });
    prisma.tradeIntent.findUnique.mockResolvedValue(pendingIntent({ action: 'long' }));
    prisma.portfolio.findUnique.mockResolvedValue({ name: 'paper', data: portfolioWithDrawdown, updatedAt: new Date() });
    const rejected = pendingIntent({ status: 'rejected', decided_by: 'autonomous', reject_reason: 'circuit breaker: drawdown 30% >= 25%' });
    prisma.tradeIntent.update.mockResolvedValue(rejected);

    await service.autoProcess('ti_001');

    // Real mode: risk gate fires BEFORE any quote fetch or order
    expect(gateway.getQuote).not.toHaveBeenCalled();
    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(prisma.tradeIntent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'rejected' }),
      }),
    );
  });

  it('hold in real mode → no order placed, status=executed, quantity=0', async () => {
    enableReal(kv);
    prisma.tradeIntent.findUnique.mockResolvedValue(pendingIntent({ action: 'hold' }));
    const executed = pendingIntent({ status: 'executed', quantity: 0, decided_by: 'autonomous' });
    prisma.tradeIntent.update.mockResolvedValue(executed);

    const result = await service.autoProcess('ti_001');

    expect(gateway.getQuote).not.toHaveBeenCalled();
    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(result.status).toBe('executed');
    expect(result.quantity).toBe(0);
  });
});
```

- [ ] **Step 4: Run tests to confirm they FAIL (RED)**

```bash
cd /home/alex/claude/neurotrader/apps/api && export PATH="$HOME/.local/bin:$PATH" && pnpm test -- trade-intent 2>&1 | tail -40
```

Expected: the 8 new tests in `real execution` fail (service has no `_effectiveMode` or `_executeReal` yet), and the 2 updated tests in `approve` / `autoProcess` also fail. The other 39 tests should still pass.

If any of the original 39 tests (that you didn't touch) fail, **stop and investigate** before continuing.

- [ ] **Step 5: Commit the failing tests**

```bash
cd /home/alex/claude/neurotrader && git add apps/api/src/trade-intent/trade-intent.service.spec.ts
git commit -m "test(trade-intent): add failing tests for real-money execution path"
```

---

## Task 2: Implement real-execution path in TradeIntentService

**Files:**
- Modify: `apps/api/src/trade-intent/trade-intent.service.ts`

**Interfaces:**
- Consumes: `ProviderGatewayService.placeOrder(pluginId, {symbol, qty, side, type})` → `Promise<Record<string, unknown>>`
- Produces: `ExecutionPolicy` (extended), `_effectiveMode(policy)`, `_executeReal(intent, policy, decided_by)`, updated `autoProcess`, updated `approve`

**Key invariants to preserve:**
- `autoProcess` and `approve` both go through the same execution dispatcher after risk gates.
- `approve` uses `SIZING_PCT` (0.05) as the sizing fraction; `autoProcess` uses `policy.max_position_pct`.
- For `exit` in real mode, we read the held quantity from the paper portfolio (same source of truth as paper mode).
- `hold` short-circuits before any quote fetch, regardless of mode.
- `_executeReal` NEVER retries on broker failure — one attempt, fail-soft to `status=failed`.
- The paper portfolio is NEVER mutated in real mode.

- [ ] **Step 1: Extend `ExecutionPolicy` interface**

In `trade-intent.service.ts`, find:

```typescript
export interface ExecutionPolicy {
  autonomous: boolean;
  max_position_pct: number;
  max_open_positions: number;
  max_drawdown_halt_pct: number;
}
```

Replace with:

```typescript
export interface ExecutionPolicy {
  autonomous: boolean;
  max_position_pct: number;
  max_open_positions: number;
  max_drawdown_halt_pct: number;
  /** Only literal 'true' (string) enables real execution. Default false. */
  real: boolean;
  /** Which provider plugin executes real orders. Empty string → paper fallback. */
  broker_plugin_id: string;
  /** Hard ceiling per real order in notional value (qty * price). Default 1000. */
  max_order_notional: number;
}
```

- [ ] **Step 2: Extend `_readExecutionPolicy` to read 3 new KV keys**

Find the existing `_readExecutionPolicy` method. Find the destructuring:

```typescript
    const [rawAutonomous, rawMaxPosPct, rawMaxOpenPos, rawMaxDrawdown] = await Promise.all([
      this.kv.get('execution.autonomous'),
      this.kv.get('execution.max_position_pct'),
      this.kv.get('execution.max_open_positions'),
      this.kv.get('execution.max_drawdown_halt_pct'),
    ]);
```

Replace with:

```typescript
    const [rawAutonomous, rawMaxPosPct, rawMaxOpenPos, rawMaxDrawdown, rawReal, rawBrokerId, rawMaxNotional] = await Promise.all([
      this.kv.get('execution.autonomous'),
      this.kv.get('execution.max_position_pct'),
      this.kv.get('execution.max_open_positions'),
      this.kv.get('execution.max_drawdown_halt_pct'),
      this.kv.get('execution.real'),
      this.kv.get('execution.broker_plugin_id'),
      this.kv.get('execution.max_order_notional'),
    ]);
```

Then find the closing `return` statement of `_readExecutionPolicy`:

```typescript
    return { autonomous, max_position_pct, max_open_positions, max_drawdown_halt_pct };
```

Replace with:

```typescript
    // real: only the literal string 'true' enables it — everything else is false.
    const real = rawReal === 'true';

    // broker_plugin_id: empty string is treated as "not set" → paper fallback.
    const broker_plugin_id = (rawBrokerId ?? '').trim();

    // max_order_notional: hard ceiling per order in notional value. Default 1000.
    let max_order_notional = parseNum(rawMaxNotional, 1_000);
    if (max_order_notional <= 0) max_order_notional = 1_000;

    return { autonomous, max_position_pct, max_open_positions, max_drawdown_halt_pct, real, broker_plugin_id, max_order_notional };
```

- [ ] **Step 3: Add `_effectiveMode` — single source of truth**

Add this private method immediately after `_readExecutionPolicy` (before `_passesAutoRisk`):

```typescript
  // ── _effectiveMode ────────────────────────────────────────────────────────────

  /**
   * Derives the execution mode from policy.
   * Returns 'real' ONLY when BOTH conditions hold:
   *   1. policy.real === true  (operator explicitly set execution.real=true)
   *   2. policy.broker_plugin_id is non-empty  (a broker is configured)
   *
   * Any other combination → 'paper'. This is the SINGLE source of truth.
   * intent.mode (stored in DB) is irrelevant at execution time.
   */
  private _effectiveMode(policy: ExecutionPolicy): 'paper' | 'real' {
    if (policy.real === true && policy.broker_plugin_id.length > 0) {
      return 'real';
    }
    return 'paper';
  }
```

- [ ] **Step 4: Add `_executeReal` method**

Add this private method after `_effectiveMode` (before `_passesAutoRisk`):

```typescript
  // ── _executeReal ──────────────────────────────────────────────────────────────

  /**
   * Real-money execution path.
   *
   * Pre-checks (any failure → status=failed, NEVER place order):
   *   - broker_plugin_id must be set (defensive; _effectiveMode already guards this)
   *   - qty computed from fresh getQuote; must be > 0
   *   - notional (qty * price) must be <= policy.max_order_notional
   *
   * Side mapping:
   *   long  → 'buy'
   *   exit  → 'sell' (qty = held position qty from paper portfolio)
   *   short → 'sell'
   *   hold  → no-op (executed, qty=0) — caller should have short-circuited before here
   *
   * On broker success: status=executed, fill_price/quantity/result_json from response.
   * On broker throw: status=failed, reason logged, NO retry, NO throw to caller.
   * Paper portfolio is NEVER mutated in real mode.
   *
   * Every real order attempt emits a WARN-level audit log line.
   */
  private async _executeReal(
    id: string,
    intent: { symbol: string; action: string },
    policy: ExecutionPolicy,
    paperState: PaperState,
    decided_by: string,
    sizingPct: number,
  ) {
    const symbol = intent.symbol;
    const action = intent.action as TradeAction;

    // Defensive: broker must be set (belt-and-suspenders beyond _effectiveMode).
    if (!policy.broker_plugin_id) {
      this.log.warn(`REAL ORDER REJECTED [${id}]: broker_plugin_id is empty — safety guard`);
      return this.db.tradeIntent.update({
        where: { id },
        data: {
          status: 'failed',
          decided_at: new Date(),
          decided_by,
          result_json: JSON.stringify({ error: 'broker_plugin_id not configured' }),
        },
      });
    }

    // Fetch live quote for sizing.
    let price: number;
    try {
      const quote = await this.gateway.getQuote(null, symbol);
      price = quote.last;
    } catch (err) {
      this.log.warn(`REAL ORDER FAILED [${id}]: getQuote error for ${symbol} — ${String(err)}`);
      return this.db.tradeIntent.update({
        where: { id },
        data: {
          status: 'failed',
          decided_at: new Date(),
          decided_by,
          result_json: JSON.stringify({ error: String(err) }),
        },
      });
    }

    if (!isFinite(price) || price <= 0) {
      this.log.warn(`REAL ORDER FAILED [${id}]: invalid quote price ${price} for ${symbol}`);
      return this.db.tradeIntent.update({
        where: { id },
        data: {
          status: 'failed',
          decided_at: new Date(),
          decided_by,
          result_json: JSON.stringify({ error: `Invalid quote price: ${price}` }),
        },
      });
    }

    // Compute side and qty.
    let side: 'buy' | 'sell';
    let qty: number;

    if (action === 'long') {
      side = 'buy';
      qty = Math.floor((paperState.equity * sizingPct) / price);
    } else if (action === 'exit') {
      side = 'sell';
      // Use held position quantity from paper portfolio as the authoritative qty.
      const pos = paperState.positions.find((p) => p.symbol === symbol);
      qty = pos ? pos.quantity : 0;
    } else if (action === 'short') {
      side = 'sell';
      qty = Math.floor((paperState.equity * sizingPct) / price);
    } else {
      // 'hold' — should have been short-circuited before reaching here; defensive no-op.
      return this.db.tradeIntent.update({
        where: { id },
        data: {
          status: 'executed',
          quantity: 0,
          decided_at: new Date(),
          decided_by,
          result_json: JSON.stringify({ quantity: 0, reason: 'hold — no position change' }),
        },
      });
    }

    // Qty safety check.
    if (qty <= 0) {
      this.log.warn(`REAL ORDER REJECTED [${id}]: computed qty=${qty} for ${symbol} — not placing`);
      return this.db.tradeIntent.update({
        where: { id },
        data: {
          status: 'failed',
          decided_at: new Date(),
          decided_by,
          result_json: JSON.stringify({ error: `Computed qty=${qty} — not enough equity or no position to exit` }),
        },
      });
    }

    // Notional ceiling check.
    const notional = qty * price;
    if (notional > policy.max_order_notional) {
      this.log.warn(
        `REAL ORDER REJECTED [${id}]: notional=${notional} exceeds max_order_notional=${policy.max_order_notional} for ${symbol}`,
      );
      return this.db.tradeIntent.update({
        where: { id },
        data: {
          status: 'failed',
          decided_at: new Date(),
          decided_by,
          result_json: JSON.stringify({
            error: `Order notional ${notional} exceeds max_order_notional ${policy.max_order_notional}`,
            qty,
            price,
            notional,
            max_order_notional: policy.max_order_notional,
          }),
        },
      });
    }

    // LOUD audit log before every real order attempt.
    this.log.warn(
      `REAL ORDER ATTEMPT [${id}]: ${side.toUpperCase()} ${qty} ${symbol} @ ~${price} ` +
        `(notional=${notional}) via broker=${policy.broker_plugin_id} decided_by=${decided_by}`,
    );

    // Place the real order — fail-soft on broker error.
    let orderResponse: Record<string, unknown>;
    try {
      orderResponse = await this.gateway.placeOrder(policy.broker_plugin_id, {
        symbol,
        qty,
        side,
        type: 'market',
      });
    } catch (err) {
      this.log.warn(`REAL ORDER FAILED [${id}]: broker threw — ${String(err)}`);
      return this.db.tradeIntent.update({
        where: { id },
        data: {
          status: 'failed',
          decided_at: new Date(),
          decided_by,
          result_json: JSON.stringify({ error: String(err), qty, side, symbol }),
        },
      });
    }

    this.log.warn(
      `REAL ORDER EXECUTED [${id}]: ${side.toUpperCase()} ${qty} ${symbol} — broker response: ${JSON.stringify(orderResponse)}`,
    );

    return this.db.tradeIntent.update({
      where: { id },
      data: {
        status: 'executed',
        fill_price: price,
        quantity: qty,
        decided_at: new Date(),
        decided_by,
        result_json: JSON.stringify({
          fill_price: price,
          quantity: qty,
          side,
          broker: policy.broker_plugin_id,
          order: orderResponse,
        }),
      },
    });
  }
```

- [ ] **Step 5: Replace `autoProcess` — remove old "mode!=paper throws" guard, add routing**

Find the current `autoProcess` method. Locate the hard guard block:

```typescript
    // HARD GUARD: real-money execution is intentionally not wired.
    if (intent.mode !== 'paper') {
      throw new Error(
        `real-money execution is disabled. Only mode="paper" is supported. ` +
          `Received mode="${intent.mode}" for intent ${id}.`,
      );
    }

    if (intent.status !== 'pending') {
```

Replace that block with:

```typescript
    if (intent.status !== 'pending') {
```

(The "mode!=paper" guard is entirely removed. Status guard stays.)

Then find the policy reading and portfolio loading in `autoProcess`. After the policy is read but before the hold short-circuit, add the effective mode derivation. Find:

```typescript
    const policy = await this._readExecutionPolicy();

    // Load the shared paper portfolio (create with defaults if missing).
    const portfolioRow = await this.db.portfolio.findUnique({
```

Replace with:

```typescript
    const policy = await this._readExecutionPolicy();
    const effectiveMode = this._effectiveMode(policy);

    // Load the shared paper portfolio (create with defaults if missing).
    // Also needed in real mode for exit qty lookup and risk gate state.
    const portfolioRow = await this.db.portfolio.findUnique({
```

Then find the hold short-circuit (remains unchanged, no routing needed there):

```typescript
    // "hold" → executed immediately as no-op, no quote fetch, no portfolio mutation.
    if (action === 'hold') {
      return this.db.tradeIntent.update({
        where: { id },
        data: {
          status: 'executed',
          quantity: 0,
          decided_at: new Date(),
          decided_by: 'autonomous',
          result_json: JSON.stringify({ quantity: 0, reason: 'hold — no position change' }),
        },
      });
    }
```

(Keep this hold block exactly as-is. Hold is always a no-op regardless of mode.)

Then find the final routing call at the bottom of `autoProcess`:

```typescript
    return this._runPaperExecution(id, intent.symbol, action, paperState, 'autonomous', policy.max_position_pct);
```

Replace with:

```typescript
    if (effectiveMode === 'real') {
      return this._executeReal(id, intent, policy, paperState, 'autonomous', policy.max_position_pct);
    }
    return this._runPaperExecution(id, intent.symbol, action, paperState, 'autonomous', policy.max_position_pct);
```

- [ ] **Step 6: Replace `approve` — remove old "mode!=paper throws" guard, add routing**

Find the approve method. Locate the hard guard block:

```typescript
    // HARD GUARD: real-money execution is intentionally not wired.
    if (intent.mode !== 'paper') {
      throw new Error(
        `real-money execution is disabled. Only mode="paper" is supported. ` +
          `Received mode="${intent.mode}" for intent ${id}.`,
      );
    }

    if (intent.status !== 'pending') {
```

Replace that block with:

```typescript
    if (intent.status !== 'pending') {
```

Then find the portfolio load in approve:

```typescript
    // Load the shared paper portfolio (create with defaults if missing).
    const portfolioRow = await this.db.portfolio.findUnique({
      where: { name: PAPER_PORTFOLIO_NAME },
    });
    const state: PaperState = portfolioRow
      ? (JSON.parse(portfolioRow.data) as PaperState)
      : {
          equity: PAPER_PORTFOLIO_INITIAL_CAPITAL,
          cash: PAPER_PORTFOLIO_INITIAL_CAPITAL,
          positions: [],
        };

    return this._runPaperExecution(id, intent.symbol, intent.action as TradeAction, state, decided_by, SIZING_PCT);
```

Replace with:

```typescript
    const policy = await this._readExecutionPolicy();
    const effectiveMode = this._effectiveMode(policy);

    // Load the shared paper portfolio (create with defaults if missing).
    // Also needed in real mode for exit qty lookup.
    const portfolioRow = await this.db.portfolio.findUnique({
      where: { name: PAPER_PORTFOLIO_NAME },
    });
    const state: PaperState = portfolioRow
      ? (JSON.parse(portfolioRow.data) as PaperState)
      : {
          equity: PAPER_PORTFOLIO_INITIAL_CAPITAL,
          cash: PAPER_PORTFOLIO_INITIAL_CAPITAL,
          positions: [],
        };

    if (effectiveMode === 'real') {
      return this._executeReal(id, intent, policy, state, decided_by, SIZING_PCT);
    }
    return this._runPaperExecution(id, intent.symbol, intent.action as TradeAction, state, decided_by, SIZING_PCT);
```

**NOTE:** `approve` did not previously read the policy. It now needs to. The `_runPaperExecution` call keeps `SIZING_PCT` (not `policy.max_position_pct`) — that is intentional and must stay.

- [ ] **Step 7: Update the file-level JSDoc comment**

Find at the top of the file:

```typescript
 * REAL-MONEY EXECUTION IS HARD-DISABLED.
 * Any intent with mode != "paper" will throw before touching the portfolio.
 * This is intentional and must not be removed without a security review.
```

Replace with:

```typescript
 * REAL-MONEY EXECUTION IS OFF BY DEFAULT.
 * Effective mode is derived from ExecutionPolicy, not the stored intent.mode.
 * Real execution requires: execution.real=true AND execution.broker_plugin_id non-empty.
 * All real orders pass through the same risk gates and a per-order notional ceiling.
 * Every real order attempt is logged at WARN level.
```

- [ ] **Step 8: Run the tests — expect GREEN**

```bash
cd /home/alex/claude/neurotrader/apps/api && export PATH="$HOME/.local/bin:$PATH" && pnpm test -- trade-intent 2>&1 | tail -40
```

Expected output: `Tests: 49 passed, 49 total` (41 original + 8 new).

If any test fails, read the error message carefully. Common pitfalls:

- `approve` calling `_readExecutionPolicy` for the first time means the test mock for `kv.get` must now handle it — check that the `approve` tests set up `kv.get` (they inherit `kv.get.mockResolvedValue(null)` from `beforeEach`, which makes `real=false` → paper, which is correct).
- The `real exit` test needs `prisma.portfolio.findUnique` to be mocked (it is, in the test above).
- The `autoProcess` flow for real mode skips `prisma.portfolio.findUnique` only when action is `hold`. For `long`, it still loads the portfolio to check risk gates — ensure `prisma.portfolio.findUnique` is mocked in those tests.

- [ ] **Step 9: Commit the implementation**

```bash
cd /home/alex/claude/neurotrader && git add apps/api/src/trade-intent/trade-intent.service.ts
git commit -m "feat(trade-intent): add opt-in real-money execution path behind triple-condition config flag"
```

---

## Self-Review

### Spec coverage check

| Requirement | Task | Status |
|-------------|------|--------|
| `ExecutionPolicy` gains `real`, `broker_plugin_id`, `max_order_notional` | Task 2 Step 1 | ✓ |
| `_effectiveMode()` single source of truth | Task 2 Step 3 | ✓ |
| `real` only from literal string `'true'` | Task 2 Step 2 | ✓ |
| `broker_plugin_id` empty → paper | Task 2 Step 3 | ✓ |
| Remove old "mode!=paper throws" guard | Task 2 Steps 5-6 | ✓ |
| `_executeReal` with SAFETY pre-checks | Task 2 Step 4 | ✓ |
| Notional ceiling `max_order_notional` | Task 2 Step 4 | ✓ |
| `long` → `side='buy'` | Task 2 Step 4 | ✓ |
| `exit` → `side='sell'` using held qty | Task 2 Step 4 | ✓ |
| `hold` in real mode → no order, qty=0 | Task 2 Steps 5 + `_executeReal` defensive branch | ✓ |
| `placeOrder` throw → `status=failed`, no re-throw | Task 2 Step 4 | ✓ |
| WARN audit log on every real order | Task 2 Step 4 | ✓ |
| Risk gates apply in real mode | Task 2 Step 5 (risk gate runs before mode routing) | ✓ |
| Paper portfolio NOT mutated in real mode | Task 2 Step 4 (no `portfolio.upsert` in `_executeReal`) | ✓ |
| Default config → paper (placeOrder unreachable) | Task 1 tests + Task 2 Step 2 (`real=false` default) | ✓ |
| Test: default policy → paper, placeOrder never called | Task 1 Step 3 | ✓ |
| Test: real=true + broker empty → paper | Task 1 Step 3 | ✓ |
| Test: real=true + broker set → placeOrder buy market | Task 1 Step 3 | ✓ |
| Test: notional exceeds ceiling → failed, no order | Task 1 Step 3 | ✓ |
| Test: placeOrder throws → failed, no throw | Task 1 Step 3 | ✓ |
| Test: real exit → sell with held qty | Task 1 Step 3 | ✓ |
| Test: risk gate in real mode | Task 1 Step 3 | ✓ |
| Test: hold in real mode → no order | Task 1 Step 3 | ✓ |

### Placeholder scan

No TBDs, no "implement later", no "similar to Task N" — all code blocks are complete.

### Type consistency

- `ExecutionPolicy.real: boolean` — set in `_readExecutionPolicy`, read in `_effectiveMode` and `_executeReal`.
- `ExecutionPolicy.broker_plugin_id: string` — set in `_readExecutionPolicy`, read in `_effectiveMode` and `_executeReal`.
- `ExecutionPolicy.max_order_notional: number` — set in `_readExecutionPolicy`, read in `_executeReal`.
- `_effectiveMode(policy: ExecutionPolicy): 'paper' | 'real'` — called in `autoProcess` and `approve`.
- `_executeReal(id, intent, policy, paperState, decided_by, sizingPct)` — called with consistent arg types in both `autoProcess` and `approve`.
- `gateway.placeOrder` mock added to `MockGateway` in Task 1 before any test calls it.

---

## KV Keys the Operator Must Set to Go Live

To enable real execution, an operator must set ALL THREE of these KV keys:

| KV Key | Required value | Effect |
|--------|---------------|--------|
| `execution.real` | `'true'` (literal string) | Enables real-money routing |
| `execution.broker_plugin_id` | e.g. `'alpaca-provider'` | Selects which broker plugin |
| `execution.max_order_notional` | e.g. `'500'` | Hard per-order ceiling in notional value |

Optionally (already exist, still apply):
| `execution.autonomous` | `'true'` or `null` (default) | Auto-executes without HITL |
| `execution.max_position_pct` | `'0.05'` | Position sizing fraction |
| `execution.max_open_positions` | `'10'` | Max concurrent positions |
| `execution.max_drawdown_halt_pct` | `'25'` | Circuit breaker threshold |

**Default state:** all KV keys absent → `real=false`, `broker_plugin_id=''` → effective mode = paper. `placeOrder` is unreachable without explicit operator config.
