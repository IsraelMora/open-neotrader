/**
 * real-broker-reconciliation.service.spec.ts — TDD RED → GREEN for
 * RealBrokerReconciliationService.reconcileOrder().
 *
 * Money-critical invariant under test: a fill must never appear on one side
 * (RealOrder) without the other (TradeIntent) — the transition to a terminal
 * state (filled / rejected / canceled / expired) is always a single
 * `$transaction` call touching both rows together.
 *
 * Mocking style follows real-order.service.spec.ts / ml-signal-record.service.spec.ts
 * (hand-built jest.fn() mocks, manual `new Service(mockDb, mockGateway)`
 * instantiation — no Test.createTestingModule needed).
 */
import { RealBrokerReconciliationService } from './real-broker-reconciliation.service';
import { RealOrderService } from '../real-order/real-order.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { ProviderGatewayService } from '../providers/provider-gateway.service';
import type { KvService } from '../common/kv.service';
import type { AlertsService } from '../alerts/alerts.service';

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
    broker_order_id: 'broker_order_1',
    symbol: 'AAPL',
    side: 'buy',
    order_type: 'market',
    requested_qty: 10,
    limit_price: null,
    status: 'submitted',
    filled_qty: 0,
    filled_avg_price: null,
    submitted_at: new Date(),
    filled_at: null,
    last_reconciled_at: null,
    broker_raw_json: null,
    error: null,
    ...overrides,
  };
}

type TxClient = {
  realOrder: { update: jest.Mock; updateMany: jest.Mock };
  tradeIntent: { update: jest.Mock };
};

/**
 * updateMany defaults to `{ count: 1 }` (a "the compare-and-set WHERE matched"
 * success) so existing tests that don't care about the optimistic-concurrency
 * guard (Fix 3) keep passing unchanged; tests that DO care override it to
 * `{ count: 0 }` to simulate a stale write losing the race.
 */
