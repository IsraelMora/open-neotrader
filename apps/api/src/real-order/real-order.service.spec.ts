/**
 * real-order.service.spec.ts — TDD RED → GREEN for RealOrderService.
 *
 * Real-money accounting foundation slice. Covers:
 * - client_order_id generation shape + single-generation-per-submit guarantee.
 * - Crash-safe submit() ordering: DB row committed BEFORE the broker call, so a
 *   process crash between steps still leaves a discoverable row for recovery.
 * - Fail-soft submit(): never throws to the caller, always resolves with the row.
 * - recoverInflight(): reads broker truth first, NEVER blind-resubmits via placeOrder.
 *
 * Mocking style follows ml-signal-record.service.spec.ts (hand-built jest.fn() mocks,
 * manual `new Service(mockDb, mockGateway)` instantiation — no Test.createTestingModule
 * needed since RealOrderService has no other Nest-specific dependencies).
 */
import { RealOrderService } from './real-order.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { ProviderGatewayService } from '../providers/provider-gateway.service';
import { OPEN_STATUSES } from '../common/broker-status.util';

// ── Helpers ───────────────────────────────────────────────────────────────────

type RealOrderRow = {
  id: string;
  trade_intent_id: string;
  broker_plugin_id: string;
  client_order_id: string;
  broker_order_id: string | null;
  symbol: string;
  side: string;
  order_type: string;
  requested_qty: number;
  limit_price: number | null;
  status: string;
  filled_qty: number;
  filled_avg_price: number | null;
  submitted_at: Date | null;
  filled_at: Date | null;
  last_reconciled_at: Date | null;
  broker_raw_json: string | null;
  error: string | null;
};

function makeRow(overrides: Partial<RealOrderRow> = {}): RealOrderRow {
  return {
    id: 'ro_1',
    trade_intent_id: 'ti_1',
    broker_plugin_id: 'alpaca',
    client_order_id: 'nt-ti_1-abc12345',
    broker_order_id: null,
    symbol: 'AAPL',
    side: 'buy',
    order_type: 'market',
    requested_qty: 10,
    limit_price: null,
    status: 'pending_submit',
    filled_qty: 0,
    filled_avg_price: null,
    submitted_at: null,
    filled_at: null,
    last_reconciled_at: null,
    broker_raw_json: null,
    error: null,
    ...overrides,
  };
}

type RealOrderDelegateMock = {
  create: jest.Mock;
  update: jest.Mock;
  findMany: jest.Mock;
  findFirst: jest.Mock;
};

function makePrisma(opts?: {
  createResult?: RealOrderRow;
  createThrows?: Error;
  findManyResult?: RealOrderRow[];
  findFirstResult?: RealOrderRow | null;
}): jest.Mocked<Pick<PrismaService, 'realOrder'>> {
  const realOrder: RealOrderDelegateMock = {
    create: opts?.createThrows
      ? jest.fn().mockRejectedValue(opts.createThrows)
      : jest.fn().mockResolvedValue(opts?.createResult ?? makeRow()),
    update: jest.fn().mockResolvedValue(opts?.createResult ?? makeRow()),
    findMany: jest.fn().mockResolvedValue(opts?.findManyResult ?? []),
    findFirst: jest.fn().mockResolvedValue(opts?.findFirstResult ?? null),
  };
  return { realOrder } as unknown as jest.Mocked<Pick<PrismaService, 'realOrder'>>;
}

/** Simulates a Prisma unique-constraint violation (P2002) without importing @prisma/client's error class. */
function makeUniqueViolationError(): Error & { code: string } {
  const err = new Error('Unique constraint failed on the fields: (`trade_intent_id`)') as Error & {
    code: string;
  };
  err.code = 'P2002';
  return err;
}

