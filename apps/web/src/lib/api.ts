import ky, { type KyInstance } from 'ky';

// ── Token storage ─────────────────────────────────────────────────────────────

const TOKEN_KEY = 'nt_token';

export const auth = {
  getToken: (): string | null => {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  setToken: (token: string) => {
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {
      /* SSR guard */
    }
  },
  clearToken: () => {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* SSR guard */
    }
  },
  isAuthenticated: (): boolean => Boolean(auth.getToken()),
};

// ── HTTP client ───────────────────────────────────────────────────────────────
// Interceptors via ky hooks:
//   beforeRequest  → inject Authorization header
//   afterResponse  → handle 401 (clear token + redirect)
//   beforeError    → unwrap JSON error body into Error.message

export const client: KyInstance = ky.create({
  // Root-anchored: sin esto, ky resuelve 'api/...' contra la ruta actual y en páginas
  // con barra final (p.ej. /login/) produce /login/api/... → 405. Con prefix '/' (ky v2;
  // antes prefixUrl) todas las llamadas resuelven a /api/... sin importar la página.
  prefix: '/',
  credentials: 'same-origin',
  hooks: {
    beforeRequest: [
      ({ request }) => {
        const token = auth.getToken();
        if (token) request.headers.set('Authorization', `Bearer ${token}`);
      },
    ],
    afterResponse: [
      ({ response }) => {
        if (response && response.status === 401) {
          auth.clearToken();
          if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
            window.location.href = '/login';
          }
        }
        return response;
      },
    ],
    beforeError: [
      async ({ error }) => {
        try {
          const body = (await error.response.clone().json()) as Record<string, unknown>;
          error.message =
            (body['message'] as string) ?? (body['detail'] as string) ?? error.response.statusText;
        } catch {
          /* response not JSON — keep default message */
        }
        return error;
      },
    ],
  },
});

// Public-route client (no auth injection — used for login/register)
const publicClient: KyInstance = ky.create({
  prefix: '/', // mismo anclaje a raíz que `client` (ky v2; evita /login/api/... → 405)
  hooks: {
    beforeError: [
      async ({ error }) => {
        try {
          const body = (await error.response.clone().json()) as Record<string, unknown>;
          error.message = (body['message'] as string) ?? error.response.statusText;
        } catch {
          /* */
        }
        return error;
      },
    ],
  },
});

// ── Shared response types ─────────────────────────────────────────────────────

export type JsonObject = Record<string, unknown>;

// ── API surface ───────────────────────────────────────────────────────────────

