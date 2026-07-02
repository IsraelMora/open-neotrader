/**
 * real-order.schema.spec.ts — schema smoke test for the real-money accounting
 * foundation slice (RealOrder, RealPosition, RealNavSnapshot Prisma models).
 *
 * No service exists yet for this slice — only the Prisma models + client delegates.
 * This test exercises `PrismaService.realOrder` / `realPosition` / `realNavSnapshot`
 * against a hand-mocked Prisma client (same style as ml-signal-record specs) to prove
 * the generated client exposes the new delegates with the expected shapes.
 *
 * Before `prisma generate` picked up the new schema models, `realOrder` / `realPosition`
 * / `realNavSnapshot` did not exist on the `PrismaService` type, so this file failed to
 * typecheck (RED). Regenerating the client (schema-only, no DB write) makes it compile
 * and pass (GREEN).
 */
import type { PrismaService } from '../prisma/prisma.service';

type RealOrderDelegateMock = Pick<PrismaService['realOrder'], 'create' | 'findMany'>;
type RealPositionDelegateMock = Pick<PrismaService['realPosition'], 'create' | 'findMany'>;
type RealNavSnapshotDelegateMock = Pick<PrismaService['realNavSnapshot'], 'create' | 'findMany'>;

function makePrismaMock(): {
  realOrder: RealOrderDelegateMock;
  realPosition: RealPositionDelegateMock;
  realNavSnapshot: RealNavSnapshotDelegateMock;
} {
  return {
    realOrder: {
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    } as RealOrderDelegateMock,
    realPosition: {
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    } as RealPositionDelegateMock,
    realNavSnapshot: {
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    } as RealNavSnapshotDelegateMock,
  };
}

describe('Prisma client — real-money accounting models', () => {
  it('realOrder.create accepts a RealOrder-shaped payload', async () => {
    const prisma = makePrismaMock();

    await prisma.realOrder.create({
      data: {
        trade_intent_id: 'ti_1',
        broker_plugin_id: 'alpaca',
        client_order_id: 'coid_1',
        symbol: 'AAPL',
        side: 'buy',
        requested_qty: 10,
      },
    });

    expect(prisma.realOrder.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        trade_intent_id: 'ti_1',
        broker_plugin_id: 'alpaca',
        client_order_id: 'coid_1',
        symbol: 'AAPL',
        side: 'buy',
        requested_qty: 10,
      }) as unknown,
    });
  });

  it('realOrder.findMany filters by status', async () => {
    const prisma = makePrismaMock();

    await prisma.realOrder.findMany({ where: { status: 'pending_submit' } });

    expect(prisma.realOrder.findMany).toHaveBeenCalledWith({
      where: { status: 'pending_submit' },
    });
  });

  it('realPosition.create accepts a RealPosition-shaped payload', async () => {
    const prisma = makePrismaMock();

    await prisma.realPosition.create({
      data: {
        symbol: 'AAPL',
        broker_plugin_id: 'alpaca',
        qty: 10,
        avg_entry: 150,
        market_value: 1500,
        unrealized_pnl: 0,
        side: 'long',
      },
    });

    expect(prisma.realPosition.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ symbol: 'AAPL', side: 'long' }) as unknown,
    });
  });

  it('realNavSnapshot.create accepts a RealNavSnapshot-shaped payload', async () => {
    const prisma = makePrismaMock();

    await prisma.realNavSnapshot.create({
      data: {
        broker_plugin_id: 'alpaca',
        equity: 10000,
        cash: 2000,
        buying_power: 4000,
        positions: '[]',
        hwm: 10000,
      },
    });

    expect(prisma.realNavSnapshot.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ broker_plugin_id: 'alpaca', equity: 10000 }) as unknown,
    });
  });
});
