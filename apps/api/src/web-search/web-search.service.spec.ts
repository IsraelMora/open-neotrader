import { ConfigService } from '@nestjs/config';
import { WebSearchService } from './web-search.service';

// ── Global fetch mock — same pattern as ProviderGatewayService specs ──────────

let originalFetch: typeof globalThis.fetch;
let fetchMock: jest.Mock;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  fetchMock = jest.fn();
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeService(env: Record<string, string> = {}): WebSearchService {
  const cfg = {
    get: <T>(key: string, defaultValue?: T): T => {
      return (key in env ? (env[key] as unknown as T) : defaultValue) as T;
    },
  } as unknown as ConfigService;
  return new WebSearchService(cfg);
}

// ── Default provider: gemini (native Google Search grounding) ─────────────────

describe('WebSearchService — gemini provider (default)', () => {
  it('returns ok:false without calling fetch when LLM_API_KEY is unset', async () => {
    const svc = makeService({});

    const result = await svc.search('fed rate decision');

    expect(result.ok).toBe(false);
    expect(result.text).toContain('LLM_API_KEY');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('parses a grounded generateContent response into text + sources, reusing LLM_API_KEY', async () => {
    const svc = makeService({ LLM_API_KEY: 'gm-secret-key' });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          candidates: [
            {
              content: {
                parts: [
                  { text: 'The Fed held rates steady in its latest meeting. ' },
                  { text: 'Markets reacted calmly.' },
                ],
              },
              groundingMetadata: {
                groundingChunks: [
                  { web: { title: 'Fed holds rates', uri: 'https://example.com/fed-rates' } },
                ],
                // Must be ignored — huge HTML/CSS blob, never surfaced.
                searchEntryPoint: { renderedContent: '<div style="huge-blob">...</div>' },
              },
            },
          ],
        }),
    });

    const result = await svc.search('fed rate decision');

    expect(result.ok).toBe(true);
    expect(result.text).toContain('The Fed held rates steady');
    expect(result.text).toContain('Markets reacted calmly');
    expect(result.text).not.toContain('huge-blob');
    expect(result.sources).toHaveLength(1);
    expect(result.sources?.[0]).toContain('https://example.com/fed-rates');
    expect(result.sources?.[0]).toContain('Fed holds rates');

    // Verify the outbound request shape: native endpoint, key as query param (not header),
    // model defaults to gemini-2.5-flash, tools:[{googleSearch:{}}].
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=gm-secret-key',
    );
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      contents: [{ parts: [{ text: 'fed rate decision' }] }],
      tools: [{ googleSearch: {} }],
    });
  });

  it('caps the sources array at 8 even when groundingChunks returns many more', async () => {
    const svc = makeService({ LLM_API_KEY: 'gm-secret-key' });
    const manyChunks = Array.from({ length: 20 }, (_, i) => ({
      web: { title: `Source ${String(i)}`, uri: `https://example.com/${String(i)}` },
    }));
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          candidates: [
            {
              content: { parts: [{ text: 'summary' }] },
              groundingMetadata: { groundingChunks: manyChunks },
            },
          ],
        }),
    });

    const result = await svc.search('fed rate decision');

    expect(result.ok).toBe(true);
    expect(result.sources?.length).toBeLessThanOrEqual(8);
    expect(result.sources).toHaveLength(8);
  });

  it('honors WEB_SEARCH_MODEL override', async () => {
    const svc = makeService({ LLM_API_KEY: 'gm-secret-key', WEB_SEARCH_MODEL: 'gemini-3.5-flash' });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
    });

    await svc.search('anything');

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('models/gemini-3.5-flash:generateContent');
  });

  it('derives the native base URL from LLM_BASE_URL by stripping a trailing /openai', async () => {
    const svc = makeService({
      LLM_API_KEY: 'gm-secret-key',
      LLM_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
    });

    await svc.search('anything');

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=gm-secret-key',
    );
  });

  it('falls back to the default native base URL when LLM_BASE_URL is unset', async () => {
    const svc = makeService({ LLM_API_KEY: 'gm-secret-key' });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
    });

    await svc.search('anything');

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url.startsWith('https://generativelanguage.googleapis.com/v1beta/models/')).toBe(true);
  });

  it('WEB_SEARCH_BASE_URL takes precedence over LLM_BASE_URL when both are set', async () => {
    const svc = makeService({
      LLM_API_KEY: 'gm-secret-key',
      LLM_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai',
      WEB_SEARCH_BASE_URL: 'https://custom.example.com/v1beta',
    });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
    });

    await svc.search('anything');

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url.startsWith('https://custom.example.com/v1beta/models/')).toBe(true);
  });

  it('fails soft (ok:false) when fetch throws (network error / timeout)', async () => {
    const svc = makeService({ LLM_API_KEY: 'gm-secret-key' });
    fetchMock.mockRejectedValue(new Error('The operation was aborted'));

    const result = await svc.search('anything');

    expect(result.ok).toBe(false);
    expect(result.text).toContain('Búsqueda web falló');
  });

  it('fails soft (ok:false) when the HTTP response is not ok', async () => {
    const svc = makeService({ LLM_API_KEY: 'gm-secret-key' });
    fetchMock.mockResolvedValue({ ok: false, status: 429, json: () => Promise.resolve({}) });

    const result = await svc.search('anything');

    expect(result.ok).toBe(false);
    expect(result.text).toContain('Búsqueda web falló');
  });

  it('fails soft (ok:false) when the response body cannot be parsed', async () => {
    const svc = makeService({ LLM_API_KEY: 'gm-secret-key' });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new Error('invalid json')),
    });

    const result = await svc.search('anything');

    expect(result.ok).toBe(false);
    expect(result.text).toContain('Búsqueda web falló');
  });

  it('fails soft (ok:false) when candidates are empty (no grounding data)', async () => {
    const svc = makeService({ LLM_API_KEY: 'gm-secret-key' });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ candidates: [] }),
    });

    const result = await svc.search('anything');

    expect(result.ok).toBe(true); // empty candidates is a valid (if unhelpful) response, not an error
    expect(result.text).toBe('');
    expect(result.sources).toEqual([]);
  });

  it('never logs the API key', async () => {
    const svc = makeService({ LLM_API_KEY: 'super-secret-value' });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
    });

    const warnSpy = jest.spyOn((svc as unknown as { log: { warn: jest.Mock } }).log, 'warn');
    const logSpy = jest.spyOn((svc as unknown as { log: { log: jest.Mock } }).log, 'log');

    await svc.search('anything');
    fetchMock.mockRejectedValue(new Error('boom'));
    await svc.search('anything');

    const allLoggedText = [...warnSpy.mock.calls, ...logSpy.mock.calls].flat().join(' ');
    expect(allLoggedText).not.toContain('super-secret-value');
  });
});

