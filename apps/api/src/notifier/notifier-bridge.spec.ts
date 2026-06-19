/**
 * NotifierBridge — unit tests (PR B, Phase B1)
 *
 * Tests run against the MECHANISM only:
 *  - send('telegram', text) → exactly one fetch to the Telegram API URL
 *  - missing TELEGRAM_BOT_TOKEN → {ok:false, error} returned (no throw)
 *  - unknown channel → no-op + warn (no fetch, no throw)
 */

import { NotifierBridge } from './notifier-bridge';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeBridge(): NotifierBridge {
  return new NotifierBridge();
}

// Save and restore env vars around tests that mutate them
function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>,
): () => Promise<void> {
  return async () => {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k];
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    try {
      await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = v;
        }
      }
    }
  };
}

// ── B1.1 — send('telegram','hello') hits Telegram API exactly once ────────────

describe('NotifierBridge.send — telegram channel (B1.1)', () => {
  let fetchSpy: jest.SpyInstance;
  const TOKEN = 'test-bot-token';
  const CHAT = 'test-chat-id';

  beforeEach(() => {
    process.env['TELEGRAM_BOT_TOKEN'] = TOKEN;
    process.env['TELEGRAM_CHAT_ID'] = CHAT;
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
  });

  afterEach(() => {
    delete process.env['TELEGRAM_BOT_TOKEN'];
    delete process.env['TELEGRAM_CHAT_ID'];
    fetchSpy.mockRestore();
  });

  it('calls fetch exactly once with the correct Telegram URL', async () => {
    const bridge = makeBridge();
    await bridge.send('telegram', 'hello');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
  });

  it('includes chat_id and text in the POST body', async () => {
    const bridge = makeBridge();
    await bridge.send('telegram', 'hello world');

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['chat_id']).toBe(CHAT);
    expect(body['text']).toBe('hello world');
  });

  it('returns {ok:true} on success', async () => {
    const bridge = makeBridge();
    const result = await bridge.send('telegram', 'hello');
    expect(result.ok).toBe(true);
  });
});

// ── B1.2 — missing TELEGRAM_BOT_TOKEN → {ok:false, error}, no throw ──────────

describe('NotifierBridge.send — missing credentials (B1.2)', () => {
  it(
    'returns {ok:false, error} and does not throw when TELEGRAM_BOT_TOKEN is absent',
    withEnv({ TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_CHAT_ID: 'some-chat' }, async () => {
      const bridge = makeBridge();
      const result = await bridge.send('telegram', 'hello');
      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    }),
  );

  it(
    'returns {ok:false, error} and does not throw when TELEGRAM_CHAT_ID is absent',
    withEnv({ TELEGRAM_BOT_TOKEN: 'some-token', TELEGRAM_CHAT_ID: undefined }, async () => {
      const bridge = makeBridge();
      const result = await bridge.send('telegram', 'hello');
      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    }),
  );
});

// ── B1.3-style: unknown channel → no fetch + no throw ─────────────────────────

describe('NotifierBridge.send — unknown channel (no-op)', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('does not call fetch for an unknown channel', async () => {
    const bridge = makeBridge();
    // 'sms' is not a known channel
    const result = await bridge.send('sms', 'hello');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.ok).toBe(true); // no-op is not an error
  });
});
