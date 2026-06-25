import { StrategyService, STRATEGY_CONFIG_KEYS } from './strategy.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { KvService } from '../common/kv.service';

function makeKv(initial: Record<string, string> = {}): KvService {
  const store = { ...initial };
  return {
    get: jest.fn((k: string) => Promise.resolve(store[k] ?? null)),
    set: jest.fn((k: string, v: string) => {
      store[k] = v;
      return Promise.resolve();
    }),
    delete: jest.fn(() => Promise.resolve()),
  } as unknown as KvService;
}

function makePrisma(over: Partial<Record<string, jest.Mock>> = {}): {
  db: PrismaService;
  strategy: Record<string, jest.Mock>;
} {
  const strategy = {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    ...over,
  };
  return { db: { strategy } as unknown as PrismaService, strategy };
}

const ROW = {
  id: 's1',
  name: 'Agresiva',
  description: null,
  config: JSON.stringify({ 'execution.autonomous': 'true' }),
  active: false,
  mode: 'test',
  created_at: new Date(),
  updated_at: new Date(),
};

describe('StrategyService', () => {
  it('captureCurrentConfig lee SOLO las claves de estrategia y omite las ausentes', async () => {
    const kv = makeKv({
      'execution.autonomous': 'true',
      'llm.model': 'x/y',
      'store.publisher.private_key': 'SECRET', // NO debe capturarse
      'random.key': 'z', // NO es clave de estrategia
    });
    const { db } = makePrisma();
    const svc = new StrategyService(db, kv);
    const cfg = await svc.captureCurrentConfig();
    expect(cfg['execution.autonomous']).toBe('true');
    expect(cfg['llm.model']).toBe('x/y');
    expect(cfg['store.publisher.private_key']).toBeUndefined();
    expect(cfg['random.key']).toBeUndefined();
    expect(
      Object.keys(cfg).every((k) => (STRATEGY_CONFIG_KEYS as readonly string[]).includes(k)),
    ).toBe(true);
  });

  it('create sin config captura la config actual del KV y default mode=test', async () => {
    const kv = makeKv({ 'cycle.timeframe': '1d', 'execution.real': 'false' });
    const { db, strategy } = makePrisma();
    strategy.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...ROW, ...data }),
    );
    const svc = new StrategyService(db, kv);
    const r = await svc.create({ name: 'Conservadora' });
    const arg = strategy.create.mock.calls[0][0].data as { config: string; mode: string };
    const captured = JSON.parse(arg.config) as Record<string, string>;
    expect(captured['cycle.timeframe']).toBe('1d');
    expect(captured['execution.real']).toBe('false');
    expect(arg.mode).toBe('test');
    expect(r.mode).toBe('test');
  });

  it('apply escribe la config de la estrategia en el KV global', async () => {
    const kv = makeKv();
    const { db, strategy } = makePrisma();
    strategy.findUnique.mockResolvedValue({
      ...ROW,
      config: JSON.stringify({ 'execution.autonomous': 'false', 'llm.model': 'm/n' }),
    });
    const svc = new StrategyService(db, kv);
    const res = await svc.apply('s1');
    expect(res.applied.sort()).toEqual(['execution.autonomous', 'llm.model']);
    expect(kv.set).toHaveBeenCalledWith('execution.autonomous', 'false');
    expect(kv.set).toHaveBeenCalledWith('llm.model', 'm/n');
  });

  it('toDto (vía list) parsea config y normaliza mode', async () => {
    const { db, strategy } = makePrisma();
    strategy.findMany.mockResolvedValue([
      { ...ROW, mode: 'live' },
      { ...ROW, id: 's2', mode: 'raro' },
    ]);
    const svc = new StrategyService(db, makeKv());
    const list = await svc.list();
    expect(list[0].config['execution.autonomous']).toBe('true');
    expect(list[0].mode).toBe('live');
    expect(list[1].mode).toBe('test'); // valor inválido → test
  });

  it('get lanza NotFound si no existe', async () => {
    const { db, strategy } = makePrisma();
    strategy.findUnique.mockResolvedValue(null);
    const svc = new StrategyService(db, makeKv());
    await expect(svc.get('nope')).rejects.toThrow();
  });
});
