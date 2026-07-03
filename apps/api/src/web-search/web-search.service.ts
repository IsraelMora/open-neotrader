/**
 * WebSearchService — kernel-level, provider-agnostic web search.
 *
 * The API process HAS internet access (only the Python sandbox subprocess is
 * network-isolated — see CLAUDE.md "Security boundaries"). This service is the
 * single place that performs outbound web-search HTTP calls on behalf of the
 * kernel__web_search tool (agents.service.ts).
 *
 * Default provider: 'gemini' — native Google Search grounding via the Gemini
 * generateContent API. It reuses LLM_API_KEY (the key already configured for the
 * chat/decision LLM) so web_search works out-of-the-box with zero extra credentials
 * whenever the deployment's LLM backend is Gemini. Grounding is free on
 * gemini-2.5-flash; gemini-3.5-flash 429s on grounding as of this writing, so the
 * default model stays pinned to 2.5-flash (overridable via WEB_SEARCH_MODEL).
 *
 * 'tavily' remains available as an explicit opt-in (WEB_SEARCH_PROVIDER=tavily),
 * requiring its own WEB_SEARCH_API_KEY.
 *
 * Contract: READ-ONLY and FAIL-SOFT.
 * - Never throws. Every failure path (missing key, unknown provider, HTTP error,
 *   parse error, network error, timeout) returns { ok: false, text: <reason> }.
 * - Never logs any API key.
 * - Provider-agnostic: WEB_SEARCH_PROVIDER selects a handler from PROVIDER_HANDLERS.
 *   Adding 'brave' or another backend later is just another entry in that map.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface WebSearchResult {
  ok: boolean;
  text: string;
  sources?: string[];
}

/**
 * Per-provider search handler signature. Each handler resolves its OWN config
 * (api key, model, base url) from ConfigService — different providers key off
 * different env vars (gemini reuses LLM_API_KEY; tavily needs WEB_SEARCH_API_KEY).
 * Never throws — the caller still wraps the call in try/catch as defense in depth.
 */
type SearchProviderFn = (query: string, cfg: ConfigService) => Promise<WebSearchResult>;

const SEARCH_TIMEOUT_MS = 15_000;
/** Hard cap on the final text block handed back to the ReAct loop as a tool observation. */
const TEXT_BLOCK_CAP = 2000;
/**
 * Hard cap on the gemini `sources` array derived from grounding chunks. Unlike `text`
 * (bounded by TEXT_BLOCK_CAP), groundingChunks has no inherent size limit — a heavily
 * grounded response could return dozens of chunks. Mirrors the Tavily MAX_RESULTS cap.
 */
const MAX_GEMINI_SOURCES = 8;

// ── gemini provider (default) — native Google Search grounding ────────────────

const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

interface GeminiGroundingChunk {
  web?: { title?: string; uri?: string };
}

interface GeminiCandidate {
  content?: { parts?: { text?: string }[] };
  groundingMetadata?: {
    groundingChunks?: GeminiGroundingChunk[];
    // searchEntryPoint.renderedContent is a large HTML/CSS blob — intentionally never read.
  };
}

