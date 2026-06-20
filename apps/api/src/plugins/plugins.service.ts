import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { PluginEventsService } from './plugin-events.service';
import {
  readManifest,
  validateManifest,
  type PluginManifest,
  type ConfigFieldSpec,
} from './manifest';
import type { DebateRole } from '../agents/debate.types';
import { scanLocalManifests } from './local-sync';
import type { Plugin } from '@prisma/client';
import type { KvService } from '../common/kv.service';
import type { AuditService } from '../audit/audit.service';
import type { SandboxGateway } from '../sandbox/sandbox.gateway';

export type { Plugin };
export type PluginVerification = 'unverified' | 'pending' | 'verified' | 'rejected';
export type { PluginType } from './manifest';

export interface WriteSkillResult {
  ok: boolean;
  reason?: 'not_found' | 'not_writable' | 'diff_too_large' | 'write_failed';
  old_len?: number;
  new_len?: number;
}

export interface SkillMeta {
  id: string;
  name: string;
  description: string;
}

export interface ProviderTool {
  plugin_id: string;
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  /** Source plugin type — populated by getProviderTools() for pre-inference gating (F6-s4). Optional for backward compat. */
  plugin_type?: import('./manifest').PluginType;
}

const execFileAsync = promisify(execFile);

// ── Semver utilities (sin deps externas) ─────────────────────────────────────

const PLATFORM_VERSION = '1.0.0';

