import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { PluginsService } from '../plugins/plugins.service';
import { buildSubscriptionArgs } from './subscription-args';

/** Petición al LLM: contexto del ciclo y prompt de sistema opcional. */
export interface LlmRequest {
  context: string;
  system_prompt?: string;
}

/** Tool call propuesta por el LLM: qué función de qué plugin invocar y con qué argumentos. */
export interface ToolCallRequest {
  plugin_id: string;
  function: string;
  args: Record<string, unknown>;
}

/** Respuesta normalizada del LLM independientemente del backend usado. */
export interface LlmResponse {
  text: string;
  tool_calls: ToolCallRequest[];
  backend: 'api' | 'subscription';
  skills_read: string[];
  skills_written: string[];
}

const execFileAsync = promisify(execFile);

type LlmBackend = 'anthropic' | 'openai' | 'gemini' | 'subscription' | 'custom';

export interface CustomLlmProvider {
  id: string; // identificador único, e.g. "groq", "openrouter"
  name: string; // nombre para mostrar
  base_url: string; // URL base OpenAI-compatible, e.g. "https://api.groq.com/openai/v1"
  api_key_env: string; // nombre de la variable de entorno con la API key
  default_model: string; // modelo por defecto, e.g. "llama-3.3-70b-versatile"
  description?: string;
}

// Sin presets — el usuario define sus propios providers via POST /llm/providers

/** Abstracción multi-backend del LLM: Anthropic API, OpenAI, Gemini, Claude subscription y providers custom OpenAI-compatible. */
@Injectable()
export class LlmService {
  private readonly log = new Logger(LlmService.name);
  private _model: string;
  private _backend: LlmBackend;
  private _customProviders: Map<string, CustomLlmProvider> = new Map();
  private _activeCustomId: string | null = null;

  constructor(
    private readonly cfg: ConfigService,
    private readonly plugins: PluginsService,
  ) {
    this._model = cfg.get<string>('LLM_MODEL', 'claude-haiku-4-5-20251001');
    this._backend = (cfg.get<string>('LLM_BACKEND', 'anthropic') as LlmBackend) ?? 'anthropic';
  }

  /** Devuelve la configuración activa del LLM: modelo, backend y capacidades. */
  getConfig() {
    const caps: Record<LlmBackend, string[]> = {
      anthropic: ['text_only', 'skills_upfront'],
      openai: ['text_only', 'skills_upfront'],
      gemini: ['text_only', 'skills_upfront'],
      subscription: ['text_only', 'skills_upfront'],
      custom: ['text_only', 'skills_upfront', 'openai_compatible'],
    };
    const activeCustom = this._activeCustomId
      ? this._customProviders.get(this._activeCustomId)
      : null;

    return {
      model: this._model,
      backend: this._backend,
      capabilities: caps[this._backend] ?? [],
      active_custom_provider: activeCustom ?? null,
      note: 'Modo texto: skills inyectados upfront, sin tool calls de provider',
    };
  }

  getCustomProviders(): CustomLlmProvider[] {
    return Array.from(this._customProviders.values());
  }

  /** Registra un provider LLM custom compatible con OpenAI en memoria. */
  addCustomProvider(provider: Omit<CustomLlmProvider, 'id'> & { id?: string }): CustomLlmProvider {
    const id = provider.id ?? provider.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const p: CustomLlmProvider = { ...provider, id };
    this._customProviders.set(id, p);
    this.log.log(`Provider custom añadido: ${p.name} (${p.base_url})`);
    return p;
  }

  removeCustomProvider(id: string): void {
    this._customProviders.delete(id);
    if (this._activeCustomId === id) this._activeCustomId = null;
  }

  /** Cambia modelo, backend o provider custom activo en runtime sin reiniciar. */
  patchConfig(patch: { model?: string; backend?: string; custom_provider_id?: string }) {
    if (patch.model) {
      this._model = patch.model;
    }
    if (patch.backend) {
      this._backend = patch.backend as LlmBackend;
    }
    if (patch.custom_provider_id !== undefined) {
      this._activeCustomId = patch.custom_provider_id || null;
      if (this._activeCustomId) this._backend = 'custom';
    }
    this.log.log(
      `LLM config: model=${this._model} backend=${this._backend} custom=${this._activeCustomId ?? 'none'}`,
    );
    return this.getConfig();
  }

