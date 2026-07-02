import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Test helpers ────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubLocation(pathname: string) {
  const location = {
    pathname,
    href: `http://localhost${pathname}`,
  };
  Object.defineProperty(window, 'location', {
    value: location,
    writable: true,
    configurable: true,
  });
  return location;
}

describe('auth token storage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('round-trips a token through setToken/getToken', async () => {
    const { auth } = await import('./api');
    auth.setToken('abc123');
    expect(auth.getToken()).toBe('abc123');
  });

  it('clearToken removes the stored token', async () => {
    const { auth } = await import('./api');
    auth.setToken('abc123');
    auth.clearToken();
    expect(auth.getToken()).toBeNull();
  });

  it('isAuthenticated reflects token presence/absence', async () => {
    const { auth } = await import('./api');
    expect(auth.isAuthenticated()).toBe(false);
    auth.setToken('abc123');
    expect(auth.isAuthenticated()).toBe(true);
    auth.clearToken();
    expect(auth.isAuthenticated()).toBe(false);
  });

  it('getToken returns null when localStorage.getItem throws (SSR guard)', async () => {
    const { auth } = await import('./api');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('no localStorage');
    });
    expect(() => auth.getToken()).not.toThrow();
    expect(auth.getToken()).toBeNull();
  });

  it('setToken does not throw when localStorage.setItem throws (SSR guard)', async () => {
    const { auth } = await import('./api');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('no localStorage');
    });
    expect(() => auth.setToken('abc123')).not.toThrow();
  });

  it('clearToken does not throw when localStorage.removeItem throws (SSR guard)', async () => {
    const { auth } = await import('./api');
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('no localStorage');
    });
    expect(() => auth.clearToken()).not.toThrow();
  });
});

describe('client (authed ky instance)', () => {
  beforeEach(() => {
    localStorage.clear();
    stubLocation('/dashboard');
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('attaches Authorization header when a token is present', async () => {
    const { auth, client } = await import('./api');
    auth.setToken('my-token');

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const req = input as Request;
      expect(req.headers.get('Authorization')).toBe('Bearer my-token');
      return jsonResponse({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    await client.get('api/config').json();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not attach Authorization header when no token is present', async () => {
    const { client } = await import('./api');

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const req = input as Request;
      expect(req.headers.has('Authorization')).toBe(false);
      return jsonResponse({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    await client.get('api/config').json();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('on 401, clears the token and redirects to /login when not already there', async () => {
    const { auth, client } = await import('./api');
    auth.setToken('my-token');
    const location = window.location as unknown as { href: string; pathname: string };

    const fetchMock = vi.fn(async () => jsonResponse({ message: 'unauthorized' }, 401));
    vi.stubGlobal('fetch', fetchMock);

    await expect(client.get('api/config').json()).rejects.toThrow();

    expect(auth.getToken()).toBeNull();
    expect(location.href).toBe('/login');
  });

  it('on 401 while already on /login, clears the token but does not redirect', async () => {
    const { auth, client } = await import('./api');
    auth.setToken('my-token');
    const location = stubLocation('/login');
    const originalHref = location.href;

    const fetchMock = vi.fn(async () => jsonResponse({ message: 'unauthorized' }, 401));
    vi.stubGlobal('fetch', fetchMock);

    await expect(client.get('api/config').json()).rejects.toThrow();

    expect(auth.getToken()).toBeNull();
    expect(location.href).toBe(originalHref);
  });
});

describe('publicClient (via api.login)', () => {
  beforeEach(() => {
    localStorage.clear();
    stubLocation('/login');
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does not attach Authorization header even when a token is set', async () => {
    const { auth, api } = await import('./api');
    auth.setToken('my-token');

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const req = input as Request;
      expect(req.headers.has('Authorization')).toBe(false);
      return jsonResponse({ access_token: 'new-token', totp_required: false });
    });
    vi.stubGlobal('fetch', fetchMock);

    await api.login('user', 'pass');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