function parseSemver(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

/** true si `installed` satisface el requisito mínimo `required` (semver >=). */
function semverGte(installed: string, required: string): boolean {
  const a = parseSemver(installed);
  const b = parseSemver(required);
  if (!a || !b) return true; // si no parsea, no bloquear
  if (a[0] !== b[0]) return a[0] > b[0];
  if (a[1] !== b[1]) return a[1] > b[1];
  return a[2] >= b[2];
}

/** Valida que la versión cumple X.Y.Z y retorna errores de compatibilidad. */
function checkPluginVersion(pluginVersion: string, existingVersion: string | null): string[] {
  const errors: string[] = [];

  if (!parseSemver(pluginVersion)) {
    errors.push(`version '${pluginVersion}' no cumple formato semver X.Y.Z`);
    return errors;
  }

  if (existingVersion) {
    const existing = parseSemver(existingVersion);
    const incoming = parseSemver(pluginVersion);
    if (existing && incoming && incoming[0] !== existing[0]) {
      errors.push(
        `major version mismatch: instalado=${existingVersion} vs nuevo=${pluginVersion}. ` +
          `Los cambios de major version pueden romper compatibilidad. Desinstala el plugin antes de continuar.`,
      );
    }
  }

  return errors;
}

// ── JSON helpers (SQLite stores arrays/objects as strings) ────────────────────
const j = <T>(v: string | null): T | null => {
  if (!v) return null;
  try {
    return JSON.parse(v) as T;
  } catch {
    return null;
  }
};
const s = (v: unknown): string | null => (v != null ? JSON.stringify(v) : null);

// ── F3-s4: Trust Score constants ─────────────────────────────────────────────

/** Penalty applied per warning-severity finding when normalizing scan_result. */
export const PENALTY_PER_WARN = 10;
/** Step applied per net vote when normalizing votes_net → [0,100]. */
export const VOTE_STEP = 5;

/** Default weights used when KV `trust.weights` is absent or invalid. */
const DEFAULT_TRUST_WEIGHTS = { scan: 0.3, smoke: 0.2, reputation: 0.4, votes: 0.1 };
/** Default badge threshold used when KV `trust.badge_threshold` is absent or invalid. */
const DEFAULT_BADGE_THRESHOLD = 80;

export interface TrustScoreInput {
  scan_result: string | null;
  smoke_test_result: string | null;
  reputation_score: number | null;
  votes_net: number;
}

export interface TrustWeights {
  scan: number;
  smoke: number;
  reputation: number;
  votes: number;
}

export interface TrustScoreResult {
  trust_score: number | null;
  badge: boolean;
  breakdown: {
    inputs: {
      scan: number | null;
      smoke: number | null;
      reputation: number | null;
      votes: number;
    };
    weights_used: Partial<TrustWeights>;
    threshold: number;
  };
}

/** Normalize scan_result JSON → [0,100] or null if absent/unparseable. */
function normalizeScan(scanResult: string | null): number | null {
  if (scanResult === null) return null;
  try {
    const parsed = JSON.parse(scanResult) as { findings?: { severity: string }[] };
    const warnCount = (parsed.findings ?? []).filter((f) => f.severity === 'warning').length;
    return Math.max(0, Math.min(100, 100 - PENALTY_PER_WARN * warnCount));
  } catch {
    return null;
  }
}

/** Normalize smoke_test_result JSON → [0,100] or null if absent/unparseable. */
function normalizeSmoke(smokeResult: string | null): number | null {
  if (smokeResult === null) return null;
  try {
    const parsed = JSON.parse(smokeResult) as { result?: string };
    if (parsed.result === 'passed') return 100;
    if (parsed.result === 'inconclusive') return 50;
    if (parsed.result === 'failed') return 0;
    return null; // unrecognized → excluded
  } catch {
    return null;
  }
}

/**
 * F3-s4: Compute a composite trust score from plugin signals.
 *
 * PURE function — no I/O, no DB, no side effects.
 * Takes the plugin row data + parsed KV weights + badge threshold.
 * Returns {trust_score, badge, breakdown}.
 *
 * Formula:
 *   - Normalize each signal to [0,100] (null signals are EXCLUDED).
 *   - votes_net is NEVER excluded (default 0 → neutral 50).
 *   - Re-weight over present signals: denom = Σ weight_i for present i.
 *   - denom <= 0 → trust_score = null.
 *   - raw = Σ (weight_i * nInput_i) / denom.
 *   - trust_score = round(clamp(raw, 0, 100), 1).
 *   - badge = trust_score !== null && trust_score >= threshold.
 */
export function computeTrustScore(
  plugin: TrustScoreInput,
  weights: TrustWeights,
  threshold: number,
): TrustScoreResult {
  // ── Step 1: normalize each signal ──────────────────────────────────────────
  const nScan = normalizeScan(plugin.scan_result);
  const nSmoke = normalizeSmoke(plugin.smoke_test_result);

  const nReputation: number | null = plugin.reputation_score ?? null;

  // votes is NEVER excluded
  const nVotes = Math.max(0, Math.min(100, 50 + VOTE_STEP * plugin.votes_net));

  // ── Step 2: re-weight over present inputs ──────────────────────────────────
  const signalMap: Array<[keyof TrustWeights, number | null]> = [
    ['scan', nScan],
    ['smoke', nSmoke],
    ['reputation', nReputation],
    ['votes', nVotes],
  ];

  let denom = 0;
  let raw = 0;
  const weights_used: Partial<TrustWeights> = {};

  for (const [key, value] of signalMap) {
    if (value !== null && weights[key] > 0) {
      denom += weights[key];
      raw += weights[key] * value;
      weights_used[key] = weights[key];
    }
  }
  // votes always included in inputs but only contributes to denom if weight > 0
  // (already handled above — votes is never null)

  let trust_score: number | null = null;
  if (denom > 0) {
    const clamped = Math.max(0, Math.min(100, raw / denom));
    trust_score = Math.round(clamped * 10) / 10;
  }

  const badge = trust_score !== null && trust_score >= threshold;

  return {
    trust_score,
    badge,
    breakdown: {
      inputs: {
        scan: nScan,
        smoke: nSmoke,
        reputation: nReputation,
        votes: nVotes,
      },
      weights_used,
      threshold,
    },
  };
}

// ── SKILL.md frontmatter parser ───────────────────────────────────────────────
function parseSkillMd(content: string): { name: string; description: string; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(content);
  if (!match) return { name: '', description: '', body: content };
  const fm = match[1];
  const body = match[2].trim();
  const name = /^name:\s*([^\n\r]+)/m.exec(fm)?.[1]?.trim() ?? '';
  const description = /^description:\s*([^\n\r]+)/m.exec(fm)?.[1]?.trim() ?? '';
  return { name, description, body };
}

// ── Hydrated Plugin type ──────────────────────────────────────────────────────
export type HydratedPlugin = Omit<Plugin, 'skills' | 'stack_plugins' | 'symbols' | 'config'> & {
  skills: string[] | null;
  stack_plugins: string[] | null;
  symbols: string[] | null;
  config: Record<string, unknown> | null;
  // F3-s4: trust_score and badge are computed fields; trust_score overwrites the Prisma column
  // to reflect the lazily-computed value. badge is always derived (never persisted separately).
  // badge is optional because it is only present in findAll() and getTrustReport() outputs.
  trust_score: number | null;
  badge?: boolean;
};

function hydrate(p: Plugin): HydratedPlugin {
  return {
    ...p,
    skills: j<string[]>(p.skills),
    stack_plugins: j<string[]>(p.stack_plugins),
    symbols: j<string[]>(p.symbols),
    config: j<Record<string, unknown>>(p.config),
  };
}

/** Gestiona el ciclo de vida completo de los plugins: instalación git, activación/desactivación, config, skills y tools. */
@Injectable()
export class PluginsService implements OnApplicationBootstrap {
  private readonly log = new Logger(PluginsService.name);
  readonly pluginsDir: string;

  constructor(
    readonly db: PrismaService,
    private readonly events: PluginEventsService,
    cfg: ConfigService,
    private readonly kv?: KvService,
    private readonly audit?: AuditService,
    @Optional() private readonly sandbox?: SandboxGateway,
  ) {
    this.pluginsDir = cfg.get<string>('PLUGINS_DIR', path.resolve(process.cwd(), '../../plugins'));
  }

  /**
   * Al arrancar (tras las migraciones), registra en la BD los plugins que viven en
   * el directorio local `plugins/` para que estén disponibles en la UI sin pasar por
   * `git install`. No falla el arranque si el sync no puede completarse.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const { registered, updated } = await this.syncLocalPlugins();
      this.log.log(`Sync de plugins locales: ${registered} nuevos, ${updated} actualizados`);
    } catch (err: unknown) {
      this.log.warn(`Sync de plugins locales falló: ${String(err)}`);
    }
  }

  /**
   * Escanea `pluginsDir` y sincroniza cada manifest válido con la BD: crea los que
   * faltan (inactivos), y actualiza la metadata de los existentes SIN tocar su estado
   * `active` ni su `config` (decisiones del usuario). Devuelve cuántos creó/actualizó.
   */
  async syncLocalPlugins(): Promise<{ registered: number; updated: number }> {
    const records = scanLocalManifests(this.pluginsDir);
    let registered = 0;
    let updated = 0;

    for (const r of records) {
      const existing = await this.db.plugin.findUnique({ where: { id: r.id } });
      if (existing) {
        await this.db.plugin.update({
          where: { id: r.id },
          data: {
            name: r.name,
            description: r.description,
            version: r.version,
            type: r.type,
            author: r.author,
            installed_path: r.installed_path,
          },
        });
        updated++;
      } else {
        await this.db.plugin.create({
          data: {
            id: r.id,
            name: r.name,
            description: r.description,
            version: r.version,
            type: r.type,
            author: r.author,
            active: false,
            source_url: r.installed_path,
            installed_path: r.installed_path,
          },
        });
        this.events.emit('plugin.installed', { plugin_id: r.id, version: r.version });
        registered++;
      }
    }

    return { registered, updated };
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  async findAll(): Promise<HydratedPlugin[]> {
    const rows = await this.db.plugin.findMany({ orderBy: { name: 'asc' } });

    // F3-s4: ONE _readTrustConfig() call for the whole list (never per-plugin)
    const { weights, threshold } = await this._readTrustConfig();

    return rows.map((p) => {
      const hydrated = hydrate(p);
      const { trust_score, badge } = computeTrustScore(
        {
          scan_result: p.scan_result,
          smoke_test_result: p.smoke_test_result,
          reputation_score: p.reputation_score,
          votes_net: p.votes_net,
        },
        weights,
        threshold,
      );
      return { ...hydrated, trust_score, badge };
    });
  }

  async findById(id: string): Promise<HydratedPlugin> {
    const p = await this.db.plugin.findUnique({ where: { id } });
    if (!p) throw new NotFoundException(`Plugin '${id}' no encontrado`);
    return hydrate(p);
  }

  async findActive(): Promise<HydratedPlugin[]> {
    return (await this.db.plugin.findMany({ where: { active: true } })).map(hydrate);
  }

  async isExtraActive(id: string): Promise<boolean> {
    return (await this.db.plugin.findFirst({ where: { id, active: true, type: 'extra' } })) != null;
  }

  // ── Manifest ──────────────────────────────────────────────────────────────

  /** Lee el manifest.toml del directorio instalado de un plugin. */
  getManifest(installedPath: string | null): PluginManifest | null {
    if (!installedPath) return null;
    return readManifest(installedPath);
  }

  /** Devuelve el config schema del plugin (de manifest.toml [config]). */
  async getConfigSchema(id: string): Promise<Record<string, ConfigFieldSpec> | null> {
    const p = await this.findById(id);
    const manifest = this.getManifest(p.installed_path);
    return manifest?.config ?? null;
  }

  /** Devuelve las credenciales requeridas por el plugin (de manifest.toml [credentials]). */
  async getCredentialSpecs(id: string) {
    const p = await this.findById(id);
    const manifest = this.getManifest(p.installed_path);
    return manifest?.credentials ?? null;
  }

  // ── Skills (SKILL.md) ─────────────────────────────────────────────────────

  /** Devuelve nombre y descripción de todos los plugins tipo skill activos (desde manifest.toml o SKILL.md). */
  async getSkillsMetadata(): Promise<SkillMeta[]> {
    const plugins = await this.db.plugin.findMany({
      where: { active: true, type: 'skill' },
      orderBy: { name: 'asc' },
    });
    return plugins.map((plugin) => {
      // Preferencia: manifest.toml > SKILL.md frontmatter > nombre del plugin
      const manifest = this.getManifest(plugin.installed_path);
      const skillMd = plugin.installed_path ? this.tryReadSkillMd(plugin.installed_path) : null;
      return {
        id: plugin.id,
        name: manifest?.plugin.name ?? skillMd?.name ?? plugin.name,
        description:
          manifest?.plugin.description ?? skillMd?.description ?? plugin.description ?? '',
      };
    });
  }

  /** Carga el cuerpo (sin frontmatter) del SKILL.md de un skill activo por nombre. */
  async loadSkillContent(skillName: string): Promise<string | null> {
    const plugin = await this.db.plugin.findFirst({
      where: { active: true, type: 'skill', name: skillName },
    });
    if (!plugin?.installed_path) return null;
    const skillMd = this.tryReadSkillMd(plugin.installed_path);
    return skillMd?.body ?? null;
  }

  async loadSkillResource(skillName: string, resourceFile: string): Promise<string | null> {
    const plugin = await this.db.plugin.findFirst({
      where: { active: true, type: 'skill', name: skillName },
    });
    if (!plugin?.installed_path) return null;
    const safe = path.basename(resourceFile); // no path traversal
    try {
      return fs.readFileSync(path.join(plugin.installed_path, safe), 'utf8');
    } catch {
      return null;
    }
  }

  // ── Provider tools (tools.json) ───────────────────────────────────────────

  /** Agrega los tools declarados en tools.json de todos los plugins activos. */
  async getProviderTools(): Promise<ProviderTool[]> {
    const plugins = await this.db.plugin.findMany({ where: { active: true } });
    const tools: ProviderTool[] = [];
    for (const plugin of plugins) {
      if (!plugin.installed_path) continue;
      const toolsPath = path.join(plugin.installed_path, 'tools.json');
      try {
        const defs = JSON.parse(fs.readFileSync(toolsPath, 'utf8')) as {
          name: string;
          description: string;
          parameters?: Record<string, unknown>;
          input_schema?: Record<string, unknown>;
        }[];
        for (const def of defs) {
          tools.push({
            plugin_id: plugin.id,
            name: `${plugin.id}__${def.name}`,
            description: def.description,
            // Soporta tanto 'parameters' (JSON Schema estándar) como 'input_schema' (legado)
            input_schema: (def.parameters ??
              def.input_schema ?? {
                type: 'object',
                properties: {},
              }) as ProviderTool['input_schema'],
            // F6-s4: carry plugin type so _computeVisibleTools can gate by plugin_type without DB query
            plugin_type: plugin.type as import('./manifest').PluginType,
          });
        }
      } catch {
        /* plugin no declara tools */
      }
    }
    return tools;
  }

  /**
   * Returns the decision prompt from the single active plugin that declares a [decision] manifest
   * section. Behavior:
   *   - 0 active decision plugins → null (no log)
   *   - 1 active decision plugin  → prompt string verbatim (prompt wins over prompt_file)
   *   - >1 active decision plugins → null + Logger.error("[CRITICAL] ...")
   * Never throws.
   */
  async getActiveDecisionPrompt(): Promise<string | null> {
    try {
      const active = await this.findActive();
      const decisionPlugins = active.filter((p) => {
        const manifest = this.getManifest(p.installed_path);
        return manifest?.decision && (manifest.decision.prompt || manifest.decision.prompt_file);
      });

      if (decisionPlugins.length === 0) return null;

      if (decisionPlugins.length > 1) {
        const ids = decisionPlugins.map((p) => p.id).join(', ');
        this.log.error(
          `[CRITICAL] multiple decision plugins active: ${ids}. No decision prompt injected this cycle.`,
        );
        return null;
      }

      // Exactly one.
      const plugin = decisionPlugins[0];
      const manifest = this.getManifest(plugin.installed_path)!;
      const decision = manifest.decision!;

      if (decision.prompt) return decision.prompt;

      if (decision.prompt_file && plugin.installed_path) {
        const safeName = path.basename(decision.prompt_file);
        try {
          return fs.readFileSync(path.join(plugin.installed_path, safeName), 'utf8');
        } catch {
          return null;
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Returns the reflection policy prompt from the single active plugin that declares a
   * [reflection] manifest section. Behavior mirrors getActiveDecisionPrompt:
   *   - 0 active reflection plugins → null (no log; reflection is a no-op)
   *   - 1 active reflection plugin  → prompt string verbatim (prompt wins over prompt_file)
   *   - >1 active reflection plugins → null + Logger.error("[CRITICAL] ...")
   * Never throws.
   */
  async getActiveReflectionPrompt(): Promise<string | null> {
    try {
      const active = await this.findActive();
      const reflectionPlugins = active.filter((p) => {
        const manifest = this.getManifest(p.installed_path);
        return (
          manifest?.reflection && (manifest.reflection.prompt || manifest.reflection.prompt_file)
        );
      });

      if (reflectionPlugins.length === 0) return null;

      if (reflectionPlugins.length > 1) {
        const ids = reflectionPlugins.map((p) => p.id).join(', ');
        this.log.error(
          `[CRITICAL] multiple reflection plugins active: ${ids}. No reflection prompt injected this turn.`,
        );
        return null;
      }

      // Exactly one.
      const plugin = reflectionPlugins[0];
      const manifest = this.getManifest(plugin.installed_path)!;
      const reflection = manifest.reflection!;

      if (reflection.prompt) return reflection.prompt;

      if (reflection.prompt_file && plugin.installed_path) {
        const safeName = path.basename(reflection.prompt_file);
        try {
          return fs.readFileSync(path.join(plugin.installed_path, safeName), 'utf8');
        } catch {
          return null;
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Returns debate roles from the single active plugin that declares a [debate] manifest
   * section. Behavior mirrors getActiveReflectionPrompt:
   *   - 0 active debate plugins → null (no log)
   *   - 1 active debate plugin  → DebateRole[] (inline prompt wins over prompt_file)
   *   - >1 active debate plugins → null + Logger.error("[CRITICAL] ...")
   * Never throws.
   */
  async getActiveDebateRoles(): Promise<DebateRole[] | null> {
    try {
      const active = await this.findActive();
      const debatePlugins = active.filter((p) => {
        const manifest = this.getManifest(p.installed_path);
        return (
          manifest?.debate &&
          Array.isArray(manifest.debate.roles) &&
          manifest.debate.roles.length > 0
        );
      });

      if (debatePlugins.length === 0) return null;

      if (debatePlugins.length > 1) {
        const ids = debatePlugins.map((p) => p.id).join(', ');
        this.log.error(
          `[CRITICAL] multiple debate plugins active: ${ids}. No debate roles injected this cycle.`,
        );
        return null;
      }

      // Exactly one.
      const plugin = debatePlugins[0];
      const manifest = this.getManifest(plugin.installed_path)!;
      const rawRoles = manifest.debate!.roles;

      const roles: DebateRole[] = rawRoles.map((r) => {
        if (r.prompt) {
          // Inline prompt wins
          return { name: r.name, prompt: r.prompt, block: r.block };
        }
        if (r.prompt_file && plugin.installed_path) {
          const safeName = path.basename(r.prompt_file);
          try {
            const prompt = fs.readFileSync(path.join(plugin.installed_path, safeName), 'utf8');
            return { name: r.name, prompt, block: r.block };
          } catch {
            return { name: r.name, block: r.block };
          }
        }
        return { name: r.name, block: r.block };
      });

      return roles;
    } catch {
      return null;
    }
  }

  /** Devuelve los tools.json de un plugin específico. */
  async getPluginTools(id: string): Promise<ProviderTool[]> {
    const p = await this.findById(id);
    if (!p.installed_path) return [];
    const toolsPath = path.join(p.installed_path, 'tools.json');
    try {
      const defs = JSON.parse(fs.readFileSync(toolsPath, 'utf8')) as {
        name: string;
        description: string;
        parameters?: Record<string, unknown>;
        input_schema?: Record<string, unknown>;
      }[];
      return defs.map((def) => ({
        plugin_id: p.id,
        name: def.name,
        description: def.description,
        input_schema: (def.parameters ??
          def.input_schema ?? { type: 'object', properties: {} }) as ProviderTool['input_schema'],
      }));
    } catch {
      return [];
    }
  }

  /** Fusiona config parcial sobre la existente (sin reemplazar campos no enviados). */
  async mergeConfig(id: string, patch: Record<string, unknown>): Promise<HydratedPlugin> {
    const p = await this.findById(id);
    const existing = p.config ?? {};
    const merged = { ...existing, ...patch };
    return this.setConfig(id, merged);
  }

  // ── Symbols ───────────────────────────────────────────────────────────────

  /** Devuelve los símbolos de todos los plugins tipo universe activos. */
  async getActiveSymbols(): Promise<string[]> {
    const rows = await this.db.plugin.findMany({ where: { active: true, type: 'universe' } });
    return rows.flatMap((p) => j<string[]>(p.symbols) ?? []);
  }

  // ── Mutations ─────────────────────────────────────────────────────────────

  async activate(id: string): Promise<HydratedPlugin> {
    const p = await this.findById(id);
    const manifest = this.getManifest(p.installed_path);

    // Dependencias declaradas en manifest: `requires = ["data-quality"]` (cualquier tipo de plugin)
    // Stacks también usan `stack.requires` para sus componentes
    const manifestRequires: string[] =
      ((manifest as unknown as Record<string, unknown>)?.['requires'] as string[]) ?? [];
    const stackRequires: string[] =
      p.type === 'stack' ? (manifest?.stack?.requires ?? p.stack_plugins ?? []) : [];

    const allRequires = [...new Set([...manifestRequires, ...stackRequires])];
    const missing: string[] = [];

    for (const dep of allRequires) {
      const depId = dep.replace(/@[^@]*$/, '');
      const found = await this.db.plugin.findFirst({ where: { id: depId, active: true } });
      if (!found) missing.push(depId);
    }

    if (missing.length > 0) {
      throw new BadRequestException(
        `El plugin '${id}' requiere que los siguientes plugins estén activos primero: ${missing.join(', ')}`,
      );
    }

    // F3-s2: pre-activation smoke test — WARN-only, NEVER blocks activation
    await this._smokeTestOnActivate(id);

    await this.db.plugin.update({ where: { id }, data: { active: true } });
    this.events.emit('plugin.activated', { plugin_id: id, type: p.type });
    return this.findById(id);
  }

  async deactivate(id: string): Promise<HydratedPlugin> {
    // Comprobar si algún plugin activo depende de éste
    const dependents = await this._findActiveDependents(id);
    if (dependents.length > 0) {
      throw new BadRequestException(
        `No se puede desactivar '${id}': los siguientes plugins dependen de él: ${dependents.join(', ')}. Desactívalos primero.`,
      );
    }
    await this.db.plugin.update({ where: { id }, data: { active: false } });
    this.events.emit('plugin.deactivated', { plugin_id: id });
    return this.findById(id);
  }

  /** Devuelve IDs de plugins activos que dependen del plugin dado. */
  private async _findActiveDependents(id: string): Promise<string[]> {
    const active = await this.db.plugin.findMany({ where: { active: true } });
    const dependents: string[] = [];
    for (const plugin of active) {
      if (plugin.id === id) continue;
      const manifest = this.getManifest(plugin.installed_path);
      const requires: string[] =
        ((manifest as unknown as Record<string, unknown>)?.['requires'] as string[]) ?? [];
      if (requires.some((r) => r.replace(/@[^@]*$/, '') === id)) {
        dependents.push(plugin.id);
      }
    }
    return dependents;
  }

  async remove(id: string): Promise<void> {
    await this.findById(id);
    await this.db.plugin.delete({ where: { id } });
    this.events.emit('plugin.removed', { plugin_id: id });
  }

  async updateVerification(id: string, status: PluginVerification): Promise<HydratedPlugin> {
    await this.findById(id);
    await this.db.plugin.update({ where: { id }, data: { verification: status } });
    return this.findById(id);
  }

  // ── F3-s1: Scan + Trust Report ─────────────────────────────────────────────

  /**
   * Re-runs static AST analysis for an existing plugin and stores the result.
   * Returns the updated plugin record.
   */
  async rescan(id: string): Promise<HydratedPlugin> {
    await this.findById(id); // throws NotFoundException if not found
    if (!this.sandbox) {
      throw new Error('SandboxGateway not available for rescan');
    }
    const scanResponse = await this.sandbox.analyzePlugin(id);
    const scanData =
      scanResponse.ok && scanResponse.result
        ? (scanResponse.result as Record<string, unknown>)
        : { ok: false, error: scanResponse.error, findings: [] };
    await this.db.plugin.update({
      where: { id },
      data: { scan_result: JSON.stringify(scanData) },
    });
    return this.findById(id);
  }

  /**
   * Returns the current trust report for a plugin.
   * F3-s1: scan_result (static AST analysis); F3-s2: smoke_test_result (pre-activation dry-run).
   * F3-s3: reputation_score (composite from gate-ready pretest portfolios; null = unrated).
   * F3-s4: trust_score, badge, content_checksum, breakdown (lazy-computed from persisted signals).
   * null means the corresponding analysis has not been run yet.
   * Opportunistically persists the computed trust_score if it differs from the stored value.
   * The read result is ALWAYS returned regardless of whether the persist succeeds.
   */
  async getTrustReport(id: string): Promise<{
    scan_result: Record<string, unknown> | null;
    smoke_test_result: Record<string, unknown> | null;
    reputation_score: number | null;
    trust_score: number | null;
    badge: boolean;
    content_checksum: string | null;
    breakdown: TrustScoreResult['breakdown'];
  }> {
    const plugin = await this.findById(id);
    const scanRaw = plugin.scan_result ?? null;
    // smoke_test_result is a new F3-s2 column on the Plugin model (String?, nullable JSON)
    const smokeRaw = plugin.smoke_test_result ?? null;

    // F3-s4: Compute trust_score lazily from persisted signals
    const { weights, threshold } = await this._readTrustConfig();
    const trustInput: TrustScoreInput = {
      scan_result: scanRaw,
      smoke_test_result: smokeRaw,
      reputation_score: plugin.reputation_score ?? null,
      votes_net: plugin.votes_net,
    };
    const { trust_score, badge, breakdown } = computeTrustScore(trustInput, weights, threshold);

    // F3-s4: Opportunistically persist if stored trust_score differs from computed (fire-and-forget)
    if (plugin.trust_score !== trust_score) {
      void Promise.resolve(this.db.plugin.update({ where: { id }, data: { trust_score } })).catch(
        (e: unknown) => {
          this.log.warn(
            `trust_score opportunistic persist failed for ${id}: ${(e as Error).message}`,
          );
        },
      );
    }

    return {
      scan_result: scanRaw ? (JSON.parse(scanRaw) as Record<string, unknown>) : null,
      smoke_test_result: smokeRaw ? (JSON.parse(smokeRaw) as Record<string, unknown>) : null,
      reputation_score: plugin.reputation_score ?? null,
      trust_score,
      badge,
      content_checksum: plugin.content_checksum ?? null,
      breakdown,
    };
  }

  /**
   * Returns the persisted reputation score and detail for a plugin.
   * F3-s3: reads the column written by PretestService._recomputePluginReputations.
   * Returns stale (last-persisted) data — score refreshes on next gate passage.
   * Throws NotFoundException when the plugin does not exist.
   */
  async getReputation(id: string): Promise<{
    reputation_score: number | null;
    reputation_detail: Record<string, unknown> | null;
  }> {
    const p = await this.findById(id); // throws 404 if missing
    return {
      reputation_score: p.reputation_score ?? null,
      reputation_detail: p.reputation_detail
        ? (JSON.parse(p.reputation_detail) as Record<string, unknown>)
        : null,
    };
  }

  async setConfig(id: string, config: Record<string, unknown>): Promise<HydratedPlugin> {
    // Valida contra el schema si existe
    const schema = await this.getConfigSchema(id);
    if (schema) {
      const errors = this.validateConfig(config, schema);
      if (errors.length > 0) throw new BadRequestException(`Config inválida: ${errors.join('; ')}`);
    }
    await this.db.plugin.update({ where: { id }, data: { config: s(config) } });
    return this.findById(id);
  }

  // ── Install ───────────────────────────────────────────────────────────────

  async install(source: string): Promise<HydratedPlugin> {
    const isGit = this.isGitUrl(source);
    if (!isGit) {
      throw new BadRequestException('Solo se permiten fuentes git (https:// o git@)');
    }
    const installedPath = path.join(this.pluginsDir, this.deriveId(source));

    // 1. Clonar si es git
    if (isGit) {
      this.log.log(`git clone ${source} → ${installedPath}`);
      await this.gitClone(source, installedPath);
    }

    // 2. Leer manifest.toml (fuente de verdad)
    const manifest = readManifest(installedPath);
    if (manifest) {
      const errors = validateManifest(manifest);
      if (errors.length > 0)
        throw new BadRequestException(`manifest.toml inválido: ${errors.join('; ')}`);
    }

    // 3. Fallback: leer SKILL.md frontmatter si no hay manifest
    const skillMd = !manifest ? this.tryReadSkillMd(installedPath) : null;

    const id = manifest?.plugin.id ?? this.deriveId(source);
    const pluginVersion = manifest?.plugin.version ?? '0.0.0';

    // 4. Semver: versión del plugin debe ser X.Y.Z
    const versionErrors = checkPluginVersion(pluginVersion, null);
    if (versionErrors.length > 0) {
      throw new BadRequestException(`Versión inválida: ${versionErrors.join('; ')}`);
    }

    // 5. min_platform_version: el plugin puede requerir una versión mínima de la plataforma
    const minPlatform = (manifest as { plugin?: { min_platform_version?: string } } | null)?.plugin
      ?.min_platform_version;
    if (minPlatform && !semverGte(PLATFORM_VERSION, minPlatform)) {
      throw new BadRequestException(
        `El plugin '${id}' requiere plataforma ≥ ${minPlatform} (plataforma actual: ${PLATFORM_VERSION})`,
      );
    }

    if (await this.db.plugin.findUnique({ where: { id } })) {
      throw new ConflictException(`Plugin '${id}' ya está instalado`);
    }

    // 4. Construir credenciales y config desde manifest
    const credsSpec = manifest?.credentials
      ? JSON.stringify(
          Object.fromEntries(
            Object.entries(manifest.credentials).map(([env, spec]) => [
              env,
              { label: spec.label, required: spec.required ?? false, group: spec.group ?? '' },
            ]),
          ),
        )
      : null;

    const plugin = await this.db.plugin.create({
      data: {
        id,
        name: manifest?.plugin.name ?? skillMd?.name ?? id,
        description: manifest?.plugin.description ?? skillMd?.description ?? null,
        version: manifest?.plugin.version ?? '0.0.0',
        type: manifest?.plugin.type ?? 'skill',
        active: false,
        source_url: source,
        git_url: isGit ? source : null,
        installed_path: installedPath,
        // Guardamos el spec de credenciales en el campo config
        config: credsSpec
          ? JSON.stringify({ _credential_specs: JSON.parse(credsSpec) as Record<string, unknown> })
          : null,
      },
    });

    // F3-s1: Static AST scan on install — WARN-only, NEVER blocks install
    await this._scanOnInstall(id);

    // F3-s4: Compute + persist content checksum — NEVER blocks install
    let installedPlugin: Plugin = plugin;
    try {
      const checksum = this.computeContentChecksum(installedPath);
      const updated = await this.db.plugin.update({
        where: { id },
        data: { content_checksum: checksum },
      });
      if (updated) installedPlugin = updated;
    } catch (e) {
      this.log.warn(`content_checksum compute failed for ${id}: ${(e as Error).message}`);
    }

    this.events.emit('plugin.installed', { plugin_id: id, version: plugin.version });
    return hydrate(installedPlugin);
  }

  async update(id: string): Promise<{ ok: boolean; output: string }> {
    const p = await this.findById(id);
    if (!p.git_url || !p.installed_path) {
      throw new BadRequestException(`Plugin '${id}' no fue instalado desde git`);
    }
    const { stdout, stderr } = await execFileAsync('git', ['-C', p.installed_path, 'pull']).catch(
      (e) => ({
        stdout: '',
        stderr: (e as Error).message,
      }),
    );
    // Refresca nombre/versión desde manifest tras el pull
    const manifest = readManifest(p.installed_path);
    if (manifest) {
      // Semver: verificar major version no cambió (breaking change)
      const vErrors = checkPluginVersion(manifest.plugin.version, p.version);
      if (vErrors.length > 0) {
        this.log.warn(`Plugin '${id}' update abortado: ${vErrors.join('; ')}`);
        return { ok: false, output: vErrors.join('; ') };
      }
      await this.db.plugin.update({
        where: { id },
        data: { name: manifest.plugin.name, version: manifest.plugin.version },
      });
    }

    // F3-s4: Recompute content checksum + emit audit on change — NEVER blocks update
    try {
      const prevChecksum = p.content_checksum ?? null;
      const nextChecksum = this.computeContentChecksum(p.installed_path);
      if (prevChecksum !== null && prevChecksum !== nextChecksum) {
        await this.audit?.log({
          event_type: 'plugin_content_changed',
          plugin_id: id,
          meta: { old: prevChecksum, new: nextChecksum },
        });
        this.log.warn(`Plugin '${id}' content changed: checksum ${prevChecksum} → ${nextChecksum}`);
      }
      await this.db.plugin.update({
        where: { id },
        data: { content_checksum: nextChecksum },
      });
    } catch (e) {
      this.log.warn(`content_checksum recompute failed for ${id}: ${(e as Error).message}`);
    }

    return { ok: !stderr.includes('error'), output: stdout || stderr };
  }

  // ── write_skill (learning loop) ───────────────────────────────────────────

  /**
   * Guarded write path for the LLM learning loop. Enforces allowlist, diff-cap,
   * KV snapshot (BEFORE write), and emits audit events. This is the only method
   * the kernel tool or REST endpoints should call — never writeSkillContent directly.
   */
  async writeSkillGuarded(
    skillName: string,
    newBody: string,
    opts?: { minLen?: number; maxRatio?: number },
  ): Promise<WriteSkillResult> {
    const minLen = opts?.minLen ?? 50;
    const maxRatio = opts?.maxRatio ?? 0.5;

    // 1. Resolve active skill plugin
    const plugin = await this.db.plugin.findFirst({
      where: { active: true, type: 'skill', name: skillName },
    });
    if (!plugin?.installed_path) {
      return { ok: false, reason: 'not_found' };
    }

    // 2. Allowlist gate: require llm_writable === true
    const manifest = this.getManifest(plugin.installed_path);
    if (manifest?.plugin.llm_writable !== true) {
      await this.audit?.log({
        event_type: 'skill_write_denied',
        plugin_id: plugin.id,
        meta: { skill: skillName, reason: 'not_writable' },
      });
      return { ok: false, reason: 'not_writable' };
    }

    // 3. Read current body
    const currentBody = await this.loadSkillContent(skillName);
    const oldLen = currentBody?.length ?? 0;
    const newLen = newBody.trim().length;

    // 4. Diff-cap: absolute floor + relative delta cap.
    // NOTE: The length-ratio cap does NOT catch same-length full rewrites (e.g. a body
    // that is the same length but completely different content). This is a known limitation
    // compensated by the snapshot+revert+audit trail: any bad write is recoverable via
    // revertSkill, and every write is audited. Full-content diff (e.g. Levenshtein ratio)
    // is a future hardening option if the threat model requires it.
    const floorViolation = newLen < minLen;
    const ratioViolation = oldLen > 0 && Math.abs(newLen - oldLen) / oldLen > maxRatio;
    if (floorViolation || ratioViolation) {
      await this.audit?.log({
        event_type: 'skill_write_denied',
        plugin_id: plugin.id,
        meta: { skill: skillName, reason: 'diff_too_large', old_len: oldLen, new_len: newLen },
      });
      return { ok: false, reason: 'diff_too_large' };
    }

    // 5. Snapshot current body to KV BEFORE write (FIFO cap=5)
    if (!this.kv) {
      this.log.warn(
        `writeSkillGuarded: KvService is undefined — snapshot and revert unavailable for '${skillName}'. Check KvService provider configuration.`,
      );
    }
    const snapshotKey = `skill_snapshot:${skillName}`;
    const raw = (await this.kv?.get(snapshotKey)) ?? null;
    let arr: string[];
    try {
      arr = raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      arr = [];
    }
    arr.push(currentBody ?? '');
    if (arr.length > 5) arr.shift();
    await this.kv?.set(snapshotKey, JSON.stringify(arr));

    // 6. Write new body
    const written = await this.writeSkillContent(skillName, newBody);
    if (!written) {
      return { ok: false, reason: 'write_failed' };
    }

    // 7. Audit skill_written
    await this.audit?.log({
      event_type: 'skill_written',
      plugin_id: plugin.id,
      meta: { skill: skillName, old_len: oldLen, new_len: newLen },
    });

    return { ok: true, old_len: oldLen, new_len: newLen };
  }

  /**
   * Restores the most recent KV snapshot for a skill. Bypasses diff-cap — revert
   * always restores a body that the kernel previously persisted.
   */
  async revertSkill(
    skillName: string,
  ): Promise<{ ok: boolean; reason?: 'no_snapshot' | 'not_found' | 'not_writable' }> {
    // Allowlist gate (fail-closed): only llm_writable:true skills may be reverted.
    // Revert restores a body the kernel previously wrote; it still modifies a skill file,
    // so the same opt-in check applies.
    const pluginForCheck = await this.db.plugin.findFirst({
      where: { active: true, type: 'skill', name: skillName },
    });
    if (pluginForCheck?.installed_path) {
      const manifest = this.getManifest(pluginForCheck.installed_path);
      if (manifest?.plugin.llm_writable !== true) {
        await this.audit?.log({
          event_type: 'skill_write_denied',
          plugin_id: pluginForCheck.id,
          meta: { skill: skillName, reason: 'not_writable', op: 'revert' },
        });
        return { ok: false, reason: 'not_writable' };
      }
    }

    const snapshotKey = `skill_snapshot:${skillName}`;
    const raw = (await this.kv?.get(snapshotKey)) ?? null;
    let arr: string[];
    try {
      arr = raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      arr = [];
    }

    if (arr.length === 0) {
      return { ok: false, reason: 'no_snapshot' };
    }

    const body = arr.pop()!;
    await this.kv?.set(snapshotKey, JSON.stringify(arr));

    const written = await this.writeSkillContent(skillName, body);
    if (!written) {
      return { ok: false, reason: 'not_found' };
    }

    // Resolve plugin_id for audit (best-effort, non-blocking)
    const plugin = await this.db.plugin.findFirst({
      where: { active: true, type: 'skill', name: skillName },
    });
    await this.audit?.log({
      event_type: 'skill_reverted',
      plugin_id: plugin?.id,
      meta: { skill: skillName, restored_len: body.length },
    });

    return { ok: true };
  }

  /** Actualiza el cuerpo del SKILL.md de un skill activo preservando el frontmatter (learning loop). */
  async writeSkillContent(skillName: string, newBody: string): Promise<boolean> {
    const plugin = await this.db.plugin.findFirst({
      where: { active: true, type: 'skill', name: skillName },
    });
    if (!plugin?.installed_path) return false;
    const skillMdPath = path.join(plugin.installed_path, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) return false;
    const existing = fs.readFileSync(skillMdPath, 'utf8');
    const fmMatch = /^(---\n[\s\S]*?\n---\n?)/.exec(existing);
    const frontmatter = fmMatch ? fmMatch[1] : '';
    fs.writeFileSync(skillMdPath, `${frontmatter}\n${newBody.trim()}\n`, 'utf8');
    this.log.log(`SKILL.md de '${skillName}' actualizado (learning loop)`);
    return true;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * F3-s2: Runs pre-activation smoke test and stores the result.
   * WARN-only — NEVER throws or blocks activation.
   * Two distinct try/catch blocks so a DB persistence failure does not mask
   * a real smoke failure and vice-versa.
   */
  private async _smokeTestOnActivate(pluginId: string): Promise<void> {
    if (!this.sandbox) return;

    let data: Record<string, unknown> | undefined;
    try {
      const res = await this.sandbox.smokeTestPlugin(pluginId);
      data =
        res.ok && res.result
          ? (res.result as Record<string, unknown>)
          : { ok: false, result: 'inconclusive', error: res.error, checks: [] };
    } catch (e) {
      this.log.warn(`smoke test failed for ${pluginId}: ${(e as Error).message}`); // activation still proceeds
      return;
    }

    try {
      await this.db.plugin.update({
        where: { id: pluginId },
        data: { smoke_test_result: JSON.stringify(data) },
      });
    } catch (e) {
      this.log.warn(`smoke_test_result persist failed for ${pluginId}: ${(e as Error).message}`); // activation still proceeds
    }
  }

  /** F3-s1: Runs static AST scan after install. NEVER throws — scan_result stays null on error. */
  private async _scanOnInstall(pluginId: string): Promise<void> {
    if (!this.sandbox) return;
    try {
      const scanResponse = await this.sandbox.analyzePlugin(pluginId);
      const scanData =
        scanResponse.ok && scanResponse.result
          ? (scanResponse.result as Record<string, unknown>)
          : { ok: false, error: scanResponse.error, findings: [] };
      await this.db.plugin.update({
        where: { id: pluginId },
        data: { scan_result: JSON.stringify(scanData) },
      });
    } catch (e) {
      this.log.warn(`scan failed for ${pluginId}: ${(e as Error).message}`);
    }
  }

  /**
   * F3-s4: Reads trust-score config from KV.
   * Fail-safe: any missing/malformed key → defaults. Never throws.
   * Mirrors the _readGateThresholds pattern from pretest.service.ts.
   */
  async _readTrustConfig(): Promise<{ weights: TrustWeights; threshold: number }> {
    const parseNum = (raw: string | null, fallback: number): number => {
      if (raw === null) return fallback;
      const n = Number(raw);
      return isFinite(n) ? n : fallback;
    };

    const [rawWeights, rawThreshold] = await Promise.all([
      this.kv?.get('trust.weights') ?? Promise.resolve(null),
      this.kv?.get('trust.badge_threshold') ?? Promise.resolve(null),
    ]);

    // Parse weights: must be a non-null object with numeric values; negatives → 0; all-zero → defaults
    let weights: TrustWeights = { ...DEFAULT_TRUST_WEIGHTS };
    if (rawWeights !== null) {
      try {
        const parsed: unknown = JSON.parse(rawWeights);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const obj = parsed as Record<string, unknown>;
          const coerce = (key: keyof TrustWeights): number => {
            const v = Number(obj[key]);
            if (!isFinite(v)) return 0;
            return v < 0 ? 0 : v;
          };
          const w: TrustWeights = {
            scan: coerce('scan'),
            smoke: coerce('smoke'),
            reputation: coerce('reputation'),
            votes: coerce('votes'),
          };
          const total = w.scan + w.smoke + w.reputation + w.votes;
          weights = total > 0 ? w : { ...DEFAULT_TRUST_WEIGHTS };
        }
      } catch {
        // parse fail → defaults already set
      }
    }

    // Parse threshold: numeric, clamped to [0, 100]
    const rawNum = parseNum(rawThreshold, DEFAULT_BADGE_THRESHOLD);
    const threshold = Math.max(0, Math.min(100, rawNum));

    return { weights, threshold };
  }

  /**
   * F3-s4: Computes SHA-256 checksum over plugin content files in stable order.
   * Files covered: manifest.toml, plugin.py, hooks/*.py (sorted lexicographically).
   * Missing files are silently skipped (not an error).
   * Returns null if installedPath is null/undefined or no covered files exist.
   */
  computeContentChecksum(installedPath: string | null | undefined): string | null {
    if (!installedPath) return null;

    const h = crypto.createHash('sha256');
    let parts = 0;

    const tryAppend = (rel: string): void => {
      const full = path.join(installedPath, rel);
      try {
        if (!fs.existsSync(full)) return;
        const bytes = fs.readFileSync(full, 'utf8');
        h.update(rel + '\0' + bytes + '\0');
        parts++;
      } catch {
        // skip unreadable file
      }
    };

    // Fixed files first (manifest then plugin)
    for (const rel of ['manifest.toml', 'plugin.py']) {
      tryAppend(rel);
    }

    // hooks/*.py sorted lexicographically
    const hooksDir = path.join(installedPath, 'hooks');
    try {
      if (fs.existsSync(hooksDir)) {
        const hookFiles = fs
          .readdirSync(hooksDir)
          .filter((f) => f.endsWith('.py'))
          .sort((a, b) => a.localeCompare(b));
        for (const f of hookFiles) {
          tryAppend(path.join('hooks', f));
        }
      }
    } catch {
      // hooks dir unreadable → skip
    }

    return parts > 0 ? h.digest('hex') : null;
  }

  private tryReadSkillMd(
    installedPath: string,
  ): { name: string; description: string; body: string } | null {
    const p = path.join(installedPath, 'SKILL.md');
    try {
      return parseSkillMd(fs.readFileSync(p, 'utf8'));
    } catch {
      return null;
    }
  }

  private validateConfig(
    config: Record<string, unknown>,
    schema: Record<string, ConfigFieldSpec>,
  ): string[] {
    const errors: string[] = [];
    for (const [key, spec] of Object.entries(schema)) {
      const val = config[key];
      if (val === undefined) continue;
      errors.push(...this.validateField(key, val, spec));
    }
    return errors;
  }

  private validateField(key: string, val: unknown, spec: ConfigFieldSpec): string[] {
    const errors: string[] = [];
    if (spec.type === 'number' && typeof val !== 'number') errors.push(`${key}: debe ser número`);
    if (spec.type === 'string' && typeof val !== 'string') errors.push(`${key}: debe ser string`);
    if (spec.type === 'boolean' && typeof val !== 'boolean')
      errors.push(`${key}: debe ser boolean`);
    if (spec.enum && !spec.enum.includes(val as string)) {
      errors.push(`${key}: debe ser uno de [${spec.enum.join(', ')}]`);
    }
    if (spec.min !== undefined && typeof val === 'number' && val < spec.min) {
      errors.push(`${key}: mínimo ${spec.min}`);
    }
    if (spec.max !== undefined && typeof val === 'number' && val > spec.max) {
      errors.push(`${key}: máximo ${spec.max}`);
    }
    return errors;
  }

  private isGitUrl(source: string): boolean {
    return source.startsWith('https://') || source.startsWith('git@') || source.endsWith('.git');
  }

  private deriveId(source: string): string {
    return (
      source
        .split('/')
        .pop()
        ?.replace(/(?:\.tar)?\.(?:git|zip|gz)$/, '') ?? source
    );
  }

  private async gitClone(url: string, dest: string): Promise<void> {
    if (!fs.existsSync(this.pluginsDir)) fs.mkdirSync(this.pluginsDir, { recursive: true });
    await execFileAsync('git', ['clone', '--depth', '1', url, dest]);
  }
}