  /** Envía el contexto al LLM activo e inyecta los skills upfront. Selecciona el backend automáticamente. */
  async complete(req: LlmRequest): Promise<LlmResponse> {
    const useSubscription = await this.plugins.isExtraActive('claude-subscription');

    let res: LlmResponse;
    if (useSubscription || this._backend === 'subscription') {
      res = await this.completeViaSubscription(req);
    } else if (this._backend === 'openai') {
      res = await this.completeViaOpenAi(req);
    } else if (this._backend === 'gemini') {
      res = await this.completeViaGemini(req);
    } else if (this._backend === 'custom') {
      res = await this.completeViaCustom(req);
    } else {
      res = await this.completeViaApi(req);
    }

    return res;
  }

  private get model(): string {
    return this._model;
  }

  // ── Backend: Anthropic API ─────────────────────────────────────────────────

  private get apiKey(): string {
    const key = this.cfg.get<string>('ANTHROPIC_API_KEY');
    if (!key) {
      throw new ServiceUnavailableException(
        'ANTHROPIC_API_KEY no configurada — añádela en Credenciales o activa el plugin claude-subscription',
      );
    }
    return key;
  }

  private async completeViaApi(req: LlmRequest): Promise<LlmResponse> {
    const key = this.apiKey;
    const skillsMeta = await this.plugins.getSkillsMetadata();
    const skillContents: string[] = [];
    for (const skill of skillsMeta) {
      const body = await this.plugins.loadSkillContent(skill.name);
      if (body) skillContents.push(`## Skill: ${skill.name}\n\n${body}`);
    }

    const systemContent = [
      req.system_prompt ?? '',
      skillContents.length > 0 ? `## Skills activos\n\n${skillContents.join('\n\n---\n\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    const res = await globalThis.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 4096,
        system: systemContent,
        messages: [{ role: 'user', content: req.context }],
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new ServiceUnavailableException(
        `Anthropic API error ${res.status}: ${err.slice(0, 300)}`,
      );
    }

    const data = (await res.json()) as {
      content?: [{ text?: string }];
    };
    const text = data.content?.[0]?.text ?? '';

    return {
      text,
      tool_calls: [],
      backend: 'api',
      skills_read: skillsMeta.map((s) => s.name),
      skills_written: [],
    };
  }

  // ── Backend: Claude Code subscription (claude CLI) ────────────────────────
  // Inyecta el contenido de skills upfront (no hay tool calls en CLI mode).

  private async completeViaSubscription(req: LlmRequest): Promise<LlmResponse> {
    const skillsMeta = await this.plugins.getSkillsMetadata();

    const skillContents: string[] = [];
    for (const skill of skillsMeta) {
      const body = await this.plugins.loadSkillContent(skill.name);
      if (body) skillContents.push(`## Skill: ${skill.name}\n\n${body}`);
    }

    const base = req.system_prompt ?? '';
    const skillsSection =
      skillContents.length > 0 ? `## Skills cargados\n\n${skillContents.join('\n\n---\n\n')}` : '';
    const system = [base, skillsSection].filter(Boolean).join('\n\n');

    const args = buildSubscriptionArgs({
      model: this.model,
      prompt: req.context,
      system,
    });

    try {
      const { stdout } = await execFileAsync('claude', args, {
        timeout: 120_000,
      });
      return {
        text: stdout.trim(),
        tool_calls: [],
        backend: 'subscription',
        skills_read: skillsMeta.map((s) => s.name),
        skills_written: [],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`claude CLI falló: ${msg}`);
      throw new ServiceUnavailableException(`Plugin claude-subscription: ${msg}`);
    }
  }

  // ── Backend: OpenAI ───────────────────────────────────────────────────────
  // Skills inyectados upfront (sin tool use). Compatible con GPT-4o, GPT-4o-mini, etc.

  private async completeViaOpenAi(req: LlmRequest): Promise<LlmResponse> {
    const apiKey = this.cfg.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      throw new ServiceUnavailableException('OPENAI_API_KEY no configurada');
    }
    // Base URL configurable → permite gateways OpenAI-compatibles (OpenRouter, Groq,
    // etc.) sin cambiar de backend. Default = OpenAI. Sin barra final.
    const baseUrl = (this.cfg.get<string>('OPENAI_BASE_URL') ?? 'https://api.openai.com/v1').replace(
      /\/+$/,
      '',
    );

    const skillsMeta = await this.plugins.getSkillsMetadata();
    const skillContents: string[] = [];
    for (const skill of skillsMeta) {
      const body = await this.plugins.loadSkillContent(skill.name);
      if (body) skillContents.push(`## Skill: ${skill.name}\n\n${body}`);
    }

