/**
 * real-execution-halt.util.spec.ts — TDD RED → GREEN for the global real-money
 * kill-switch primitives (see class doc in real-execution-halt.util.ts).
 */
import {
  isRealExecutionHalted,
  haltRealExecution,
  clearRealExecutionHalt,
  getRealExecutionHaltStatus,
  REAL_EXECUTION_HALTED_KEY,
  REAL_EXECUTION_HALT_REASON_KEY,
} from './real-execution-halt.util';
import type { KvService } from './kv.service';

type MockKv = jest.Mocked<Pick<KvService, 'get' | 'set' | 'delete'>>;

function makeKv(): KvService {
  const mock: MockKv = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  return mock as unknown as KvService;
}

/** Typed accessor for the underlying jest mocks on a KvService produced by makeKv(). */
function mocks(kv: KvService): MockKv {
  return kv as unknown as MockKv;
}

describe('isRealExecutionHalted', () => {
  it('defaults to false when the KV key is unset', async () => {
    const kv = makeKv();
    await expect(isRealExecutionHalted(kv)).resolves.toBe(false);
  });

  it('returns true when the KV key is "true"', async () => {
    const kv = makeKv();
    mocks(kv).get.mockResolvedValue('true');
    await expect(isRealExecutionHalted(kv)).resolves.toBe(true);
  });
});

describe('haltRealExecution', () => {
  it('sets the halted flag to true and persists the reason', async () => {
    const kv = makeKv();
    await haltRealExecution(kv, 'reconciliation circuit breaker open');
    expect(mocks(kv).set).toHaveBeenCalledWith(REAL_EXECUTION_HALTED_KEY, 'true');
    expect(mocks(kv).set).toHaveBeenCalledWith(
      REAL_EXECUTION_HALT_REASON_KEY,
      'reconciliation circuit breaker open',
    );
  });
});

describe('clearRealExecutionHalt', () => {
  it('sets the halted flag to false and clears the reason', async () => {
    const kv = makeKv();
    await clearRealExecutionHalt(kv);
    expect(mocks(kv).set).toHaveBeenCalledWith(REAL_EXECUTION_HALTED_KEY, 'false');
    expect(mocks(kv).delete).toHaveBeenCalledWith(REAL_EXECUTION_HALT_REASON_KEY);
  });
});

describe('getRealExecutionHaltStatus', () => {
  it('reports halted=false, reason=null when not tripped', async () => {
    const kv = makeKv();
    await expect(getRealExecutionHaltStatus(kv)).resolves.toEqual({ halted: false, reason: null });
  });

  it('reports halted=true with the persisted reason when tripped', async () => {
    const kv = makeKv();
    mocks(kv).get.mockImplementation((key: string) =>
      Promise.resolve(
        {
          [REAL_EXECUTION_HALTED_KEY]: 'true',
          [REAL_EXECUTION_HALT_REASON_KEY]: 'broker position drift detected',
        }[key] ?? null,
      ),
    );
    await expect(getRealExecutionHaltStatus(kv)).resolves.toEqual({
      halted: true,
      reason: 'broker position drift detected',
    });
  });
});
