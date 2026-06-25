import { StrategyService, STRATEGY_CONFIG_KEYS, kebabId } from './strategy.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { KvService } from '../common/kv.service';
import type { StoreService } from '../store/store.service';

function makeStore(): { store: StoreService; publish: jest.Mock } {
  const publish = jest.fn().mockResolvedValue({ id: 'p1', manifestId: 'x', version: '1.0.0' });
  return { store: { publish } as unknown as StoreService, publish };
}

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
  navSnapshot: Record<string, jest.Mock>;
} {
  const strategy = {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    ...over,
  };
  const navSnapshot = { findMany: jest.fn() };
  return { db: { strategy, navSnapshot } as unknown as PrismaService, strategy, navSnapshot };
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
    const svc = new StrategyService(db, kv, makeStore().store);
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
    const svc = new StrategyService(db, kv, makeStore().store);
    const r = await svc.create({ name: 'Conservadora' });
    const createCalls = strategy.create.mock.calls as Array<
      [{ data: { config: string; mode: string } }]
    >;
    const arg = createCalls[0][0].data;
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
    const svc = new StrategyService(db, kv, makeStore().store);
    const res = await svc.apply('s1');
    expect([...res.applied].sort((a, b) => a.localeCompare(b))).toEqual([
      'execution.autonomous',
      'llm.model',
    ]);
    const setMock = (kv as unknown as { set: jest.Mock }).set;
    expect(setMock).toHaveBeenCalledWith('execution.autonomous', 'false');
    expect(setMock).toHaveBeenCalledWith('llm.model', 'm/n');
  });

  it('toDto (vía list) parsea config y normaliza mode', async () => {
    const { db, strategy } = makePrisma();
    strategy.findMany.mockResolvedValue([
      { ...ROW, mode: 'live' },
      { ...ROW, id: 's2', mode: 'raro' },
    ]);
    const svc = new StrategyService(db, makeKv(), makeStore().store);
    const list = await svc.list();
    expect(list[0].config['execution.autonomous']).toBe('true');
    expect(list[0].mode).toBe('live');
    expect(list[1].mode).toBe('test'); // valor inválido → test
  });

  it('get lanza NotFound si no existe', async () => {
    const { db, strategy } = makePrisma();
    strategy.findUnique.mockResolvedValue(null);
    const svc = new StrategyService(db, makeKv(), makeStore().store);
    await expect(svc.get('nope')).rejects.toThrow();
  });

  it('kebabId normaliza nombres con acentos/espacios', () => {
    expect(kebabId('Momentum Agresivo')).toBe('momentum-agresivo');
    expect(kebabId('Rotación Sectorial')).toBe('rotacion-sectorial');
  });

  it('publishToStore genera un manifest preset válido y llama a store.publish', async () => {
    const { db, strategy } = makePrisma();
    strategy.findUnique.mockResolvedValue({
      ...ROW,
      name: 'Momentum Agresivo',
      config: JSON.stringify({ 'llm.model': 'm/n', 'execution.real': 'false' }),
    });
    const { store, publish } = makeStore();
    const svc = new StrategyService(db, makeKv(), store);
    await svc.publishToStore('s1');
    expect(publish).toHaveBeenCalledTimes(1);
    const calls = publish.mock.calls as [string, string][];
    const [manifestToml, payloadB64] = calls[0];
    expect(manifestToml).toContain('type = "preset"');
    expect(manifestToml).toContain('id = "momentum-agresivo"');
    expect(manifestToml).toContain('[preset.config]');
    expect(manifestToml).toContain('"llm.model" = "m/n"');
    // payload base64 decodifica a la config
    const decoded = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8')) as Record<
      string,
      string
    >;
    expect(decoded['execution.real']).toBe('false');
  });

  it('publishToStore rechaza estrategias sin config', async () => {
    const { db, strategy } = makePrisma();
    strategy.findUnique.mockResolvedValue({ ...ROW, config: '{}' });
    const svc = new StrategyService(db, makeKv(), makeStore().store);
    await expect(svc.publishToStore('s1')).rejects.toThrow();
  });

  it('getStats calcula nav/retorno/maxDD desde los NavSnapshots', async () => {
    const { db, strategy, navSnapshot } = makePrisma();
    strategy.findUnique.mockResolvedValue(ROW);
    // serie de equity: 100 → 110 → 99 → 120
    navSnapshot.findMany.mockResolvedValue([
      { equity: 100 },
      { equity: 110 },
      { equity: 99 },
      { equity: 120 },
    ]);
    const svc = new StrategyService(db, makeKv(), makeStore().store);
    const st = await svc.getStats('s1');
    expect(st.n_points).toBe(4);
    expect(st.nav).toBe(120);
    expect(st.return_pct).toBe(20); // (120-100)/100
    expect(st.max_drawdown_pct).toBeCloseTo(10, 0); // 110 → 99 = -10%
    expect(st.sharpe).not.toBeNull();
  });

  it('getStats sin datos devuelve nulos', async () => {
    const { db, strategy, navSnapshot } = makePrisma();
    strategy.findUnique.mockResolvedValue(ROW);
    navSnapshot.findMany.mockResolvedValue([]);
    const svc = new StrategyService(db, makeKv(), makeStore().store);
    const st = await svc.getStats('s1');
    expect(st.n_points).toBe(0);
    expect(st.nav).toBeNull();
    expect(st.return_pct).toBeNull();
  });

  it('navHistory agrupa por strategy_id', async () => {
    const { db, navSnapshot } = makePrisma();
    const ts = new Date();
    navSnapshot.findMany.mockResolvedValue([
      { ts, equity: 100, strategy_id: 'a' },
      { ts, equity: 105, strategy_id: 'a' },
      { ts, equity: 50, strategy_id: 'b' },
    ]);
    const svc = new StrategyService(db, makeKv(), makeStore().store);
    const series = await svc.navHistory();
    expect(series['a']).toHaveLength(2);
    expect(series['b']).toHaveLength(1);
    expect(series['a'][1].equity).toBe(105);
  });
});