function makeGateway(opts?: {
  placeOrderResult?: Record<string, unknown>;
  placeOrderThrows?: Error;
  getOrderByClientIdResult?: unknown;
  getOrderByClientIdThrows?: Error;
}): jest.Mocked<Pick<ProviderGatewayService, 'placeOrder' | 'getOrderByClientId'>> {
  const placeOrder = opts?.placeOrderThrows
    ? jest.fn().mockRejectedValue(opts.placeOrderThrows)
    : jest.fn().mockResolvedValue(opts?.placeOrderResult ?? { id: 'broker_order_1' });

  const getOrderByClientId = opts?.getOrderByClientIdThrows
    ? jest.fn().mockRejectedValue(opts.getOrderByClientIdThrows)
    : jest.fn().mockResolvedValue(opts?.getOrderByClientIdResult ?? null);

  return { placeOrder, getOrderByClientId };
}

/** Typed accessor for a jest.Mock's nth call's first argument (avoids unsafe `any` indexing). */
function callArg(calls: unknown[][], callIndex: number): { data: Record<string, unknown> } {
  return calls[callIndex][0] as { data: Record<string, unknown> };
}

/**
 * Stateful KV mock — mirrors real-broker-reconciliation.service.spec.ts's makeKv: `set`
 * writes are visible to later `get` calls against the SAME instance, so the kill-switch
 * tests below can assert on real_execution.halted/halt_reason like the real KvService.
 */
function makeKv(): {
  get: jest.Mock;
  set: jest.Mock;
  delete: jest.Mock;
} {
  const store: Record<string, string | null> = {};
  return {
    get: jest.fn().mockImplementation((key: string) => Promise.resolve(store[key] ?? null)),
    set: jest.fn().mockImplementation((key: string, value: string) => {
      store[key] = value;
      return Promise.resolve();
    }),
    delete: jest.fn().mockImplementation((key: string) => {
      delete store[key];
      return Promise.resolve();
    }),
  };
}

function makeService(
  prisma: ReturnType<typeof makePrisma>,
  gateway: ReturnType<typeof makeGateway>,
  kv: ReturnType<typeof makeKv> = makeKv(),
): RealOrderService {
  return new (RealOrderService as unknown as new (
    db: unknown,
    gateway: unknown,
    kv: unknown,
  ) => RealOrderService)(prisma, gateway, kv);
}

// ── generateClientOrderId ───────────────────────────────────────────────────────

describe('RealOrderService.generateClientOrderId', () => {
  it('matches shape nt-<8chars>-<8chars>', () => {
    const svc = makeService(makePrisma(), makeGateway());
    const id = svc.generateClientOrderId('trade-intent-uuid-123');
    expect(id).toMatch(/^nt-[a-zA-Z0-9-]{8}-[0-9a-f]{8}$/);
  });

  it('two calls produce different ids (fresh uuid each time)', () => {
    const svc = makeService(makePrisma(), makeGateway());
    const id1 = svc.generateClientOrderId('trade-intent-uuid-123');
    const id2 = svc.generateClientOrderId('trade-intent-uuid-123');
    expect(id1).not.toBe(id2);
  });
});

// ── submit — ordering guarantee ─────────────────────────────────────────────────

describe('RealOrderService.submit — ordering guarantee', () => {
  it('prisma.realOrder.create (pending_submit) is awaited BEFORE gateway.placeOrder is called', async () => {
    const callOrder: string[] = [];
    const prisma = makePrisma();
    (prisma.realOrder.create as jest.Mock).mockImplementation(() => {
      callOrder.push('create');
      return Promise.resolve(makeRow());
    });
    const gateway = makeGateway();
    (gateway.placeOrder as jest.Mock).mockImplementation(() => {
      callOrder.push('placeOrder');
      return Promise.resolve({ id: 'broker_order_1' });
    });
    const svc = makeService(prisma, gateway);

    await svc.submit({
      tradeIntentId: 'ti_1',
      brokerPluginId: 'alpaca',
      symbol: 'AAPL',
      side: 'buy',
      requestedQty: 10,
    });

    expect(callOrder).toEqual(['create', 'placeOrder']);

    // Also assert the create call was made with status: 'pending_submit'.
    const createCalls = (prisma.realOrder.create as jest.Mock).mock.calls as unknown[][];
    const createArgs = callArg(createCalls, 0);
    expect(createArgs.data['status']).toBe('pending_submit');
  });
});

