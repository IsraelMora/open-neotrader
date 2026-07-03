import { ContextMemoryService } from './context-memory.service';
import { KvService } from '../common/kv.service';

// ── F5: cycle crash "Cannot read properties of undefined (reading 'slice')" ──
//
// context-memory.service.ts's get() does an unchecked `JSON.parse(raw) as
// ContextMemory` — no shape validation. The render helpers (buildObservationsSection,
// buildSignalsSection) then call .slice() directly on possibly-undefined stored
// fields (obs.ts, obs.cycle_id, info.last_ts). A legacy/corrupted KV blob with a
// missing field crashes the WHOLE cycle (confirmed prod crash, ~8.5% of cycles
// failed). toContextString() must be defensive: render missing fields as empty
// strings instead of throwing.

function makeKvMock(rawValue: string | null): { get: jest.Mock } {
  return { get: jest.fn().mockResolvedValue(rawValue) };
}

describe('F5 context-memory-crash-fix — toContextString survives malformed KV data', () => {
  it('a. malformed observation missing ts/cycle_id does not throw and renders empty fields', async () => {
    const malformed = JSON.stringify({
      last_updated: '2026-01-01T00:00:00.000Z',
      observations: [{ signals_count: 3 }], // missing ts, cycle_id, text
      flags: [],
      signal_summary: {},
    });
    const kv = makeKvMock(malformed);
    const service = new ContextMemoryService(kv as unknown as KvService);

    let result = '';
    await expect(
      (async () => {
        result = await service.toContextString();
      })(),
    ).resolves.not.toThrow();

    expect(typeof result).toBe('string');
    expect(result).toContain('señales=3');
    // missing ts/cycle_id must render as empty, not crash
    expect(result).toContain('[OBSERVACIONES PREVIAS');
    expect(result).not.toMatch(/undefined/);
  });

  it('b. malformed signal_summary entry missing last_ts does not throw and renders empty date', async () => {
    const malformed = JSON.stringify({
      last_updated: '2026-01-01T00:00:00.000Z',
      observations: [],
      flags: [],
      signal_summary: {
        AAPL: { last_action: 'buy', count: 2 }, // missing last_ts
      },
    });
    const kv = makeKvMock(malformed);
    const service = new ContextMemoryService(kv as unknown as KvService);

    let result = '';
    await expect(
      (async () => {
        result = await service.toContextString();
      })(),
    ).resolves.not.toThrow();

    expect(typeof result).toBe('string');
    expect(result).toContain('[HISTORIAL DE SEÑALES]');
    expect(result).toContain('AAPL: última=buy');
    expect(result).not.toMatch(/undefined/);
  });

  it('c. regression: well-formed data still renders correctly (no behavior change)', async () => {
    const wellFormed = JSON.stringify({
      last_updated: '2026-01-01T00:00:00.000Z',
      observations: [
        {
          ts: '2026-01-01T12:34:56.000Z',
          cycle_id: 'cycle-abcdef123456',
          text: 'observed strong momentum',
          signals_count: 2,
          skills_read: [],
        },
      ],
      flags: [{ key: 'halt', value: true, set_at: '2026-01-01T00:00:00.000Z', set_by: 'user' }],
      signal_summary: {
        MSFT: { last_action: 'sell', last_ts: '2026-01-01T10:00:00.000Z', count: 5 },
      },
    });
    const kv = makeKvMock(wellFormed);
    const service = new ContextMemoryService(kv as unknown as KvService);

    const result = await service.toContextString();

    expect(result).toContain('[FLAGS PERSISTENTES]');
    expect(result).toContain('halt=true');
    expect(result).toContain('[OBSERVACIONES PREVIAS');
    expect(result).toContain('[2026-01-01T12:34] ciclo=cycle-ab señales=2');
    expect(result).toContain('"observed strong momentum"');
    expect(result).toContain('[HISTORIAL DE SEÑALES]');
    expect(result).toContain('MSFT: última=sell (2026-01-01, 5x)');
  });
});