function makeTxClient(): TxClient {
  return {
    realOrder: {
      update: jest.fn().mockResolvedValue(undefined),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    tradeIntent: { update: jest.fn().mockResolvedValue(undefined) },
  };
}

/**
 * findMany is exposed a second time as `_realOrderFindMany` (a plain jest.Mock, not typed
 * through PrismaService's generated delegate) because referencing `prisma.realOrder.findMany`
 * directly trips @typescript-eslint/unbound-method — the generated Prisma delegate types the
 * method with an implicit `this`, and that lint rule flags any bare reference to it (even
 * behind an `as jest.Mock` cast) as unsafe to detach from its object.
 */
function makePrisma(opts?: {
  findUniqueResult?: RealOrderRow | null;
  txClient?: TxClient;
}): jest.Mocked<Pick<PrismaService, 'realOrder' | 'tradeIntent' | '$transaction'>> & {
  _realOrderFindMany: jest.Mock;
} {
  const txClient = opts?.txClient ?? makeTxClient();
  const realOrderFindMany = jest.fn().mockResolvedValue([]);
  const realOrder = {
    findUnique: jest.fn().mockResolvedValue(opts?.findUniqueResult ?? makeRow()),
    update: jest.fn().mockResolvedValue(undefined),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    findMany: realOrderFindMany,
  };
  const tradeIntent = {
    update: jest.fn().mockResolvedValue(undefined),
  };
  const $transaction = jest.fn().mockImplementation(async (fn: (tx: TxClient) => Promise<void>) => {
    return fn(txClient);
  });

  return {
    realOrder,
    tradeIntent,
    $transaction,
    _realOrderFindMany: realOrderFindMany,
  } as unknown as jest.Mocked<Pick<PrismaService, 'realOrder' | 'tradeIntent' | '$transaction'>> & {
    _realOrderFindMany: jest.Mock;
  };
}

function makeGateway(opts?: {
  getOrderStatusResult?: unknown;
  getOrderStatusThrows?: Error;
  getOrderByClientIdResult?: unknown;
  getOrderByClientIdThrows?: Error;
}): jest.Mocked<Pick<ProviderGatewayService, 'getOrderStatus' | 'getOrderByClientId'>> {
  const getOrderStatus = opts?.getOrderStatusThrows
    ? jest.fn().mockRejectedValue(opts.getOrderStatusThrows)
    : jest.fn().mockResolvedValue(opts?.getOrderStatusResult ?? null);

  const getOrderByClientId = opts?.getOrderByClientIdThrows
    ? jest.fn().mockRejectedValue(opts.getOrderByClientIdThrows)
    : jest.fn().mockResolvedValue(opts?.getOrderByClientIdResult ?? null);

  return { getOrderStatus, getOrderByClientId };
}

/**
 * Stateful KV mock — `set` writes are visible to later `get` calls against the
 * SAME instance, so tests can exercise the KV-persisted circuit breaker (Fix 2)
 * realistically (state survives across ticks, exactly like the real KvService
 * backed by the configEntry table).
 */
function makeKv(
  kvData: Record<string, string | null> = {},
): jest.Mocked<Pick<KvService, 'get' | 'set'>> & { _store: Record<string, string | null> } {
  const store: Record<string, string | null> = { ...kvData };
  return {
    get: jest.fn().mockImplementation((key: string) => Promise.resolve(store[key] ?? null)),
    set: jest.fn().mockImplementation((key: string, value: string) => {
      store[key] = value;
      return Promise.resolve();
    }),
    _store: store,
  };
}

function makeAlerts(): jest.Mocked<Pick<AlertsService, 'create'>> {
  return {
    create: jest.fn().mockResolvedValue({ id: 'alert_1' }),
  };
}

/**
 * Default RealOrderService collaborator mock — resolves recoverInflight() to a no-op
 * so the existing 71 tests (which don't care about the Fix 1 pre-tick sweep) keep
 * passing unchanged. Tests that DO care (Fix 1) pass their own instance.
 */
function makeRealOrderService(): jest.Mocked<Pick<RealOrderService, 'recoverInflight'>> {
  return { recoverInflight: jest.fn().mockResolvedValue(undefined) };
}

function makeService(
  prisma: ReturnType<typeof makePrisma>,
  gateway: ReturnType<typeof makeGateway>,
  kv: ReturnType<typeof makeKv> = makeKv(),
  alerts: ReturnType<typeof makeAlerts> = makeAlerts(),
  realOrderService:
    | ReturnType<typeof makeRealOrderService>
    | RealOrderService = makeRealOrderService(),
): RealBrokerReconciliationService {
  return new (RealBrokerReconciliationService as unknown as new (
    db: unknown,
    gateway: unknown,
    kv: unknown,
    alerts: unknown,
    realOrderService: unknown,
  ) => RealBrokerReconciliationService)(prisma, gateway, kv, alerts, realOrderService);
}

/** Typed accessor for a jest mock's nth call's first argument (avoids unsafe `any` indexing). */
function callArg<T>(fn: { mock: { calls: unknown[][] } }, callIndex = 0): T {
  return fn.mock.calls[callIndex][0] as T;
}

// ── filled ───────────────────────────────────────────────────────────────────

describe('RealBrokerReconciliationService.reconcileOrder — filled', () => {
  it('single $transaction updates RealOrder(filled) AND TradeIntent(executed, fill_price, quantity)', async () => {
    const txClient = makeTxClient();
    const row = makeRow({ status: 'submitted' });
    const prisma = makePrisma({ findUniqueResult: row, txClient });
    const gateway = makeGateway({
      getOrderStatusResult: {
        broker_order_id: 'broker_order_1',
        client_order_id: row.client_order_id,
        status: 'filled',
        filled_qty: 10,
        filled_avg_price: 150.5,
        raw: {},
      },
    });
    const svc = makeService(prisma, gateway);

    await svc.reconcileOrder('ro_1');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // updateMany (not update) — carries the compare-and-set WHERE that guards
    // against a stale write regressing a row another writer already advanced
    // (Fix 3: optimistic concurrency guard).
    expect(txClient.realOrder.updateMany).toHaveBeenCalledTimes(1);
    expect(txClient.tradeIntent.update).toHaveBeenCalledTimes(1);

    const roArgs = callArg<{
      where: { id: string; status: string };
      data: Record<string, unknown>;
    }>(txClient.realOrder.updateMany);
    expect(roArgs.where.id).toBe('ro_1');
    expect(roArgs.where.status).toBe(row.status);
    expect(roArgs.data['status']).toBe('filled');
    expect(roArgs.data['filled_qty']).toBe(10);
    expect(roArgs.data['filled_avg_price']).toBeCloseTo(150.5, 5);
    expect(roArgs.data['filled_at']).toBeInstanceOf(Date);
    expect(roArgs.data['last_reconciled_at']).toBeInstanceOf(Date);

    const tiArgs = callArg<{ where: { id: string }; data: Record<string, unknown> }>(
      txClient.tradeIntent.update,
    );
    expect(tiArgs.where.id).toBe('ti_1');
    expect(tiArgs.data['status']).toBe('executed');
    expect(tiArgs.data['fill_price']).toBeCloseTo(150.5, 5);
    expect(tiArgs.data['quantity']).toBe(10);

    // Never two separate awaited updates outside a transaction for the fill path.
    expect((prisma.realOrder.update as jest.Mock).mock.calls).toHaveLength(0);
    expect((prisma.realOrder.updateMany as jest.Mock).mock.calls).toHaveLength(0);
    expect((prisma.tradeIntent.update as jest.Mock).mock.calls).toHaveLength(0);
  });

  it('prefers getOrderStatus when broker_order_id is present', async () => {
    const row = makeRow({ status: 'submitted', broker_order_id: 'broker_order_1' });
    const prisma = makePrisma({ findUniqueResult: row });
    const gateway = makeGateway({
      getOrderStatusResult: {
        broker_order_id: 'broker_order_1',
        client_order_id: row.client_order_id,
        status: 'new',
        filled_qty: 0,
        filled_avg_price: null,
        raw: {},
      },
    });
    const svc = makeService(prisma, gateway);

    await svc.reconcileOrder('ro_1');

    expect(gateway.getOrderStatus).toHaveBeenCalledWith('alpaca', 'broker_order_1');
    expect(gateway.getOrderByClientId).not.toHaveBeenCalled();
  });

  it('falls back to getOrderByClientId when broker_order_id is null', async () => {
    const row = makeRow({ status: 'pending_submit', broker_order_id: null });
    const prisma = makePrisma({ findUniqueResult: row });
    const gateway = makeGateway({
      getOrderByClientIdResult: {
        broker_order_id: 'broker_order_new',
        client_order_id: row.client_order_id,
        status: 'new',
        filled_qty: 0,
        filled_avg_price: null,
        raw: {},
      },
    });
    const svc = makeService(prisma, gateway);

    await svc.reconcileOrder('ro_1');

    expect(gateway.getOrderByClientId).toHaveBeenCalledWith('alpaca', row.client_order_id);
    expect(gateway.getOrderStatus).not.toHaveBeenCalled();
  });
});

// ── partially_filled ─────────────────────────────────────────────────────────

describe('RealBrokerReconciliationService.reconcileOrder — partially_filled', () => {
  it('updates RealOrder(partially_filled) via a plain update; TradeIntent stays real_pending', async () => {
    const row = makeRow({ status: 'submitted' });
    const prisma = makePrisma({ findUniqueResult: row });
    const gateway = makeGateway({
      getOrderStatusResult: {
        broker_order_id: 'broker_order_1',
        client_order_id: row.client_order_id,
        status: 'partially_filled',
        filled_qty: 4,
        filled_avg_price: 149.9,
        raw: {},
      },
    });
    const svc = makeService(prisma, gateway);

    await svc.reconcileOrder('ro_1');

    expect(prisma.$transaction).not.toHaveBeenCalled();
    // updateMany (not update) — carries the compare-and-set WHERE (Fix 3).
    const updateCalls = (prisma.realOrder.updateMany as jest.Mock).mock.calls as unknown[][];
    const updateArgs = updateCalls[0][0] as {
      where: { id: string; status: string };
      data: Record<string, unknown>;
    };
    expect(updateArgs.where.id).toBe('ro_1');
    expect(updateArgs.where.status).toBe(row.status);
    expect(updateArgs.data['status']).toBe('partially_filled');
    expect(updateArgs.data['filled_qty']).toBe(4);
    expect(updateArgs.data['filled_avg_price']).toBeCloseTo(149.9, 5);
    expect((prisma.realOrder.update as jest.Mock).mock.calls).toHaveLength(0);
    expect((prisma.tradeIntent.update as jest.Mock).mock.calls).toHaveLength(0);
  });

  it('partially_filled → filled: TradeIntent flips to executed with cumulative fill values', async () => {
    const txClient = makeTxClient();
    const row = makeRow({ status: 'partially_filled', filled_qty: 4, filled_avg_price: 149.9 });
    const prisma = makePrisma({ findUniqueResult: row, txClient });
    const gateway = makeGateway({
      getOrderStatusResult: {
        broker_order_id: 'broker_order_1',
        client_order_id: row.client_order_id,
        status: 'filled',
        filled_qty: 10,
        filled_avg_price: 150.2,
        raw: {},
      },
    });
    const svc = makeService(prisma, gateway);

    await svc.reconcileOrder('ro_1');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const tiArgs = callArg<{ data: Record<string, unknown> }>(txClient.tradeIntent.update);
    expect(tiArgs.data['status']).toBe('executed');
    expect(tiArgs.data['fill_price']).toBeCloseTo(150.2, 5);
    expect(tiArgs.data['quantity']).toBe(10);
  });
});

// ── rejected / canceled / expired ────────────────────────────────────────────

describe.each(['rejected', 'canceled', 'expired'])(
  'RealBrokerReconciliationService.reconcileOrder — %s',
  (brokerStatus) => {
    it(`transactionally sets RealOrder(${brokerStatus}) AND TradeIntent(failed) with reject_reason`, async () => {
      const txClient = makeTxClient();
      const row = makeRow({ status: 'submitted' });
      const prisma = makePrisma({ findUniqueResult: row, txClient });
      const gateway = makeGateway({
        getOrderStatusResult: {
          broker_order_id: 'broker_order_1',
          client_order_id: row.client_order_id,
          status: brokerStatus,
          filled_qty: 0,
          filled_avg_price: null,
          raw: {},
        },
      });
      const svc = makeService(prisma, gateway);

      await svc.reconcileOrder('ro_1');

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      const roArgs = callArg<{
        where: { id: string; status: string };
        data: Record<string, unknown>;
      }>(txClient.realOrder.updateMany);
      expect(roArgs.where.id).toBe('ro_1');
      expect(roArgs.where.status).toBe(row.status);
      expect(roArgs.data['status']).toBe(brokerStatus);

      const tiArgs = callArg<{ data: Record<string, unknown> }>(txClient.tradeIntent.update);
      expect(tiArgs.data['status']).toBe('failed');
      expect(typeof tiArgs.data['reject_reason']).toBe('string');
      expect((tiArgs.data['reject_reason'] as string).length).toBeGreaterThan(0);
    });
  },
);

// ── Fix 2 — a partial fill survives a terminal cancel/expire/reject ─────────

describe('RealBrokerReconciliationService.reconcileOrder — Fix 2: partial fill preserved on terminal transition', () => {
  it('order filled 5 of 10 then canceled: TradeIntent is executed (NOT failed) with quantity=5 and fill_price=filled_avg_price, in the SAME $transaction; RealOrder.status stays canceled', async () => {
    const txClient = makeTxClient();
    const row = makeRow({ status: 'partially_filled', filled_qty: 5, filled_avg_price: 149.5 });
    const prisma = makePrisma({ findUniqueResult: row, txClient });
    const gateway = makeGateway({
      getOrderStatusResult: {
        broker_order_id: 'broker_order_1',
        client_order_id: row.client_order_id,
        status: 'canceled',
        filled_qty: 5,
        filled_avg_price: 149.5,
        raw: {},
      },
    });
    const svc = makeService(prisma, gateway);

    await svc.reconcileOrder('ro_1');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const roArgs = callArg<{ data: Record<string, unknown> }>(txClient.realOrder.updateMany);
    // RealOrder's OWN lifecycle status is still accurately "canceled" — only the
    // TradeIntent fill accounting changes.
    expect(roArgs.data['status']).toBe('canceled');

    const tiArgs = callArg<{ data: Record<string, unknown> }>(txClient.tradeIntent.update);
    expect(tiArgs.data['status']).toBe('executed');
    expect(tiArgs.data['quantity']).toBe(5);
    expect(tiArgs.data['fill_price']).toBeCloseTo(149.5, 5);
    expect(tiArgs.data['reject_reason']).toBeUndefined();
  });

  it('order jumps directly from submitted (filled_qty=0) to canceled with a fresh partial fill revealed in this same call: RealOrder.filled_qty/filled_avg_price are persisted so detectDrift can still find it', async () => {
    const txClient = makeTxClient();
    const row = makeRow({ status: 'submitted', filled_qty: 0, filled_avg_price: null });
    const prisma = makePrisma({ findUniqueResult: row, txClient });
    const gateway = makeGateway({
      getOrderStatusResult: {
        broker_order_id: 'broker_order_1',
        client_order_id: row.client_order_id,
        status: 'canceled',
        filled_qty: 5,
        filled_avg_price: 149.5,
        raw: {},
      },
    });
    const svc = makeService(prisma, gateway);

    await svc.reconcileOrder('ro_1');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const roArgs = callArg<{ data: Record<string, unknown> }>(txClient.realOrder.updateMany);
    expect(roArgs.data['status']).toBe('canceled');
    // Regression: RealOrder's own filled_qty/filled_avg_price must be persisted too —
    // otherwise detectDrift's `filled_qty: { gt: 0 }` query never finds this order and
    // fires a false BROKER_DRIFT alert / kill-switch trip.
    expect(roArgs.data['filled_qty']).toBe(5);
    expect(roArgs.data['filled_avg_price']).toBeCloseTo(149.5, 5);

    const tiArgs = callArg<{ data: Record<string, unknown> }>(txClient.tradeIntent.update);
    expect(tiArgs.data['status']).toBe('executed');
    expect(tiArgs.data['quantity']).toBe(5);
    expect(tiArgs.data['fill_price']).toBeCloseTo(149.5, 5);
  });

  it('order filled 0 (no partial fill) then canceled: TradeIntent still becomes failed with a reject_reason — unchanged existing behavior', async () => {
    const txClient = makeTxClient();
    const row = makeRow({ status: 'submitted', filled_qty: 0, filled_avg_price: null });
    const prisma = makePrisma({ findUniqueResult: row, txClient });
    const gateway = makeGateway({
      getOrderStatusResult: {
        broker_order_id: 'broker_order_1',
        client_order_id: row.client_order_id,
        status: 'canceled',
        filled_qty: 0,
        filled_avg_price: null,
        raw: {},
      },
    });
    const svc = makeService(prisma, gateway);

    await svc.reconcileOrder('ro_1');

    const tiArgs = callArg<{ data: Record<string, unknown> }>(txClient.tradeIntent.update);
    expect(tiArgs.data['status']).toBe('failed');
    expect(typeof tiArgs.data['reject_reason']).toBe('string');
  });

  it('order filled 3 of 10 then expired: TradeIntent executed with quantity=3', async () => {
    const txClient = makeTxClient();
    const row = makeRow({ status: 'partially_filled', filled_qty: 3, filled_avg_price: 100 });
    const prisma = makePrisma({ findUniqueResult: row, txClient });
    const gateway = makeGateway({
      getOrderStatusResult: {
        broker_order_id: 'broker_order_1',
        client_order_id: row.client_order_id,
        status: 'expired',
        filled_qty: 3,
        filled_avg_price: 100,
        raw: {},
      },
    });
    const svc = makeService(prisma, gateway);

    await svc.reconcileOrder('ro_1');

    const roArgs = callArg<{ data: Record<string, unknown> }>(txClient.realOrder.updateMany);
    expect(roArgs.data['status']).toBe('expired');
    const tiArgs = callArg<{ data: Record<string, unknown> }>(txClient.tradeIntent.update);
    expect(tiArgs.data['status']).toBe('executed');
    expect(tiArgs.data['quantity']).toBe(3);
    expect(tiArgs.data['fill_price']).toBeCloseTo(100, 5);
  });
});

// ── fail-soft lookup error ───────────────────────────────────────────────────

describe('RealBrokerReconciliationService.reconcileOrder — broker lookup throws', () => {
  it('fail-soft: no status change, last_reconciled_at is set, never throws', async () => {
    const row = makeRow({ status: 'submitted' });
    const prisma = makePrisma({ findUniqueResult: row });
    const gateway = makeGateway({ getOrderStatusThrows: new Error('network timeout') });
    const svc = makeService(prisma, gateway);

    await expect(svc.reconcileOrder('ro_1')).resolves.toBeUndefined();

    expect(prisma.$transaction).not.toHaveBeenCalled();
    const updateCalls = (prisma.realOrder.update as jest.Mock).mock.calls as unknown[][];
    expect(updateCalls).toHaveLength(1);
    const updateArgs = updateCalls[0][0] as { data: Record<string, unknown> };
    expect(updateArgs.data['status']).toBeUndefined();
    expect(updateArgs.data['last_reconciled_at']).toBeInstanceOf(Date);
  });
});

// ── confirmed 404 (getOrderByClientId → null) ────────────────────────────────

describe('RealBrokerReconciliationService.reconcileOrder — getOrderByClientId returns null', () => {
  it('does not fabricate a fill; RealOrder status left unchanged', async () => {
    const row = makeRow({ status: 'pending_submit', broker_order_id: null });
    const prisma = makePrisma({ findUniqueResult: row });
    const gateway = makeGateway({ getOrderByClientIdResult: null });
    const svc = makeService(prisma, gateway);

    await svc.reconcileOrder('ro_1');

    expect(prisma.$transaction).not.toHaveBeenCalled();
    const updateCalls = (prisma.realOrder.update as jest.Mock).mock.calls as unknown[][];
    if (updateCalls.length > 0) {
      const updateArgs = updateCalls[0][0] as { data: Record<string, unknown> };
      expect(updateArgs.data['status']).toBeUndefined();
    }
  });
});

// ── idempotent no-op on already-terminal row ─────────────────────────────────

describe('RealBrokerReconciliationService.reconcileOrder — already terminal', () => {
  it('is a no-op for an already-filled row (idempotent re-reconcile)', async () => {
    const row = makeRow({ status: 'filled' });
    const prisma = makePrisma({ findUniqueResult: row });
    const gateway = makeGateway();
    const svc = makeService(prisma, gateway);

    await svc.reconcileOrder('ro_1');

    expect(gateway.getOrderStatus).not.toHaveBeenCalled();
    expect(gateway.getOrderByClientId).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect((prisma.realOrder.update as jest.Mock).mock.calls).toHaveLength(0);
  });
});

// ── numeric sanity guard ─────────────────────────────────────────────────────

describe('RealBrokerReconciliationService.reconcileOrder — numeric sanity guard', () => {
  it('broker says filled but filled_avg_price is 0 → NOT treated as a valid fill', async () => {
    const row = makeRow({ status: 'submitted' });
    const prisma = makePrisma({ findUniqueResult: row });
    const gateway = makeGateway({
      getOrderStatusResult: {
        broker_order_id: 'broker_order_1',
        client_order_id: row.client_order_id,
        status: 'filled',
        filled_qty: 10,
        filled_avg_price: 0,
        raw: {},
      },
    });
    const svc = makeService(prisma, gateway);

    await svc.reconcileOrder('ro_1');

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('broker says filled but filled_qty is negative → NOT treated as a valid fill', async () => {
    const row = makeRow({ status: 'submitted' });
    const prisma = makePrisma({ findUniqueResult: row });
    const gateway = makeGateway({
      getOrderStatusResult: {
        broker_order_id: 'broker_order_1',
        client_order_id: row.client_order_id,
        status: 'filled',
        filled_qty: -1,
        filled_avg_price: 100,
        raw: {},
      },
    });
    const svc = makeService(prisma, gateway);

    await svc.reconcileOrder('ro_1');

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('broker says filled but filled_avg_price is NaN → NOT treated as a valid fill', async () => {
    const row = makeRow({ status: 'submitted' });
    const prisma = makePrisma({ findUniqueResult: row });
    const gateway = makeGateway({
      getOrderStatusResult: {
        broker_order_id: 'broker_order_1',
        client_order_id: row.client_order_id,
        status: 'filled',
        filled_qty: 10,
        filled_avg_price: NaN,
        raw: {},
      },
    });
    const svc = makeService(prisma, gateway);

    await svc.reconcileOrder('ro_1');

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

// ── optimistic concurrency guard (Fix 3) ─────────────────────────────────────

describe('RealBrokerReconciliationService.reconcileOrder — optimistic concurrency guard (Fix 3)', () => {
  it('a stale partially_filled write is rejected (not applied) when the row already moved past the status this call read', async () => {
    const row = makeRow({ status: 'submitted' });
    const prisma = makePrisma({ findUniqueResult: row });
    // Simulate a concurrent writer (e.g. a fastPoll tick) already advanced this row
    // to "filled" between our findUnique() read and this write — the compare-and-set
    // WHERE { id, status: row.status } no longer matches, so updateMany reports count 0.
    (prisma.realOrder.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
    const gateway = makeGateway({
      getOrderStatusResult: {
        broker_order_id: 'broker_order_1',
        client_order_id: row.client_order_id,
        status: 'partially_filled',
        filled_qty: 4,
        filled_avg_price: 149.9,
        raw: {},
      },
    });
    const svc = makeService(prisma, gateway);

    await expect(svc.reconcileOrder('ro_1')).resolves.toBeUndefined();

    const updateManyCalls = (prisma.realOrder.updateMany as jest.Mock).mock.calls as unknown[][];
    expect(updateManyCalls).toHaveLength(1);
    const updateManyArgs = updateManyCalls[0][0] as {
      where: { id: string; status: string };
      data: Record<string, unknown>;
    };
    expect(updateManyArgs.where).toEqual({ id: 'ro_1', status: 'submitted' });
    expect(updateManyArgs.data['status']).toBe('partially_filled');
    // The already-more-advanced (filled) status is NOT downgraded, and TradeIntent is
    // never touched by a rejected stale write.
    expect((prisma.tradeIntent.update as jest.Mock).mock.calls).toHaveLength(0);
  });

  it('a stale terminal ($transaction) write is rejected — TradeIntent is not updated when the compare-and-set misses', async () => {
    const txClient = makeTxClient();
    txClient.realOrder.updateMany.mockResolvedValue({ count: 0 });
    const row = makeRow({ status: 'submitted' });
    const prisma = makePrisma({ findUniqueResult: row, txClient });
    const gateway = makeGateway({
      getOrderStatusResult: {
        broker_order_id: 'broker_order_1',
        client_order_id: row.client_order_id,
        status: 'filled',
        filled_qty: 10,
        filled_avg_price: 150.5,
        raw: {},
      },
    });
    const svc = makeService(prisma, gateway);

    await expect(svc.reconcileOrder('ro_1')).resolves.toBeUndefined();

    expect(txClient.realOrder.updateMany).toHaveBeenCalledWith({
      where: { id: 'ro_1', status: 'submitted' },
      data: expect.objectContaining({ status: 'filled' }) as unknown,
    });
    // The stale filled write was rejected by the CAS guard — TradeIntent must not be
    // updated either, otherwise the ledger desyncs the other way (TradeIntent executed
    // while RealOrder was NOT actually moved by this write).
    expect(txClient.tradeIntent.update).not.toHaveBeenCalled();
  });
});

// ── broker_order_id backfill on the open/non-terminal path (Fix 4) ──────────

describe('RealBrokerReconciliationService.reconcileOrder — broker_order_id backfill (Fix 4)', () => {
  it('a client-id-looked-up order (broker_order_id was null) gets its broker_order_id persisted even on the open/non-terminal branch', async () => {
    const row = makeRow({ status: 'pending_submit', broker_order_id: null });
    const prisma = makePrisma({ findUniqueResult: row });
    const gateway = makeGateway({
      getOrderByClientIdResult: {
        broker_order_id: 'broker_order_backfilled',
        client_order_id: row.client_order_id,
        status: 'new',
        filled_qty: 0,
        filled_avg_price: null,
        raw: {},
      },
    });
    const svc = makeService(prisma, gateway);

    await svc.reconcileOrder('ro_1');

    expect(gateway.getOrderByClientId).toHaveBeenCalledWith('alpaca', row.client_order_id);
    const updateCalls = (prisma.realOrder.update as jest.Mock).mock.calls as unknown[][];
    expect(updateCalls.length).toBeGreaterThan(0);
    const updateArgs = updateCalls[0][0] as { data: Record<string, unknown> };
    expect(updateArgs.data['broker_order_id']).toBe('broker_order_backfilled');
    expect(updateArgs.data['last_reconciled_at']).toBeInstanceOf(Date);
  });

  it('does not overwrite broker_order_id when the row already has one', async () => {
    const row = makeRow({ status: 'submitted', broker_order_id: 'broker_order_1' });
    const prisma = makePrisma({ findUniqueResult: row });
    const gateway = makeGateway({
      getOrderStatusResult: {
        broker_order_id: 'broker_order_1',
        client_order_id: row.client_order_id,
        status: 'new',
        filled_qty: 0,
        filled_avg_price: null,
        raw: {},
      },
    });
    const svc = makeService(prisma, gateway);

    await svc.reconcileOrder('ro_1');

    const updateCalls = (prisma.realOrder.update as jest.Mock).mock.calls as unknown[][];
    const updateArgs = updateCalls[0][0] as { data: Record<string, unknown> };
    expect(updateArgs.data['broker_order_id']).toBeUndefined();
  });
});

// ── fastPollOrder ────────────────────────────────────────────────────────────

describe('RealBrokerReconciliationService.fastPollOrder', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('polls at 2s/4s/8s/16s and stops early once the RealOrder reaches a terminal status', async () => {
    const prisma = makePrisma();
    const gateway = makeGateway();
    const svc = makeService(prisma, gateway);
    const reconcileSpy = jest.spyOn(svc, 'reconcileOrder').mockResolvedValue(undefined);
    const statusPerCall = ['submitted', 'submitted', 'filled'];
    let call = 0;
    (prisma.realOrder.findUnique as jest.Mock).mockImplementation(() =>
      Promise.resolve(
        makeRow({ status: statusPerCall[Math.min(call++, statusPerCall.length - 1)] }),
      ),
    );

    const pending = svc.fastPollOrder('ro_1');

    await jest.advanceTimersByTimeAsync(2_000);
    expect(reconcileSpy).toHaveBeenCalledTimes(1);
    expect(reconcileSpy).toHaveBeenNthCalledWith(1, 'ro_1');

    await jest.advanceTimersByTimeAsync(4_000);
    expect(reconcileSpy).toHaveBeenCalledTimes(2);

    // 3rd poll (after the 8s wait) observes status="filled" → loop stops early, never
    // waits the final 16s.
    await jest.advanceTimersByTimeAsync(8_000);
    expect(reconcileSpy).toHaveBeenCalledTimes(3);

    await jest.advanceTimersByTimeAsync(16_000);
    expect(reconcileSpy).toHaveBeenCalledTimes(3);

    await pending;
  });

  it('gives up silently after the ~30s window if the order never reaches a terminal status', async () => {
    const prisma = makePrisma();
    const gateway = makeGateway();
    const svc = makeService(prisma, gateway);
    const reconcileSpy = jest.spyOn(svc, 'reconcileOrder').mockResolvedValue(undefined);
    (prisma.realOrder.findUnique as jest.Mock).mockResolvedValue(makeRow({ status: 'submitted' }));

    const pending = svc.fastPollOrder('ro_1');

    await jest.advanceTimersByTimeAsync(2_000 + 4_000 + 8_000 + 16_000);
    await expect(pending).resolves.toBeUndefined();

    expect(reconcileSpy).toHaveBeenCalledTimes(4);
  });

  it('never throws even if reconcileOrder rejects on every attempt', async () => {
    const prisma = makePrisma();
    const gateway = makeGateway();
    const svc = makeService(prisma, gateway);
    const reconcileSpy = jest
      .spyOn(svc, 'reconcileOrder')
      .mockRejectedValue(new Error('broker unreachable'));
    (prisma.realOrder.findUnique as jest.Mock).mockResolvedValue(makeRow({ status: 'submitted' }));

    const pending = svc.fastPollOrder('ro_1');

    await jest.advanceTimersByTimeAsync(2_000 + 4_000 + 8_000 + 16_000);
    await expect(pending).resolves.toBeUndefined();

    expect(reconcileSpy).toHaveBeenCalledTimes(4);
  });
});

// ── reconcileAllOpenOrders ───────────────────────────────────────────────────

describe('RealBrokerReconciliationService.reconcileAllOpenOrders', () => {
  it('queries RealOrder rows with status in {submitted, accepted, partially_filled} and reconciles each', async () => {
    const prisma = makePrisma();
    const gateway = makeGateway();
    prisma._realOrderFindMany.mockResolvedValue([{ id: 'ro_1' }, { id: 'ro_2' }]);
    const svc = makeService(prisma, gateway);
    const reconcileSpy = jest.spyOn(svc, 'reconcileOrder').mockResolvedValue(undefined);

    await svc.reconcileAllOpenOrders();

    expect(prisma._realOrderFindMany).toHaveBeenCalledWith({
      where: { status: { in: ['submitted', 'accepted', 'partially_filled'] } },
    });
    expect(reconcileSpy).toHaveBeenCalledTimes(2);
    expect(reconcileSpy).toHaveBeenNthCalledWith(1, 'ro_1');
    expect(reconcileSpy).toHaveBeenNthCalledWith(2, 'ro_2');
  });

  it("one order's reconcileOrder throwing does not prevent the others from being processed", async () => {
    const prisma = makePrisma();
    const gateway = makeGateway();
    prisma._realOrderFindMany.mockResolvedValue([{ id: 'ro_1' }, { id: 'ro_2' }]);
    const svc = makeService(prisma, gateway);
    const reconcileSpy = jest
      .spyOn(svc, 'reconcileOrder')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);

    await expect(svc.reconcileAllOpenOrders()).resolves.toBeUndefined();

    expect(reconcileSpy).toHaveBeenCalledTimes(2);
  });
});

// ── Fix 1 — steady-state sweep of pending_submit/submit_failed rows ─────────

describe('RealBrokerReconciliationService.reconcileAllOpenOrders — Fix 1: in-flight sweep', () => {
  it('calls realOrderService.recoverInflight() before querying OPEN_STATUSES rows, every tick — not just at boot', async () => {
    const prisma = makePrisma();
    const gateway = makeGateway();
    const realOrderService = makeRealOrderService();
    const callOrder: string[] = [];
    realOrderService.recoverInflight.mockImplementation(() => {
      callOrder.push('recoverInflight');
      return Promise.resolve();
    });
    prisma._realOrderFindMany.mockImplementation(() => {
      callOrder.push('findMany');
      return Promise.resolve([]);
    });
    const svc = makeService(prisma, gateway, undefined, undefined, realOrderService);

    await svc.reconcileAllOpenOrders();

    expect(realOrderService.recoverInflight).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['recoverInflight', 'findMany']);
  });

  it('recoverInflight throwing does not prevent the OPEN_STATUSES sweep from still running (fail-soft)', async () => {
    const prisma = makePrisma();
    const gateway = makeGateway();
    prisma._realOrderFindMany.mockResolvedValue([{ id: 'ro_1' }]);
    const realOrderService = makeRealOrderService();
    realOrderService.recoverInflight.mockRejectedValue(new Error('sweep blew up'));
    const svc = makeService(prisma, gateway, undefined, undefined, realOrderService);
    const reconcileSpy = jest.spyOn(svc, 'reconcileOrder').mockResolvedValue(undefined);

    await expect(svc.reconcileAllOpenOrders()).resolves.toBeUndefined();

    expect(reconcileSpy).toHaveBeenCalledTimes(1);
  });
});

// ── Shared in-flight-sweep test fixtures (Fix 1 + Fix 3) ────────────────────
//
// Minimal stateful in-memory RealOrder/TradeIntent store, shared by the Fix 1
// end-to-end and Fix 3 boot-order-independence test blocks below — both need
// a real RealOrderService + real RealBrokerReconciliationService wired
// together against the SAME mutable backing store (not independently mocked
// return values), since these tests assert on state written by ONE service
// and observed by the OTHER.

type SharedRow = {
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

function makeSharedStore(initialRows: SharedRow[]) {
  const rows = new Map<string, SharedRow>(initialRows.map((r) => [r.id, r]));
  const tradeIntents = new Map<string, Record<string, unknown>>();

  const applyRealOrderUpdate = (id: string, data: Partial<SharedRow>) => {
    const existing = rows.get(id);
    if (!existing) return;
    rows.set(id, { ...existing, ...data });
  };

  type SharedDb = {
    realOrder: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    tradeIntent: { update: jest.Mock };
    $transaction: jest.Mock;
  };

  const db: SharedDb = {
    realOrder: {
      findMany: jest.fn((args: { where: { status: { in: string[] } } }) =>
        Promise.resolve([...rows.values()].filter((r) => args.where.status.in.includes(r.status))),
      ),
      findUnique: jest.fn((args: { where: { id: string } }) =>
        Promise.resolve(rows.get(args.where.id) ?? null),
      ),
      update: jest.fn((args: { where: { id: string }; data: Partial<SharedRow> }) => {
        applyRealOrderUpdate(args.where.id, args.data);
        return Promise.resolve(rows.get(args.where.id));
      }),
      updateMany: jest.fn(
        (args: { where: { id: string; status: string }; data: Partial<SharedRow> }) => {
          const existing = rows.get(args.where.id);
          if (!existing || existing.status !== args.where.status) {
            return Promise.resolve({ count: 0 });
          }
          applyRealOrderUpdate(args.where.id, args.data);
          return Promise.resolve({ count: 1 });
        },
      ),
    },
    tradeIntent: {
      update: jest.fn((args: { where: { id: string }; data: Record<string, unknown> }) => {
        const existing = tradeIntents.get(args.where.id) ?? {};
        tradeIntents.set(args.where.id, { ...existing, ...args.data });
        return Promise.resolve(tradeIntents.get(args.where.id));
      }),
    },
    $transaction: jest.fn(async (fn: (tx: SharedDb) => Promise<void>) => await fn(db)),
  };

  return { db, rows, tradeIntents };
}

function makeStuckRow(overrides: Partial<SharedRow> = {}): SharedRow {
  return {
    id: 'ro_stuck',
    trade_intent_id: 'ti_stuck',
    broker_plugin_id: 'alpaca',
    client_order_id: 'nt-ti_stuck-abc12345',
    broker_order_id: null,
    symbol: 'AAPL',
    side: 'buy',
    order_type: 'market',
    requested_qty: 10,
    limit_price: null,
    status: 'submit_failed',
    filled_qty: 0,
    filled_avg_price: null,
    submitted_at: null,
    filled_at: null,
    last_reconciled_at: null,
    broker_raw_json: null,
    error: 'network timeout on original submit',
    ...overrides,
  };
}

describe('RealBrokerReconciliationService — Fix 1: end-to-end self-heal without a restart', () => {
  it('a submit_failed row the broker actually HAS self-heals to a filled TradeIntent via a steady tick alone — no restart, no blind resubmit', async () => {
    const stuck = makeStuckRow();
    const { db, rows, tradeIntents } = makeSharedStore([stuck]);

    const placeOrder = jest.fn().mockResolvedValue({ id: 'should-never-be-called' });
    const getOrderByClientId = jest.fn().mockResolvedValue({
      broker_order_id: 'broker_order_recovered',
      client_order_id: stuck.client_order_id,
      status: 'filled',
      filled_qty: 10,
      filled_avg_price: 150.5,
      raw: {},
    });
    const getOrderStatus = jest.fn().mockResolvedValue({
      broker_order_id: 'broker_order_recovered',
      client_order_id: stuck.client_order_id,
      status: 'filled',
      filled_qty: 10,
      filled_avg_price: 150.5,
      raw: {},
    });
    const gateway = { placeOrder, getOrderByClientId, getOrderStatus };

    const realOrderService = new RealOrderService(
      db as unknown as PrismaService,
      gateway as unknown as ProviderGatewayService,
      makeKv() as unknown as KvService,
    );
    const svc = new RealBrokerReconciliationService(
      db as unknown as PrismaService,
      gateway as unknown as ProviderGatewayService,
      makeKv() as unknown as KvService,
      makeAlerts() as unknown as AlertsService,
      realOrderService,
    );

    // Called directly — proves this is the STEADY-STATE tick path, not onModuleInit.
    await svc.reconcileAllOpenOrders();
    // recoverInflight() only downgrades the row within the same call; the fill itself
    // is recorded on the SAME or a subsequent reconcile call (per the task spec) —
    // running the sweep twice models "this tick, or the next" without waiting on timers.
    await svc.reconcileAllOpenOrders();

    expect(placeOrder).not.toHaveBeenCalled();
    expect(rows.get('ro_stuck')?.broker_order_id).toBe('broker_order_recovered');
    expect(rows.get('ro_stuck')?.status).toBe('filled');
    expect(tradeIntents.get('ti_stuck')?.['status']).toBe('executed');
    expect(tradeIntents.get('ti_stuck')?.['fill_price']).toBeCloseTo(150.5, 5);
    expect(tradeIntents.get('ti_stuck')?.['quantity']).toBe(10);
  });

  it('a submit_failed row the broker never received (404) is left untouched by the tick, and placeOrder is NEVER called (no blind resubmit)', async () => {
    const stuck = makeStuckRow({ id: 'ro_404', trade_intent_id: 'ti_404' });
    const { db, rows } = makeSharedStore([stuck]);

    const placeOrder = jest.fn().mockResolvedValue({ id: 'should-never-be-called' });
    const getOrderByClientId = jest.fn().mockResolvedValue(null);
    const getOrderStatus = jest.fn().mockResolvedValue(null);
    const gateway = { placeOrder, getOrderByClientId, getOrderStatus };

    const realOrderService = new RealOrderService(
      db as unknown as PrismaService,
      gateway as unknown as ProviderGatewayService,
      makeKv() as unknown as KvService,
    );
    const svc = new RealBrokerReconciliationService(
      db as unknown as PrismaService,
      gateway as unknown as ProviderGatewayService,
      makeKv() as unknown as KvService,
      makeAlerts() as unknown as AlertsService,
      realOrderService,
    );

    await svc.reconcileAllOpenOrders();

    expect(placeOrder).not.toHaveBeenCalled();
    expect(rows.get('ro_404')?.status).toBe('submit_failed');
    expect(rows.get('ro_404')?.broker_order_id).toBeNull();
  });
});

describe('RealBrokerReconciliationService — Fix 3: boot-order independence', () => {
  it('a stuck submit_failed row is still recovered by the steady-state tick alone, even though RealOrderService.onModuleInit (boot recovery) NEVER ran', async () => {
    const stuck = makeStuckRow({ id: 'ro_stuck3', trade_intent_id: 'ti_stuck3' });
    const { db, rows, tradeIntents } = makeSharedStore([stuck]);

    const placeOrder = jest.fn().mockResolvedValue({ id: 'should-never-be-called' });
    const getOrderByClientId = jest.fn().mockResolvedValue({
      broker_order_id: 'broker_order_recovered_3',
      client_order_id: stuck.client_order_id,
      status: 'filled',
      filled_qty: 10,
      filled_avg_price: 200,
      raw: {},
    });
    const getOrderStatus = jest.fn().mockResolvedValue({
      broker_order_id: 'broker_order_recovered_3',
      client_order_id: stuck.client_order_id,
      status: 'filled',
      filled_qty: 10,
      filled_avg_price: 200,
      raw: {},
    });
    const gateway = { placeOrder, getOrderByClientId, getOrderStatus };

    const realOrderService = new RealOrderService(
      db as unknown as PrismaService,
      gateway as unknown as ProviderGatewayService,
      makeKv() as unknown as KvService,
    );
    const onModuleInitSpy = jest.spyOn(realOrderService, 'onModuleInit');
    const recoverInflightSpy = jest.spyOn(realOrderService, 'recoverInflight');

    const svc = new RealBrokerReconciliationService(
      db as unknown as PrismaService,
      gateway as unknown as ProviderGatewayService,
      makeKv() as unknown as KvService,
      makeAlerts() as unknown as AlertsService,
      realOrderService,
    );

    // RealOrderService.onModuleInit is deliberately NEVER called in this test — this
    // simulates the reconciliation tick running before (or entirely without) boot
    // recovery having had any chance to run.
    await svc.reconcileAllOpenOrders();
    await svc.reconcileAllOpenOrders();

    expect(onModuleInitSpy).not.toHaveBeenCalled();
    // recoverInflight WAS still exercised — via the tick's own sweep, not boot.
    expect(recoverInflightSpy).toHaveBeenCalled();
    expect(placeOrder).not.toHaveBeenCalled();
    expect(rows.get('ro_stuck3')?.status).toBe('filled');
    expect(tradeIntents.get('ti_stuck3')?.['status']).toBe('executed');
    expect(tradeIntents.get('ti_stuck3')?.['quantity']).toBe(10);
  });
});

// ── steady-state loop: onModuleInit / onModuleDestroy / overlap guard / circuit breaker ──

describe('RealBrokerReconciliationService — steady-state loop', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('onModuleInit runs one reconcileAllOpenOrders immediately, then schedules a KV-configured interval', async () => {
    const prisma = makePrisma();
    const gateway = makeGateway();
    const kv = makeKv({ 'execution.real_reconciliation_interval_ms': '20000' });
    const svc = makeService(prisma, gateway, kv);
    const reconcileAllSpy = jest.spyOn(svc, 'reconcileAllOpenOrders').mockResolvedValue(undefined);

    await svc.onModuleInit();
    expect(reconcileAllSpy).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(20_000);
    expect(reconcileAllSpy).toHaveBeenCalledTimes(2);

    svc.onModuleDestroy();
  });

  it('clamps a too-small KV interval to a minimum of 5000ms', async () => {
    const prisma = makePrisma();
    const gateway = makeGateway();
    const kv = makeKv({ 'execution.real_reconciliation_interval_ms': '100' });
    const svc = makeService(prisma, gateway, kv);
    const reconcileAllSpy = jest.spyOn(svc, 'reconcileAllOpenOrders').mockResolvedValue(undefined);

    await svc.onModuleInit();
    expect(reconcileAllSpy).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(5_000);
    expect(reconcileAllSpy).toHaveBeenCalledTimes(2);

    svc.onModuleDestroy();
  });

  it('overlap guard: a still-running tick is not started again when the timer fires again', async () => {
    const prisma = makePrisma();
    const gateway = makeGateway();
    const kv = makeKv({ 'execution.real_reconciliation_interval_ms': '5000' });
    const svc = makeService(prisma, gateway, kv);

    let resolveSlowTick: () => void = () => undefined;
    const slowTick = new Promise<void>((resolve) => {
      resolveSlowTick = resolve;
    });
    const reconcileAllSpy = jest
      .spyOn(svc, 'reconcileAllOpenOrders')
      .mockResolvedValueOnce(undefined) // initial onModuleInit tick — resolves immediately
      .mockImplementationOnce(() => slowTick) // first interval-triggered tick — stays pending
      .mockResolvedValue(undefined);

    await svc.onModuleInit();
    expect(reconcileAllSpy).toHaveBeenCalledTimes(1);

    // First interval fire starts the slow tick.
    await jest.advanceTimersByTimeAsync(5_000);
    expect(reconcileAllSpy).toHaveBeenCalledTimes(2);

    // Timer fires again while that tick is still pending — overlap guard must skip it.
    await jest.advanceTimersByTimeAsync(5_000);
    expect(reconcileAllSpy).toHaveBeenCalledTimes(2);

    resolveSlowTick();
    await Promise.resolve();
    await Promise.resolve();

    await jest.advanceTimersByTimeAsync(5_000);
    expect(reconcileAllSpy).toHaveBeenCalledTimes(3);

    svc.onModuleDestroy();
  });

  it('circuit breaker trips after 3 consecutive tick failures, pauses further attempts within the cooldown, persists to KV, and emits a CRITICAL RECONCILIATION_HALTED alert (Fix 2)', async () => {
    const prisma = makePrisma();
    const gateway = makeGateway();
    const kv = makeKv({ 'execution.real_reconciliation_interval_ms': '5000' });
    const alerts = makeAlerts();
    const svc = makeService(prisma, gateway, kv, alerts);
    const reconcileAllSpy = jest
      .spyOn(svc, 'reconcileAllOpenOrders')
      .mockRejectedValue(new Error('db unreachable'));

    await svc.onModuleInit();
    expect(reconcileAllSpy).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(5_000);
    expect(reconcileAllSpy).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(5_000);
    expect(reconcileAllSpy).toHaveBeenCalledTimes(3);

    // Breaker is now open — no further attempts within the half-open cooldown window.
    await jest.advanceTimersByTimeAsync(5_000);
    expect(reconcileAllSpy).toHaveBeenCalledTimes(3);

    // Persisted to KV, not just held in memory.
    const cb = await svc.getCircuitBreaker();
    expect(cb.state).toBe('open');
    expect(cb.consecutive_failures).toBe(3);
    expect(kv.set).toHaveBeenCalled();

    // A CRITICAL AlertEntry was emitted on the trip — this must be visible to an
    // operator, not just a silent permanent halt.
    expect(alerts.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'RECONCILIATION_HALTED',
        severity: 'CRITICAL',
      }) as unknown,
    );

    svc.onModuleDestroy();
  });

  it('half-open retry: after the cooldown elapses, the next tick attempts again; a success closes the breaker and resumes the loop', async () => {
    const prisma = makePrisma();
    const gateway = makeGateway();
    const kv = makeKv({ 'execution.real_reconciliation_interval_ms': '60000' });
    const svc = makeService(prisma, gateway, kv);
    const reconcileAllSpy = jest
      .spyOn(svc, 'reconcileAllOpenOrders')
      .mockRejectedValueOnce(new Error('fail 1')) // onModuleInit tick
      .mockRejectedValueOnce(new Error('fail 2')) // interval tick 1 (60s)
      .mockRejectedValueOnce(new Error('fail 3')) // interval tick 2 (120s) — trips breaker
      .mockResolvedValue(undefined); // half-open probe succeeds

    await svc.onModuleInit();
    await jest.advanceTimersByTimeAsync(60_000);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(reconcileAllSpy).toHaveBeenCalledTimes(3);
    expect((await svc.getCircuitBreaker()).state).toBe('open');

    // Still within the cooldown — the next scheduled tick must be skipped, not attempted.
    await jest.advanceTimersByTimeAsync(60_000);
    expect(reconcileAllSpy).toHaveBeenCalledTimes(3);

    // Advance to just past the half-open cooldown (5 min from the last failure at
    // t=120s, i.e. t=420s) — the tick at t=420s is a half-open probe attempt. Stop
    // exactly there (not past t=480s, the next interval tick) to isolate it.
    await jest.advanceTimersByTimeAsync(240_000);
    expect(reconcileAllSpy).toHaveBeenCalledTimes(4);

    const cb = await svc.getCircuitBreaker();
    expect(cb.state).toBe('closed');
    expect(cb.consecutive_failures).toBe(0);

    // Loop keeps running normally after recovery.
    await jest.advanceTimersByTimeAsync(60_000);
    expect(reconcileAllSpy).toHaveBeenCalledTimes(5);

    svc.onModuleDestroy();
  });

  it('onModuleDestroy clears the interval — no further calls happen afterwards', async () => {
    const prisma = makePrisma();
    const gateway = makeGateway();
    const kv = makeKv({ 'execution.real_reconciliation_interval_ms': '5000' });
    const svc = makeService(prisma, gateway, kv);
    const reconcileAllSpy = jest.spyOn(svc, 'reconcileAllOpenOrders').mockResolvedValue(undefined);

    await svc.onModuleInit();
    expect(reconcileAllSpy).toHaveBeenCalledTimes(1);

    svc.onModuleDestroy();

    await jest.advanceTimersByTimeAsync(5_000);
    expect(reconcileAllSpy).toHaveBeenCalledTimes(1);
  });

  it('circuit breaker trip ALSO trips the real-money kill-switch with the correct reason, alongside (not instead of) the RECONCILIATION_HALTED alert (R8)', async () => {
    const prisma = makePrisma();
    const gateway = makeGateway();
    const kv = makeKv({ 'execution.real_reconciliation_interval_ms': '5000' });
    const alerts = makeAlerts();
    const svc = makeService(prisma, gateway, kv, alerts);
    jest.spyOn(svc, 'reconcileAllOpenOrders').mockRejectedValue(new Error('db unreachable'));

    await svc.onModuleInit();
    await jest.advanceTimersByTimeAsync(5_000);
    await jest.advanceTimersByTimeAsync(5_000);

    expect(await kv.get('real_execution.halted')).toBe('true');
    expect(await kv.get('real_execution.halt_reason')).toContain(
      'reconciliation circuit breaker open',
    );
    // The existing alert is still emitted — the kill-switch is additive, not a replacement.
    expect(alerts.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'RECONCILIATION_HALTED', severity: 'CRITICAL' }) as unknown,
    );

    svc.onModuleDestroy();
  });

  it('no auto-clear: a subsequent healthy tick after a trip does NOT clear the kill-switch', async () => {
    const prisma = makePrisma();
    const gateway = makeGateway();
    const kv = makeKv({ 'execution.real_reconciliation_interval_ms': '5000' });
    const alerts = makeAlerts();
    const svc = makeService(prisma, gateway, kv, alerts);
    const reconcileAllSpy = jest
      .spyOn(svc, 'reconcileAllOpenOrders')
      .mockRejectedValueOnce(new Error('fail 1')) // onModuleInit tick
      .mockRejectedValueOnce(new Error('fail 2')) // interval tick 1
      .mockRejectedValueOnce(new Error('fail 3')) // interval tick 2 — trips breaker + kill-switch
      .mockResolvedValue(undefined); // half-open probe succeeds — a healthy cycle

    await svc.onModuleInit();
    await jest.advanceTimersByTimeAsync(5_000);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(await kv.get('real_execution.halted')).toBe('true');

    // Advance past the half-open cooldown — the breaker closes on a successful probe.
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect((await svc.getCircuitBreaker()).state).toBe('closed');
    expect(reconcileAllSpy).toHaveBeenCalled();

    // The kill-switch stays tripped — only an explicit clearRealExecutionHalt() call may
    // un-halt it, never a healthy cycle.
    expect(await kv.get('real_execution.halted')).toBe('true');

    svc.onModuleDestroy();
  });
});

// ── syncPortfolio / detectDrift ─────────────────────────────────────────────
//
// Slice 3: portfolio-level sync (full-replace RealPosition cache + monotonic
// RealNavSnapshot) and unexplained-position drift detection. Uses a dedicated
// prisma/tx mock builder (makePortfolioPrisma/makePortfolioTxClient) because
// this area of the service touches realPosition/realNavSnapshot delegates the
// order-reconciliation mocks above don't model.

type BrokerPosition = {
  symbol: string;
  qty: number;
  avg_entry: number;
  market_value: number;
  unrealized_pnl: number;
  side: 'long' | 'short';
};

type Portfolio = {
  provider_id: string;
  equity: number;
  cash: number;
  buying_power: number;
  positions: BrokerPosition[];
  total_market_value: number;
  total_pnl: number;
  ts: string;
};

function makeBrokerPosition(overrides: Partial<BrokerPosition> = {}): BrokerPosition {
  return {
    symbol: 'AAPL',
    qty: 10,
    avg_entry: 150,
    market_value: 1550,
    unrealized_pnl: 50,
    side: 'long',
    ...overrides,
  };
}

function makePortfolio(overrides: Partial<Portfolio> = {}): Portfolio {
  return {
    provider_id: 'alpaca',
    equity: 10000,
    cash: 5000,
    buying_power: 10000,
    positions: [],
    total_market_value: 0,
    total_pnl: 0,
    ts: new Date().toISOString(),
    ...overrides,
  };
}

type PortfolioTxClient = {
  realPosition: { deleteMany: jest.Mock; upsert: jest.Mock };
  realNavSnapshot: { findFirst: jest.Mock; create: jest.Mock };
};

function makePortfolioTxClient(opts?: {
  prevSnapshot?: { hwm: number } | null;
}): PortfolioTxClient {
  return {
    realPosition: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      upsert: jest.fn().mockResolvedValue(undefined),
    },
    realNavSnapshot: {
      findFirst: jest.fn().mockResolvedValue(opts?.prevSnapshot ?? null),
      create: jest.fn().mockResolvedValue(undefined),
    },
  };
}

function makePortfolioPrisma(opts?: {
  txClient?: PortfolioTxClient;
  realOrderFindFirstResult?: unknown;
}): jest.Mocked<Pick<PrismaService, 'realOrder' | '$transaction'>> & {
  _tx: PortfolioTxClient;
} {
  const txClient = opts?.txClient ?? makePortfolioTxClient();
  const realOrderFindFirstResult =
    opts && 'realOrderFindFirstResult' in opts
      ? opts.realOrderFindFirstResult
      : { id: 'ro_explained' };
  const realOrder = {
    findFirst: jest.fn().mockResolvedValue(realOrderFindFirstResult),
  };
  const $transaction = jest
    .fn()
    .mockImplementation(async (fn: (tx: PortfolioTxClient) => Promise<void>) => fn(txClient));

  return {
    realOrder,
    $transaction,
    _tx: txClient,
  } as unknown as jest.Mocked<Pick<PrismaService, 'realOrder' | '$transaction'>> & {
    _tx: PortfolioTxClient;
  };
}

function makePortfolioGateway(opts?: {
  getPortfolioResult?: Portfolio;
  getPortfolioThrows?: Error;
}): jest.Mocked<Pick<ProviderGatewayService, 'getPortfolio'>> {
  const getPortfolio = opts?.getPortfolioThrows
    ? jest.fn().mockRejectedValue(opts.getPortfolioThrows)
    : jest.fn().mockResolvedValue(opts?.getPortfolioResult ?? makePortfolio());
  return { getPortfolio };
}

function makePortfolioAlerts(opts?: {
  getActiveResult?: { type: string; symbol: string | null }[];
}): jest.Mocked<Pick<AlertsService, 'create' | 'getActive'>> {
  return {
    create: jest.fn().mockResolvedValue({ id: 'alert_1' }),
    getActive: jest.fn().mockResolvedValue(opts?.getActiveResult ?? []),
  };
}

/**
 * Reuses makeService's generic (unknown-cast) constructor wiring — the
 * portfolio-sync mocks (makePortfolioPrisma/makePortfolioGateway/
 * makePortfolioAlerts) have a different shape than the order-reconciliation
 * ones above, but makeService's signature is structural, not nominal, so it
 * accepts either.
 */
function makePortfolioService(
  prisma: ReturnType<typeof makePortfolioPrisma>,
  gateway: ReturnType<typeof makePortfolioGateway>,
  kv: ReturnType<typeof makeKv> = makeKv(),
  alerts: ReturnType<typeof makePortfolioAlerts> = makePortfolioAlerts(),
): RealBrokerReconciliationService {
  return makeService(
    prisma as unknown as ReturnType<typeof makePrisma>,
    gateway as unknown as ReturnType<typeof makeGateway>,
    kv,
    alerts,
  );
}

describe('RealBrokerReconciliationService.syncPortfolio — full-replace transaction', () => {
  it('broker returns {A,B}, cache has stale {C} → after sync cache is upserted to {A,B} and C is deleted, all inside ONE $transaction call', async () => {
    const txClient = makePortfolioTxClient();
    const prisma = makePortfolioPrisma({ txClient });
    const portfolio = makePortfolio({
      positions: [makeBrokerPosition({ symbol: 'A' }), makeBrokerPosition({ symbol: 'B' })],
    });
    const gateway = makePortfolioGateway({ getPortfolioResult: portfolio });
    const svc = makePortfolioService(prisma, gateway);

    await svc.syncPortfolio('alpaca', 'poll');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(txClient.realPosition.deleteMany).toHaveBeenCalledWith({
      where: { broker_plugin_id: 'alpaca', symbol: { notIn: ['A', 'B'] } },
    });
    expect(txClient.realPosition.upsert).toHaveBeenCalledTimes(2);
    const upsertSymbols = txClient.realPosition.upsert.mock.calls.map(
      (call: [{ where: { symbol: string } }]) => call[0].where.symbol,
    );
    expect(upsertSymbols).toEqual(['A', 'B']);
  });
});

describe('RealBrokerReconciliationService.syncPortfolio — monotonic HWM', () => {
  it('first sync (no prior snapshot) with equity 100 → hwm 100', async () => {
    const txClient = makePortfolioTxClient({ prevSnapshot: null });
    const prisma = makePortfolioPrisma({ txClient });
    const gateway = makePortfolioGateway({ getPortfolioResult: makePortfolio({ equity: 100 }) });
    const svc = makePortfolioService(prisma, gateway);

    await svc.syncPortfolio('alpaca', 'poll');

    const createArgs = callArg<{ data: { hwm: number; equity: number } }>(
      txClient.realNavSnapshot.create,
    );
    expect(createArgs.data.equity).toBeCloseTo(100);
    expect(createArgs.data.hwm).toBeCloseTo(100);
  });

  it('equity drops to 80 with prior hwm 100 → snapshot hwm stays 100 (never regresses)', async () => {
    const txClient = makePortfolioTxClient({ prevSnapshot: { hwm: 100 } });
    const prisma = makePortfolioPrisma({ txClient });
    const gateway = makePortfolioGateway({ getPortfolioResult: makePortfolio({ equity: 80 }) });
    const svc = makePortfolioService(prisma, gateway);

    await svc.syncPortfolio('alpaca', 'poll');

    const createArgs = callArg<{ data: { hwm: number; equity: number } }>(
      txClient.realNavSnapshot.create,
    );
    expect(createArgs.data.equity).toBeCloseTo(80);
    expect(createArgs.data.hwm).toBeCloseTo(100);
  });

  it('equity rises to 120 with prior hwm 100 → snapshot hwm advances to 120', async () => {
    const txClient = makePortfolioTxClient({ prevSnapshot: { hwm: 100 } });
    const prisma = makePortfolioPrisma({ txClient });
    const gateway = makePortfolioGateway({ getPortfolioResult: makePortfolio({ equity: 120 }) });
    const svc = makePortfolioService(prisma, gateway);

    await svc.syncPortfolio('alpaca', 'poll');

    const createArgs = callArg<{ data: { hwm: number; equity: number } }>(
      txClient.realNavSnapshot.create,
    );
    expect(createArgs.data.equity).toBeCloseTo(120);
    expect(createArgs.data.hwm).toBeCloseTo(120);
  });
});

describe('RealBrokerReconciliationService.syncPortfolio — fail-soft on broker error', () => {
  it('getPortfolio throws → no RealPosition/RealNavSnapshot writes, no exception escapes', async () => {
    const txClient = makePortfolioTxClient();
    const prisma = makePortfolioPrisma({ txClient });
    const gateway = makePortfolioGateway({ getPortfolioThrows: new Error('broker down') });
    const svc = makePortfolioService(prisma, gateway);

    const result = await svc.syncPortfolio('alpaca', 'poll');

    expect(result).toEqual({ driftedSymbols: [] });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(txClient.realPosition.upsert).not.toHaveBeenCalled();
    expect(txClient.realPosition.deleteMany).not.toHaveBeenCalled();
    expect(txClient.realNavSnapshot.create).not.toHaveBeenCalled();
  });
});

describe('RealBrokerReconciliationService.detectDrift', () => {
  it('broker position with no filled/partially_filled RealOrder history → CRITICAL BROKER_DRIFT alert with symbol+qty, RealPosition cache still updated', async () => {
    const txClient = makePortfolioTxClient();
    const prisma = makePortfolioPrisma({ txClient, realOrderFindFirstResult: null });
    const portfolio = makePortfolio({
      positions: [makeBrokerPosition({ symbol: 'X', qty: 7 })],
    });
    const gateway = makePortfolioGateway({ getPortfolioResult: portfolio });
    const alerts = makePortfolioAlerts();
    const svc = makePortfolioService(prisma, gateway, makeKv(), alerts);

    const result = await svc.syncPortfolio('alpaca', 'poll');

    expect(result.driftedSymbols).toEqual(['X']);
    expect(alerts.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'BROKER_DRIFT',
        severity: 'CRITICAL',
        symbol: 'X',
        message: expect.stringContaining('7') as unknown,
      }) as unknown,
    );
    // Cache still updated to broker truth regardless of drift.
    expect(txClient.realPosition.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { symbol: 'X' } }) as unknown,
    );
  });

  it('Fix 2: the explained-position query filters by filled_qty > 0, not by a fixed status list', async () => {
    const txClient = makePortfolioTxClient();
    const prisma = makePortfolioPrisma({ txClient, realOrderFindFirstResult: { id: 'ro_1' } });
    const portfolio = makePortfolio({ positions: [makeBrokerPosition({ symbol: 'Y' })] });
    const gateway = makePortfolioGateway({ getPortfolioResult: portfolio });
    const svc = makePortfolioService(prisma, gateway);

    await svc.syncPortfolio('alpaca', 'poll');

    const findFirstCalls = (prisma.realOrder.findFirst as jest.Mock).mock.calls as unknown[][];
    expect(findFirstCalls.length).toBeGreaterThan(0);
    const args = findFirstCalls[0][0] as { where: Record<string, unknown> };
    expect(args.where['status']).toBeUndefined();
    expect(args.where['filled_qty']).toEqual(expect.objectContaining({ gt: 0 }) as unknown);
  });

  it('an explained position (filled RealOrder exists for the symbol) is never flagged as drift', async () => {
    const txClient = makePortfolioTxClient();
    const prisma = makePortfolioPrisma({ txClient, realOrderFindFirstResult: { id: 'ro_1' } });
    const portfolio = makePortfolio({ positions: [makeBrokerPosition({ symbol: 'Y' })] });
    const gateway = makePortfolioGateway({ getPortfolioResult: portfolio });
    const alerts = makePortfolioAlerts();
    const svc = makePortfolioService(prisma, gateway, makeKv(), alerts);

    const result = await svc.syncPortfolio('alpaca', 'poll');

    expect(result.driftedSymbols).toEqual([]);
    expect(alerts.create).not.toHaveBeenCalled();
  });

  it('re-running sync with the same still-open drift does NOT create a duplicate alert', async () => {
    const txClient = makePortfolioTxClient();
    const prisma = makePortfolioPrisma({ txClient, realOrderFindFirstResult: null });
    const portfolio = makePortfolio({ positions: [makeBrokerPosition({ symbol: 'X' })] });
    const gateway = makePortfolioGateway({ getPortfolioResult: portfolio });
    // Simulates the alert already existing/unresolved from a prior sync.
    const alerts = makePortfolioAlerts({
      getActiveResult: [{ type: 'BROKER_DRIFT', symbol: 'X' }],
    });
    const svc = makePortfolioService(prisma, gateway, makeKv(), alerts);

    const result = await svc.syncPortfolio('alpaca', 'poll');

    expect(result.driftedSymbols).toEqual(['X']);
    expect(alerts.create).not.toHaveBeenCalled();
  });

  it('a drifted symbol ALSO trips the real-money kill-switch with the correct reason, alongside (not instead of) the BROKER_DRIFT alert (R8)', async () => {
    const txClient = makePortfolioTxClient();
    const prisma = makePortfolioPrisma({ txClient, realOrderFindFirstResult: null });
    const portfolio = makePortfolio({ positions: [makeBrokerPosition({ symbol: 'X' })] });
    const gateway = makePortfolioGateway({ getPortfolioResult: portfolio });
    const alerts = makePortfolioAlerts();
    const kv = makeKv();
    const svc = makePortfolioService(prisma, gateway, kv, alerts);

    await svc.syncPortfolio('alpaca', 'poll');

    expect(await kv.get('real_execution.halted')).toBe('true');
    expect(await kv.get('real_execution.halt_reason')).toContain('broker position drift detected');
    expect(alerts.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'BROKER_DRIFT', severity: 'CRITICAL' }) as unknown,
    );
  });

  it('Fix 2: a canceled-but-partially-filled RealOrder still explains the position — no false-positive BROKER_DRIFT', async () => {
    const txClient = makePortfolioTxClient();
    // The order that created this position has since transitioned to "canceled" (it no
    // longer matches the old status-based FILL_EVIDENCE_STATUSES filter), but it DID
    // fill 7 shares — the detectDrift query must match on filled_qty > 0, not status.
    const prisma = makePortfolioPrisma({
      txClient,
      realOrderFindFirstResult: { id: 'ro_canceled_partial', status: 'canceled', filled_qty: 7 },
    });
    const portfolio = makePortfolio({ positions: [makeBrokerPosition({ symbol: 'Z', qty: 7 })] });
    const gateway = makePortfolioGateway({ getPortfolioResult: portfolio });
    const alerts = makePortfolioAlerts();
    const svc = makePortfolioService(prisma, gateway, makeKv(), alerts);

    const result = await svc.syncPortfolio('alpaca', 'poll');

    expect(result.driftedSymbols).toEqual([]);
    expect(alerts.create).not.toHaveBeenCalled();
  });

  it('no drift → the kill-switch is left untouched', async () => {
    const txClient = makePortfolioTxClient();
    const prisma = makePortfolioPrisma({ txClient, realOrderFindFirstResult: { id: 'ro_1' } });
    const portfolio = makePortfolio({ positions: [makeBrokerPosition({ symbol: 'Y' })] });
    const gateway = makePortfolioGateway({ getPortfolioResult: portfolio });
    const alerts = makePortfolioAlerts();
    const kv = makeKv();
    const svc = makePortfolioService(prisma, gateway, kv, alerts);

    await svc.syncPortfolio('alpaca', 'poll');

    expect(await kv.get('real_execution.halted')).toBeNull();
  });
});