// ── submit — success path ────────────────────────────────────────────────────────

describe('RealOrderService.submit — success path', () => {
  it('final update has status submitted + broker_order_id + submitted_at', async () => {
    const prisma = makePrisma({ createResult: makeRow() });
    const gateway = makeGateway({ placeOrderResult: { id: 'broker_order_99' } });
    const svc = makeService(prisma, gateway);

    const result = await svc.submit({
      tradeIntentId: 'ti_1',
      brokerPluginId: 'alpaca',
      symbol: 'AAPL',
      side: 'buy',
      requestedQty: 10,
    });

    const updateCalls = (prisma.realOrder.update as jest.Mock).mock.calls as unknown[][];
    const lastUpdate = callArg(updateCalls, updateCalls.length - 1);
    expect(lastUpdate.data['status']).toBe('submitted');
    expect(lastUpdate.data['broker_order_id']).toBe('broker_order_99');
    expect(lastUpdate.data['submitted_at']).toBeInstanceOf(Date);
    expect(result).toBeDefined();
  });
});

// ── submit — failure path (fail-soft) ────────────────────────────────────────────

describe('RealOrderService.submit — failure path', () => {
  it('final update has status submit_failed + error, and submit() resolves (never throws)', async () => {
    const prisma = makePrisma({ createResult: makeRow() });
    const gateway = makeGateway({ placeOrderThrows: new Error('broker unreachable') });
    const svc = makeService(prisma, gateway);

    await expect(
      svc.submit({
        tradeIntentId: 'ti_1',
        brokerPluginId: 'alpaca',
        symbol: 'AAPL',
        side: 'buy',
        requestedQty: 10,
      }),
    ).resolves.toBeDefined();

    const updateCalls = (prisma.realOrder.update as jest.Mock).mock.calls as unknown[][];
    const lastUpdate = callArg(updateCalls, updateCalls.length - 1);
    expect(lastUpdate.data['status']).toBe('submit_failed');
    expect(lastUpdate.data['error']).toContain('broker unreachable');
  });
});

// ── submit — repeated failures trip the real-money kill-switch (R8) ──────────────
//
// A simple in-memory sliding window: 3 consecutive submit_failed events within 5
// minutes trips the switch. Fewer failures, or failures spread outside the window,
// must NOT trip it.