interface GeminiGenerateContentResponse {
  candidates?: GeminiCandidate[];
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * Resolves the native Gemini base URL:
 * 1. WEB_SEARCH_BASE_URL, if set, wins outright.
 * 2. Otherwise derive from LLM_BASE_URL by stripping a trailing '/openai' — the
 *    OpenAI-compatible endpoint and the native endpoint share the same host/prefix
 *    (LLM_BASE_URL=".../v1beta/openai" → native base ".../v1beta").
 * 3. Otherwise fall back to the public Gemini API base URL.
 */
function resolveGeminiBaseUrl(cfg: ConfigService): string {
  const explicit = cfg.get<string>('WEB_SEARCH_BASE_URL', '');
  if (explicit && explicit.trim()) return stripTrailingSlash(explicit.trim());

  const llmBase = cfg.get<string>('LLM_BASE_URL', '');
  if (llmBase && llmBase.trim()) {
    const trimmed = stripTrailingSlash(llmBase.trim());
    return trimmed.endsWith('/openai') ? trimmed.slice(0, -'/openai'.length) : trimmed;
  }

  return DEFAULT_GEMINI_BASE_URL;
}

/**
 * Gemini provider — POST /models/{model}:generateContent?key=... with
 * { contents: [{ parts: [{ text: query }] }], tools: [{ googleSearch: {} }] }.
 * The key travels as a query param (native Gemini auth convention), NOT a Bearer
 * header. Reuses LLM_API_KEY — no separate credential needed for this provider.
 */
async function searchGemini(query: string, cfg: ConfigService): Promise<WebSearchResult> {
  const apiKey = cfg.get<string>('LLM_API_KEY', '');
  if (!apiKey) {
    return { ok: false, text: 'Búsqueda web no configurada (falta LLM_API_KEY).' };
  }

  const model = cfg.get<string>('WEB_SEARCH_MODEL', DEFAULT_GEMINI_MODEL) || DEFAULT_GEMINI_MODEL;
  const baseUrl = resolveGeminiBaseUrl(cfg);
  const url = `${baseUrl}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const res = await globalThis.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: query }] }],
      tools: [{ googleSearch: {} }],
    }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    return { ok: false, text: `Búsqueda web falló: HTTP ${String(res.status)}` };
  }

  const data = (await res.json()) as GeminiGenerateContentResponse;
  const candidate = data.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const text = parts
    .map((p) => p.text ?? '')
    .join('')
    .slice(0, TEXT_BLOCK_CAP);

  // Only title+uri are ever read from groundingChunks. searchEntryPoint.renderedContent
  // is deliberately ignored — it's a large HTML/CSS blob, not useful as tool-call text.
  const chunks = candidate?.groundingMetadata?.groundingChunks ?? [];
  const sources = chunks
    .map((c) => {
      const title = c.web?.title ?? '';
      const uri = c.web?.uri ?? '';
      if (!uri) return null;
      return title ? `${title} — ${uri}` : uri;
    })
    .filter((s): s is string => s !== null)
    .slice(0, MAX_GEMINI_SOURCES);

  return { ok: true, text, sources };
}

// ── tavily provider (opt-in) ───────────────────────────────────────────────────

const DEFAULT_TAVILY_BASE_URL = 'https://api.tavily.com/search';
const MAX_RESULTS = 5;
/** Per-result content excerpt cap, keeps the compact text block bounded before the outer slice. */
const RESULT_CONTENT_CAP = 300;

interface TavilyResult {
  title?: string;
  content?: string;
  url?: string;
}

interface TavilyResponse {
  answer?: string;
  results?: TavilyResult[];
}

/**
 * Tavily provider — POST /search with { api_key, query, max_results, search_depth, include_answer }.
 * Returns include_answer + the top results' title/content/url compacted into a single text block.
 * Requires its own WEB_SEARCH_API_KEY (Tavily has no relation to the platform's LLM key).
 */
async function searchTavily(query: string, cfg: ConfigService): Promise<WebSearchResult> {
  const apiKey = cfg.get<string>('WEB_SEARCH_API_KEY', '');
  if (!apiKey) {
    return { ok: false, text: 'Búsqueda web no configurada (falta WEB_SEARCH_API_KEY).' };
  }

  const rawBaseUrl = cfg.get<string>('WEB_SEARCH_BASE_URL', '');
  const url = rawBaseUrl && rawBaseUrl.trim() ? rawBaseUrl.trim() : DEFAULT_TAVILY_BASE_URL;

  const res = await globalThis.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: MAX_RESULTS,
      search_depth: 'basic',
      include_answer: true,
    }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    return { ok: false, text: `Búsqueda web falló: HTTP ${String(res.status)}` };
  }

  const data = (await res.json()) as TavilyResponse;
  const results = Array.isArray(data.results) ? data.results : [];

  const lines: string[] = [];
  if (data.answer) lines.push(data.answer);
  for (const r of results.slice(0, MAX_RESULTS)) {
    const title = r.title ?? '';
    const content = (r.content ?? '').slice(0, RESULT_CONTENT_CAP);
    lines.push(`- ${title}: ${content}`);
  }

  const sources = results
    .map((r) => r.url)
    .filter((u): u is string => typeof u === 'string' && u.length > 0);

  return { ok: true, text: lines.join('\n').slice(0, TEXT_BLOCK_CAP), sources };
}

/** Registry of provider handlers. Add a new entry here to support another search backend. */
const PROVIDER_HANDLERS: Record<string, SearchProviderFn> = {
  gemini: searchGemini,
  tavily: searchTavily,
};

const DEFAULT_PROVIDER = 'gemini';

@Injectable()
export class WebSearchService {
  private readonly log = new Logger(WebSearchService.name);

  constructor(private readonly cfg: ConfigService) {}

  /**
   * Performs a provider-agnostic web search. Never throws.
   * Fail-soft: missing key / unknown provider / HTTP error / parse error / timeout
   * all degrade to { ok: false, text: <human-readable reason> } so the caller
   * (the LLM, via the kernel__web_search tool) can keep deciding on what it has.
   */
  async search(query: string): Promise<WebSearchResult> {
    const provider =
      this.cfg.get<string>('WEB_SEARCH_PROVIDER', DEFAULT_PROVIDER) || DEFAULT_PROVIDER;
    const handler = PROVIDER_HANDLERS[provider];
    if (!handler) {
      return { ok: false, text: `Búsqueda web falló: proveedor desconocido '${provider}'.` };
    }

    try {
      return await handler(query, this.cfg);
    } catch (err: unknown) {
      // Never include any API key in the log — only the provider id and the error message.
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`web_search failed (provider=${provider}): ${msg}`);
      return { ok: false, text: `Búsqueda web falló: ${msg}` };
    }
  }
}