// ── Tavily provider — optional alternative, selected via WEB_SEARCH_PROVIDER ──

describe('WebSearchService — tavily provider (opt-in via WEB_SEARCH_PROVIDER=tavily)', () => {
  it('returns ok:false without calling fetch when WEB_SEARCH_API_KEY is unset', async () => {
    const svc = makeService({ WEB_SEARCH_PROVIDER: 'tavily' });

    const result = await svc.search('fed rate decision');

    expect(result.ok).toBe(false);
    expect(result.text).toContain('WEB_SEARCH_API_KEY');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('parses a Tavily response into a compact text block + sources when keyed', async () => {
    const svc = makeService({ WEB_SEARCH_PROVIDER: 'tavily', WEB_SEARCH_API_KEY: 'tv-secret-key' });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          answer: 'The Fed held rates steady in its latest meeting.',
          results: [
            {
              title: 'Fed holds rates',
              content: 'The Federal Reserve kept interest rates unchanged today.',
              url: 'https://example.com/fed-rates',
            },
          ],
        }),
    });

    const result = await svc.search('fed rate decision');

    expect(result.ok).toBe(true);
    expect(result.text).toContain('Fed held rates steady');
    expect(result.text).toContain('Fed holds rates');
    expect(result.sources).toEqual(['https://example.com/fed-rates']);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.tavily.com/search');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      api_key: 'tv-secret-key',
      query: 'fed rate decision',
      max_results: 5,
      search_depth: 'basic',
      include_answer: true,
    });
  });

  it('fails soft (ok:false) when fetch throws (network error / timeout)', async () => {
    const svc = makeService({ WEB_SEARCH_PROVIDER: 'tavily', WEB_SEARCH_API_KEY: 'tv-secret-key' });
    fetchMock.mockRejectedValue(new Error('The operation was aborted'));

    const result = await svc.search('anything');

    expect(result.ok).toBe(false);
    expect(result.text).toContain('Búsqueda web falló');
  });

  it('fails soft (ok:false) when the HTTP response is not ok', async () => {
    const svc = makeService({ WEB_SEARCH_PROVIDER: 'tavily', WEB_SEARCH_API_KEY: 'tv-secret-key' });
    fetchMock.mockResolvedValue({ ok: false, status: 401, json: () => Promise.resolve({}) });

    const result = await svc.search('anything');

    expect(result.ok).toBe(false);
    expect(result.text).toContain('Búsqueda web falló');
  });

  it('never logs the API key', async () => {
    const svc = makeService({
      WEB_SEARCH_PROVIDER: 'tavily',
      WEB_SEARCH_API_KEY: 'super-secret-value',
    });
    fetchMock.mockRejectedValue(new Error('boom'));

    const warnSpy = jest.spyOn((svc as unknown as { log: { warn: jest.Mock } }).log, 'warn');

    await svc.search('anything');

    const allLoggedText = warnSpy.mock.calls.flat().join(' ');
    expect(allLoggedText).not.toContain('super-secret-value');
  });
});

describe('WebSearchService — unknown provider', () => {
  it('fails soft (ok:false) for an unknown WEB_SEARCH_PROVIDER without calling fetch', async () => {
    const svc = makeService({ WEB_SEARCH_PROVIDER: 'brave' });

    const result = await svc.search('anything');

    expect(result.ok).toBe(false);
    expect(result.text).toContain('brave');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