describe('RealOrderService.submit — repeated failures trip the kill-switch', () => {
  it('3 consecutive submit failures within the window halt real execution with the correct reason', async () => {
    const prisma = makePrisma({ createResult: makeRow() });
    const gateway = makeGateway({ placeOrderThrows: new Error('broker unreachable') });
    const kv = makeKv();
    const svc = makeService(prisma, gateway, kv);

    await svc.submit({
      tradeIntentId: 'ti_1',
      brokerPluginId: 'alpaca',
      symbol: 'AAPL',
      side: 'buy',
      requestedQty: 10,
    });
    expect(await kv.get('real_execution.halted')).toBeNull();

    await svc.submit({
      tradeIntentId: 'ti_2',
      brokerPluginId: 'alpaca',
      symbol: 'AAPL',
      side: 'buy',
      requestedQty: 10,
    });
    expect(await kv.get('real_execution.halted')).toBeNull();

    await svc.submit({
      tradeIntentId: 'ti_3',
      brokerPluginId: 'alpaca',
      symbol: 'AAPL',
      side: 'buy',
      requestedQty: 10,
    });

    expect(await kv.get('real_execution.halted')).toBe('true');
    expect(await kv.get('real_execution.halt_reason')).toContain(
      'repeated real order submit failures',
    );
  });

  it('fewer than 3 consecutive failures do NOT trip the kill-switch', async () => {
    const prisma = makePrisma({ createResult: makeRow() });
    const gateway = makeGateway({ placeOrderThrows: new Error('broker unreachable') });
    const kv = makeKv();
    const svc = makeService(prisma, gateway, kv);

    await svc.submit({
      tradeIntentId: 'ti_1',
      brokerPluginId: 'alpaca',
      symbol: 'AAPL',
      side: 'buy',
      requestedQty: 10,
    });
    await svc.submit({
      tradeIntentId: 'ti_2',
      brokerPluginId: 'alpaca',
      symbol: 'AAPL',
      side: 'buy',
      requestedQty: 10,
    });

    expect(await kv.get('real_execution.halted')).toBeNull();
  });

  it('a success in between resets the consecutive-failure count — 2 failures + 1 success + 2 failures does NOT trip it', async () => {
    const prisma = makePrisma({ createResult: makeRow() });
    const kv = makeKv();
    const failingGateway = makeGateway({ placeOrderThrows: new Error('broker unreachable') });
    const svc = makeService(prisma, failingGateway, kv);

    await svc.submit({
      tradeIntentId: 'ti_1',
      brokerPluginId: 'alpaca',
      symbol: 'AAPL',
      side: 'buy',
      requestedQty: 10,
    });
    await svc.submit({
      tradeIntentId: 'ti_2',
      brokerPluginId: 'alpaca',
      symbol: 'AAPL',
      side: 'buy',
      requestedQty: 10,
    });

    // A successful submit in between resets the streak.
    (failingGateway.placeOrder as jest.Mock).mockResolvedValueOnce({ id: 'broker_order_ok' });
    await svc.submit({
      tradeIntentId: 'ti_3',
      brokerPluginId: 'alpaca',
      symbol: 'AAPL',
      side: 'buy',
      requestedQty: 10,
    });

    await svc.submit({
      tradeIntentId: 'ti_4',
      brokerPluginId: 'alpaca',
      symbol: 'AAPL',
      side: 'buy',
      requestedQty: 10,
    });
    await svc.submit({
      tradeIntentId: 'ti_5',
      brokerPluginId: 'alpaca',
      symbol: 'AAPL',
      side: 'buy',
      requestedQty: 10,
    });

    expect(await kv.get('real_execution.halted')).toBeNull();
  });

  it('failures outside the 5-minute window do NOT accumulate towards the threshold', async () => {
    jest.useFakeTimers();
    try {
      const prisma = makePrisma({ createResult: makeRow() });
      const gateway = makeGateway({ placeOrderThrows: new Error('broker unreachable') });
      const kv = makeKv();
      const svc = makeService(prisma, gateway, kv);

      await svc.submit({
        tradeIntentId: 'ti_1',
        brokerPluginId: 'alpaca',
        symbol: 'AAPL',
        side: 'buy',
        requestedQty: 10,
      });
      await svc.submit({
        tradeIntentId: 'ti_2',
        brokerPluginId: 'alpaca',
        symbol: 'AAPL',
        side: 'buy',
        requestedQty: 10,
      });

      // Advance past the 5-minute window — the first two failures should age out.
      jest.advanceTimersByTime(5 * 60_000 + 1);

      await svc.submit({
        tradeIntentId: 'ti_3',
        brokerPluginId: 'alpaca',
        symbol: 'AAPL',
        side: 'buy',
        requestedQty: 10,
      });

      expect(await kv.get('real_execution.halted')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});

// ── recoverInflight — broker already has the order ───────────────────────────────

describe('RealOrderService.recoverInflight — broker already has it', () => {
  it('updates the row to broker truth and NEVER calls placeOrder', async () => {
    const pendingRow = makeRow({ id: 'ro_pending', status: 'pending_submit' });
    const prisma = makePrisma({ findManyResult: [pendingRow] });
    const gateway = makeGateway({
      getOrderByClientIdResult: {
        broker_order_id: 'broker_order_555',
        client_order_id: pendingRow.client_order_id,
        status: 'filled',
        filled_qty: 10,
        filled_avg_price: 150.5,
        raw: {},
      },
    });
    const svc = makeService(prisma, gateway);

    await svc.recoverInflight();

    expect(gateway.getOrderByClientId).toHaveBeenCalledWith('alpaca', pendingRow.client_order_id);
    expect(gateway.placeOrder).not.toHaveBeenCalled();

    const updateCalls = (prisma.realOrder.update as jest.Mock).mock.calls as unknown[][];
    expect(updateCalls.length).toBeGreaterThan(0);
    const data = callArg(updateCalls, 0);
    expect(data.data['broker_order_id']).toBe('broker_order_555');
  });
});

// ── recoverInflight — broker-status vocabulary must be fully mapped (Fix 1) ──────

describe('RealOrderService.recoverInflight — broker-status normalization (Fix 1)', () => {
  it('broker reports "new" (an Alpaca status outside the old raw-status vocabulary) — the row ends in a pollable OPEN status with broker_order_id set, never the raw "new" string', async () => {
    const pendingRow = makeRow({ id: 'ro_new', status: 'pending_submit' });
    const prisma = makePrisma({ findManyResult: [pendingRow] });
    const gateway = makeGateway({
      getOrderByClientIdResult: {
        broker_order_id: 'broker_order_new',
        client_order_id: pendingRow.client_order_id,
        status: 'new',
        filled_qty: 0,
        filled_avg_price: null,
        raw: {},
      },
    });
    const svc = makeService(prisma, gateway);

    await svc.recoverInflight();

    const updateCalls = (prisma.realOrder.update as jest.Mock).mock.calls as unknown[][];
    expect(updateCalls.length).toBeGreaterThan(0);
    const data = callArg(updateCalls, 0);
    expect(data.data['broker_order_id']).toBe('broker_order_new');
    // Never the raw "new" string — must be a normalized, pollable OPEN status so
    // reconcileAllOpenOrders() (WHERE status IN OPEN_STATUSES) re-selects this row.
    expect(data.data['status']).not.toBe('new');
    expect(OPEN_STATUSES).toContain(data.data['status']);
  });

  it('broker reports "filled" — recoverRow does NOT write filled/filled_qty/filled_avg_price directly (no one-sided ledger write); it leaves the row in a pollable OPEN status so the transactional reconcileOrder() path performs the real fill + TradeIntent update', async () => {
    const pendingRow = makeRow({ id: 'ro_filled', status: 'pending_submit' });
    const prisma = makePrisma({ findManyResult: [pendingRow] });
    const gateway = makeGateway({
      getOrderByClientIdResult: {
        broker_order_id: 'broker_order_filled',
        client_order_id: pendingRow.client_order_id,
        status: 'filled',
        filled_qty: 10,
        filled_avg_price: 150.5,
        raw: {},
      },
    });
    const svc = makeService(prisma, gateway);

    await svc.recoverInflight();

    const updateCalls = (prisma.realOrder.update as jest.Mock).mock.calls as unknown[][];
    expect(updateCalls.length).toBeGreaterThan(0);
    const data = callArg(updateCalls, 0);
    expect(data.data['broker_order_id']).toBe('broker_order_filled');
    // Must NOT directly set status=filled or write fill numbers — that would bypass the
    // single $transaction that keeps RealOrder and TradeIntent in sync (ledger desync risk).
    expect(data.data['status']).not.toBe('filled');
    expect(OPEN_STATUSES).toContain(data.data['status']);
    expect(data.data['filled_qty']).toBeUndefined();
    expect(data.data['filled_avg_price']).toBeUndefined();
  });
});

// ── recoverInflight — broker never received it ───────────────────────────────────

describe('RealOrderService.recoverInflight — broker never received it', () => {
  it('never calls placeOrder even when the broker has no record of the order', async () => {
    const pendingRow = makeRow({ id: 'ro_pending2', status: 'submit_failed' });
    const prisma = makePrisma({ findManyResult: [pendingRow] });
    const gateway = makeGateway({ getOrderByClientIdResult: null });
    const svc = makeService(prisma, gateway);

    await svc.recoverInflight();

    expect(gateway.getOrderByClientId).toHaveBeenCalledWith('alpaca', pendingRow.client_order_id);
    expect(gateway.placeOrder).not.toHaveBeenCalled();
  });

  it('does not throw when getOrderByClientId itself throws (fail-soft per row)', async () => {
    const pendingRow = makeRow({ id: 'ro_pending3', status: 'pending_submit' });
    const prisma = makePrisma({ findManyResult: [pendingRow] });
    const gateway = makeGateway({ getOrderByClientIdThrows: new Error('network down') });
    const svc = makeService(prisma, gateway);

    await expect(svc.recoverInflight()).resolves.toBeUndefined();
    expect(gateway.placeOrder).not.toHaveBeenCalled();
  });

  it('confirmed-not-found (null) and lookup-error are distinct branches: neither resubmits, and a second row still gets processed after the first row errors', async () => {
    const rowNotFound = makeRow({ id: 'ro_notfound', status: 'pending_submit' });
    const rowLookupError = makeRow({
      id: 'ro_lookuperr',
      client_order_id: 'nt-ti_2-def67890',
      status: 'pending_submit',
    });
    const prisma = makePrisma({ findManyResult: [rowLookupError, rowNotFound] });
    const gateway: jest.Mocked<Pick<ProviderGatewayService, 'placeOrder' | 'getOrderByClientId'>> =
      {
        placeOrder: jest.fn().mockResolvedValue({ id: 'broker_order_1' }),
        getOrderByClientId: jest
          .fn()
          .mockRejectedValueOnce(new Error('network down'))
          .mockResolvedValueOnce(null),
      };
    const svc = makeService(prisma, gateway);

    await expect(svc.recoverInflight()).resolves.toBeUndefined();

    // Both rows were attempted (one row's lookup failure did not abort the loop).
    expect(gateway.getOrderByClientId).toHaveBeenCalledTimes(2);
    expect(gateway.placeOrder).not.toHaveBeenCalled();
    // Neither branch (confirmed-not-found nor lookup-error) writes a reconcile update.
    expect((prisma.realOrder.update as jest.Mock).mock.calls).toHaveLength(0);
  });
});

// ── submit — per-intent idempotency (Fix 1) ──────────────────────────────────────

describe('RealOrderService.submit — per-intent idempotency', () => {
  it('a second submit() for the same trade_intent_id returns the existing ACTIVE row without calling placeOrder or create', async () => {
    const activeRow = makeRow({ id: 'ro_active', trade_intent_id: 'ti_dup', status: 'submitted' });
    const prisma = makePrisma({ findFirstResult: activeRow });
    const gateway = makeGateway();
    const svc = makeService(prisma, gateway);

    const result = await svc.submit({
      tradeIntentId: 'ti_dup',
      brokerPluginId: 'alpaca',
      symbol: 'AAPL',
      side: 'buy',
      requestedQty: 10,
    });

    expect(result).toEqual(activeRow);
    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect((prisma.realOrder.create as jest.Mock).mock.calls).toHaveLength(0);
  });

  it('a TERMINAL prior order (e.g. rejected) for the same intent does NOT block a fresh submit', async () => {
    // findFirst is scoped to non-terminal statuses at the query level, so a terminal-only
    // history means no active row is found — the mock simply returns null (no active row).
    const prisma = makePrisma({ findFirstResult: null, createResult: makeRow({ id: 'ro_new' }) });
    const gateway = makeGateway({ placeOrderResult: { id: 'broker_order_new' } });
    const svc = makeService(prisma, gateway);

    await svc.submit({
      tradeIntentId: 'ti_fresh',
      brokerPluginId: 'alpaca',
      symbol: 'AAPL',
      side: 'buy',
      requestedQty: 10,
    });

    expect((prisma.realOrder.create as jest.Mock).mock.calls).toHaveLength(1);
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
  });

  it('the findFirst guard query excludes terminal statuses (filled, canceled, rejected, expired, submit_failed)', async () => {
    const prisma = makePrisma({ findFirstResult: null });
    const gateway = makeGateway();
    const svc = makeService(prisma, gateway);

    await svc.submit({
      tradeIntentId: 'ti_1',
      brokerPluginId: 'alpaca',
      symbol: 'AAPL',
      side: 'buy',
      requestedQty: 10,
    });

    const findFirstCalls = (prisma.realOrder.findFirst as jest.Mock).mock.calls as unknown[][];
    expect(findFirstCalls.length).toBeGreaterThan(0);
    const args = findFirstCalls[0][0] as { where: { status: { notIn: string[] } } };
    const actualSorted = [...args.where.status.notIn].sort((a, b) => a.localeCompare(b));
    const expectedSorted = ['canceled', 'expired', 'filled', 'rejected', 'submit_failed'].sort(
      (a, b) => a.localeCompare(b),
    );
    expect(actualSorted).toEqual(expectedSorted);
  });

  it('a P2002 unique-violation race on create() is handled defensively: fetches and returns the existing active row instead of throwing', async () => {
    const raceWinnerRow = makeRow({ id: 'ro_race_winner', status: 'pending_submit' });
    const prisma = makePrisma({ createThrows: makeUniqueViolationError() });
    // First findFirst call (pre-check) finds nothing; second (post-P2002 recovery) finds the row
    // created by the concurrent winner.
    (prisma.realOrder.findFirst as jest.Mock)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(raceWinnerRow);
    const gateway = makeGateway();
    const svc = makeService(prisma, gateway);

    const result = await svc.submit({
      tradeIntentId: 'ti_race',
      brokerPluginId: 'alpaca',
      symbol: 'AAPL',
      side: 'buy',
      requestedQty: 10,
    });

    expect(result).toEqual(raceWinnerRow);
    expect(gateway.placeOrder).not.toHaveBeenCalled();
  });
});

// ── onModuleInit — bootstrap recovery wiring (Fix 2) ──────────────────────────────

describe('RealOrderService.onModuleInit', () => {
  it('invokes recoverInflight on module init', async () => {
    const prisma = makePrisma({ findManyResult: [] });
    const gateway = makeGateway();
    const svc = makeService(prisma, gateway);
    const spy = jest.spyOn(svc, 'recoverInflight');

    await svc.onModuleInit();

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('swallows an error thrown by recoverInflight — boot is never blocked', async () => {
    const prisma = makePrisma();
    const gateway = makeGateway();
    const svc = makeService(prisma, gateway);
    jest.spyOn(svc, 'recoverInflight').mockRejectedValue(new Error('recovery blew up'));

    await expect(svc.onModuleInit()).resolves.toBeUndefined();
  });
});

// ── submit — unconditional fail-soft on DB writes (Fix 3) ────────────────────────

describe('RealOrderService.submit — unconditional fail-soft on DB writes', () => {
  it('placeOrder succeeds but the subsequent success-path status update throws: submit() does not throw and the row is NOT relabeled submit_failed', async () => {
    const createdRow = makeRow({ id: 'ro_success_update_fails', status: 'pending_submit' });
    const prisma = makePrisma({ createResult: createdRow, findFirstResult: null });
    (prisma.realOrder.update as jest.Mock).mockRejectedValue(new Error('db write failed'));
    const gateway = makeGateway({ placeOrderResult: { id: 'broker_order_live' } });
    const svc = makeService(prisma, gateway);

    const result = await svc.submit({
      tradeIntentId: 'ti_1',
      brokerPluginId: 'alpaca',
      symbol: 'AAPL',
      side: 'buy',
      requestedQty: 10,
    });

    expect(result).toBeDefined();
    expect(result.status).not.toBe('submit_failed');
  });

  it('placeOrder throws AND the submit_failed status update also throws: submit() still does not throw', async () => {
    const createdRow = makeRow({ id: 'ro_both_fail', status: 'pending_submit' });
    const prisma = makePrisma({ createResult: createdRow, findFirstResult: null });
    (prisma.realOrder.update as jest.Mock).mockRejectedValue(new Error('db write failed'));
    const gateway = makeGateway({ placeOrderThrows: new Error('broker unreachable') });
    const svc = makeService(prisma, gateway);

    await expect(
      svc.submit({
        tradeIntentId: 'ti_1',
        brokerPluginId: 'alpaca',
        symbol: 'AAPL',
        side: 'buy',
        requestedQty: 10,
      }),
    ).resolves.toBeDefined();
  });
});