    const systemContent = [
      req.system_prompt ?? '',
      skillContents.length > 0 ? `## Skills activos\n\n${skillContents.join('\n\n---\n\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    const res = await globalThis.fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: this._model.startsWith('gpt') ? this._model : 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemContent },
          { role: 'user', content: req.context },
        ],
        max_tokens: 4096,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new ServiceUnavailableException(`OpenAI API error ${res.status}: ${err.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      choices?: [{ message?: { content?: string } }];
    };
    const text = data.choices?.[0]?.message?.content?.trim() ?? '';

    return {
      text,
      tool_calls: [],
      backend: 'api',
      skills_read: skillsMeta.map((s) => s.name),
      skills_written: [],
    };
  }

  // ── Backend: Gemini ───────────────────────────────────────────────────────
  // Google Gemini via REST API (sin SDK). Skills inyectados upfront.

  private async completeViaGemini(req: LlmRequest): Promise<LlmResponse> {
    const apiKey = this.cfg.get<string>('GEMINI_API_KEY');
    if (!apiKey) {
      throw new ServiceUnavailableException('GEMINI_API_KEY no configurada');
    }

    const skillsMeta = await this.plugins.getSkillsMetadata();
    const skillContents: string[] = [];
    for (const skill of skillsMeta) {
      const body = await this.plugins.loadSkillContent(skill.name);
      if (body) skillContents.push(`## Skill: ${skill.name}\n\n${body}`);
    }

    const systemInstructions = [
      req.system_prompt ?? '',
      skillContents.length > 0 ? `## Skills activos\n\n${skillContents.join('\n\n---\n\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    const modelId = this._model.startsWith('gemini') ? this._model : 'gemini-2.0-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

    const res = await globalThis.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemInstructions }] },
        contents: [{ parts: [{ text: req.context }] }],
        generationConfig: { maxOutputTokens: 4096 },
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new ServiceUnavailableException(`Gemini API error ${res.status}: ${err.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      candidates?: [{ content?: { parts?: [{ text?: string }] } }];
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';

    return {
      text,
      tool_calls: [],
      backend: 'api',
      skills_read: skillsMeta.map((s) => s.name),
      skills_written: [],
    };
  }

  // ── Backend: Custom (OpenAI-compatible) ──────────────────────────────────
  // Funciona con cualquier API compatible con OpenAI: Groq, OpenRouter, Together,
  // Mistral, Ollama, LM Studio, Perplexity, Fireworks, Anyscale, etc.

  private async completeViaCustom(req: LlmRequest): Promise<LlmResponse> {
    const provider = this._activeCustomId ? this._customProviders.get(this._activeCustomId) : null;

    if (!provider) {
      throw new ServiceUnavailableException(
        'Backend custom activo pero sin provider configurado. Usa PATCH /llm/config { custom_provider_id: "groq" }',
      );
    }

    const apiKey = process.env[provider.api_key_env] ?? '';
    if (!apiKey && provider.id !== 'ollama') {
      throw new ServiceUnavailableException(
        `${provider.name}: variable de entorno ${provider.api_key_env} no configurada`,
      );
    }

    const skillsMeta = await this.plugins.getSkillsMetadata();
    const skillContents: string[] = [];
    for (const skill of skillsMeta) {
      const body = await this.plugins.loadSkillContent(skill.name);
      if (body) skillContents.push(`## Skill: ${skill.name}\n\n${body}`);
    }

    const systemContent = [
      req.system_prompt ?? '',
      skillContents.length > 0 ? `## Skills activos\n\n${skillContents.join('\n\n---\n\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    const model =
      this._model !== 'claude-haiku-4-5-20251001' ? this._model : provider.default_model;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    // OpenRouter requiere un header de referer
    if (provider.id === 'openrouter') {
      headers['HTTP-Referer'] = 'https://neurotrader.local';
      headers['X-Title'] = 'NeuroTrader';
    }

    const res = await globalThis.fetch(`${provider.base_url}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemContent },
          { role: 'user', content: req.context },
        ],
        max_tokens: 4096,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new ServiceUnavailableException(
        `${provider.name} API error ${res.status}: ${err.slice(0, 300)}`,
      );
    }

    const data = (await res.json()) as {
      choices?: [{ message?: { content?: string } }];
    };
    const text = data.choices?.[0]?.message?.content?.trim() ?? '';

    this.log.debug(`${provider.name} (${model}): ${text.length} chars`);

    return {
      text,
      tool_calls: [],
      backend: 'api',
      skills_read: skillsMeta.map((s) => s.name),
      skills_written: [],
    };
  }
}