export const api = {
  // ── Auth (public routes — no token required) ─────────────────────────────
  login: (username: string, password: string) =>
    publicClient
      .post('api/auth/login', { json: { username, password } })
      .json<{ access_token: string; totp_required: boolean }>(),

  register: (username: string, password: string) =>
    publicClient
      .post('api/auth/register', { json: { username, password } })
      .json<{ id: string; username: string }>(),

  totpVerify: (code: string) =>
    client.post('api/auth/totp/verify', { json: { code } }).json<{ access_token: string }>(),

  totpBackup: (code: string) =>
    client.post('api/auth/totp/backup', { json: { code } }).json<{ access_token: string }>(),

  me: () => client.get('api/auth/me').json<JsonObject>(),

  // ── Panel ─────────────────────────────────────────────────────────────────
  status: () => client.get('api/status').json<JsonObject>(),
  config: () => client.get('api/config').json<JsonObject>(),
  saveConfig: (cfg: JsonObject) => client.post('api/config', { json: cfg }).json<JsonObject>(),
  doctor: () => client.get('api/doctor').json<JsonObject>(),
  portfolios: () => client.get('api/portfolios').json<JsonObject>(),
  vetoMetrics: (days = 7) => client.get(`api/veto-metrics?days=${days}`).json<JsonObject>(),
  runStatus: () => client.get('api/run-status').json<JsonObject>(),
  runCycle: (dry: boolean) =>
    client.post('api/run-cycle', { json: { dry_run: dry } }).json<JsonObject>(),
  chat: (question: string, history?: JsonObject[]) =>
    client.post('api/chat', { json: { question, history } }).json<JsonObject>(),
  trades: (limit = 200) => client.get(`api/trades?limit=${limit}`).json<JsonObject>(),
  navHistory: () => client.get('api/nav-history').json<JsonObject>(),
  providers: () => client.get('api/providers').json<JsonObject>(),
  journal: () => client.get('api/journal').json<JsonObject>(),
  notifications: () => client.get('api/notifications').json<JsonObject>(),
  logs: (stream: string, limit = 100) =>
    client.get(`api/logs/${stream}?limit=${limit}`).json<JsonObject>(),
  // ── Estrategias (perfiles de configuración del ciclo) ─────────────────────
  strategies: () => client.get('api/strategies').json<JsonObject[]>(),
  strategyCurrentConfig: () =>
    client.get('api/strategies/config/current').json<Record<string, string>>(),
  strategyCreate: (body: {
    name: string;
    description?: string;
    config?: Record<string, string>;
    mode?: 'test' | 'live';
  }) => client.post('api/strategies', { json: body }).json<JsonObject>(),
  strategyUpdate: (
    id: string,
    body: {
      name?: string;
      description?: string;
      config?: Record<string, string>;
      mode?: 'test' | 'live';
    },
  ) => client.patch(`api/strategies/${id}`, { json: body }).json<JsonObject>(),
  strategyDelete: (id: string) => client.delete(`api/strategies/${id}`).text(),
  strategySetActive: (id: string, active: boolean) =>
    client.post(`api/strategies/${id}/activate`, { json: { active } }).json<JsonObject>(),
  strategyApply: (id: string) =>
    client.post(`api/strategies/${id}/apply`, { json: {} }).json<JsonObject>(),
  strategyPublish: (id: string) =>
    client.post(`api/strategies/${id}/publish`, { json: {} }).json<JsonObject>(),
  strategyStats: (id: string) =>
    client.get(`api/strategies/${id}/stats`).json<{
      strategy_id: string;
      n_points: number;
      nav: number | null;
      return_pct: number | null;
      sharpe: number | null;
      max_drawdown_pct: number | null;
    }>(),

  universeCheck: (symbol: string, kind = 'equity') =>
    client.get(`api/universe/check?symbol=${symbol}&kind=${kind}`).json<JsonObject>(),
  universeEdit: (action: 'add' | 'remove', symbol: string, kind?: string, description?: string) =>
    client.post('api/universe', { json: { action, symbol, kind, description } }).json<JsonObject>(),

  skills: () => client.get('api/skills').json<JsonObject>(),
  addSkill: (name: string, description: string) =>
    client.post('api/skills', { json: { name, description } }).json<JsonObject>(),
  deleteSkill: (name: string) =>
    client.delete(`api/skills/${encodeURIComponent(name)}`).json<JsonObject>(),

  // ── Credentials ───────────────────────────────────────────────────────────
  credentials: () => client.get('api/credentials').json<JsonObject>(),
  setCredential: (env: string, value: string) =>
    client.post('api/credentials', { json: { env, value } }).json<JsonObject>(),

  // ── Plugins ───────────────────────────────────────────────────────────────
  plugins: () => client.get('api/plugins').json<JsonObject>(),
  pluginInstall: (source: string) =>
    client.post('api/plugins/install', { json: { source } }).json<JsonObject>(),
  pluginAction: (id: string, accion: 'activate' | 'deactivate') =>
    client.post(`api/plugins/${id}/${accion}`).json<JsonObject>(),
  pluginConfig: (id: string, config: JsonObject) =>
    client.post(`api/plugins/${id}/config`, { json: { config } }).json<JsonObject>(),
  pluginUninstall: (id: string) => client.delete(`api/plugins/${id}`).json<JsonObject>(),

  // ── Store ─────────────────────────────────────────────────────────────────
  storeBrowse: (qs = '') =>
    client.get('api/store/plugins' + (qs ? '?' + qs : '')).json<JsonObject>(),
  storeDetail: (pub: string, mid: string) =>
    client.get(`api/store/plugins/${pub}/${mid}`).json<JsonObject>(),
  storeInstall: (publisherId: string, manifestId: string, version: string) =>
    client
      .post('api/store/install', { json: { publisherId, manifestId, version } })
      .json<JsonObject>(),
  storePublish: (pluginId: string) =>
    client.post('api/store/publish', { json: { pluginId } }).json<JsonObject>(),
  storeVote: (pluginId: string, kind: 'like' | 'dislike') =>
    client.post('api/store/vote', { json: { pluginId, kind } }).json<JsonObject>(),
  storeReport: (pluginId: string, reason: string) =>
    client.post('api/store/report', { json: { pluginId, reason } }).json<JsonObject>(),
  storeIdentity: () => client.get('api/store/identity').json<JsonObject>(),
  storeSetName: (display_name: string | null) =>
    client.post('api/store/identity', { json: { display_name } }).json<JsonObject>(),
};
