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
import type { PrismaService } from '../prisma/prisma.service';
import type { ProviderGatewayService } from '../providers/provider-gateway.service';

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
  realOrder: { update: jest.Mock };
  tradeIntent: { update: jest.Mock };
};

function makeTxClient(): TxClient {
  return {
    realOrder: { update: jest.fn().mockResolvedValue(undefined) },
    tradeIntent: { update: jest.fn().mockResolvedValue(undefined) },
  };
}

function makePrisma(opts?: {
  findUniqueResult?: RealOrderRow | null;
  txClient?: TxClient;
}): jest.Mocked<Pick<PrismaService, 'realOrder' | 'tradeIntent' | '$transaction'>> {
  const txClient = opts?.txClient ?? makeTxClient();
  const realOrder = {
    findUnique: jest.fn().mockResolvedValue(opts?.findUniqueResult ?? makeRow()),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const tradeIntent = {
    update: jest.fn().mockResolvedValue(undefined),
  };
  const $transaction = jest.fn().mockImplementation(async (fn: (tx: TxClient) => Promise<void>) => {
    return fn(txClient);
  });

  return { realOrder, tradeIntent, $transaction } as unknown as jest.Mocked<
    Pick<PrismaService, 'realOrder' | 'tradeIntent' | '$transaction'>
  >;
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

function makeService(
  prisma: ReturnType<typeof makePrisma>,
  gateway: ReturnType<typeof makeGateway>,
): RealBrokerReconciliationService {
  return new (RealBrokerReconciliationService as unknown as new (
    db: unknown,
    gateway: unknown,
  ) => RealBrokerReconciliationService)(prisma, gateway);
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
    expect(txClient.realOrder.update).toHaveBeenCalledTimes(1);
    expect(txClient.tradeIntent.update).toHaveBeenCalledTimes(1);

    const roArgs = callArg<{ where: { id: string }; data: Record<string, unknown> }>(
      txClient.realOrder.update,
    );
    expect(roArgs.where.id).toBe('ro_1');
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
    const updateCalls = (prisma.realOrder.update as jest.Mock).mock.calls as unknown[][];
    const updateArgs = updateCalls[0][0] as { data: Record<string, unknown> };
    expect(updateArgs.data['status']).toBe('partially_filled');
    expect(updateArgs.data['filled_qty']).toBe(4);
    expect(updateArgs.data['filled_avg_price']).toBeCloseTo(149.9, 5);
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
      const roArgs = callArg<{ data: Record<string, unknown> }>(txClient.realOrder.update);
      expect(roArgs.data['status']).toBe(brokerStatus);

      const tiArgs = callArg<{ data: Record<string, unknown> }>(txClient.tradeIntent.update);
      expect(tiArgs.data['status']).toBe('failed');
      expect(typeof tiArgs.data['reject_reason']).toBe('string');
      expect((tiArgs.data['reject_reason'] as string).length).toBeGreaterThan(0);
    });
  },
);

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