describe('RealBrokerReconciliationService — portfolio sync wiring into the reconciliation loop', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('no broker configured (execution.broker_plugin_id empty) → onModuleInit skips syncPortfolio cleanly: no getPortfolio call, no alert calls', async () => {
    const prisma = makePortfolioPrisma();
    const gateway = makePortfolioGateway();
    const kv = makeKv({ 'execution.broker_plugin_id': '' });
    const alerts = makePortfolioAlerts();
    const svc = makePortfolioService(prisma, gateway, kv, alerts);
    jest.spyOn(svc, 'reconcileAllOpenOrders').mockResolvedValue(undefined);

    await svc.onModuleInit();

    expect(gateway.getPortfolio).not.toHaveBeenCalled();
    expect(alerts.create).not.toHaveBeenCalled();
    expect(alerts.getActive).not.toHaveBeenCalled();

    svc.onModuleDestroy();
  });

  it('broker configured → onModuleInit calls syncPortfolio once at startup with source=startup_reconcile', async () => {
    const prisma = makePortfolioPrisma();
    const gateway = makePortfolioGateway({ getPortfolioResult: makePortfolio() });
    const kv = makeKv({ 'execution.broker_plugin_id': 'alpaca' });
    const svc = makePortfolioService(prisma, gateway, kv);
    jest.spyOn(svc, 'reconcileAllOpenOrders').mockResolvedValue(undefined);
    const syncSpy = jest.spyOn(svc, 'syncPortfolio');

    await svc.onModuleInit();

    expect(syncSpy).toHaveBeenCalledWith('alpaca', 'startup_reconcile');
    expect(syncSpy).toHaveBeenCalledTimes(1);

    svc.onModuleDestroy();
  });

  it('steady-state ticks throttle syncPortfolio to roughly once per 60s even with a faster reconciliation interval', async () => {
    const prisma = makePortfolioPrisma();
    const gateway = makePortfolioGateway({ getPortfolioResult: makePortfolio() });
    const kv = makeKv({
      'execution.broker_plugin_id': 'alpaca',
      'execution.real_reconciliation_interval_ms': '15000',
    });
    const svc = makePortfolioService(prisma, gateway, kv);
    jest.spyOn(svc, 'reconcileAllOpenOrders').mockResolvedValue(undefined);
    const syncSpy = jest.spyOn(svc, 'syncPortfolio');

    await svc.onModuleInit(); // 1 startup_reconcile call
    expect(syncSpy).toHaveBeenCalledTimes(1);

    // Three 15s ticks (45s elapsed) — still under the 60s throttle window, no new poll sync.
    await jest.advanceTimersByTimeAsync(15_000);
    await jest.advanceTimersByTimeAsync(15_000);
    await jest.advanceTimersByTimeAsync(15_000);
    expect(syncSpy).toHaveBeenCalledTimes(1);

    // Fourth tick crosses the 60s mark since the startup sync — a poll sync fires.
    await jest.advanceTimersByTimeAsync(15_000);
    expect(syncSpy).toHaveBeenCalledTimes(2);
    expect(syncSpy).toHaveBeenLastCalledWith('alpaca', 'poll');

    svc.onModuleDestroy();
  });
});
