import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
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
import type { Plugin } from '@prisma/client';

export type { Plugin };
export type PluginVerification = 'unverified' | 'pending' | 'verified' | 'rejected';
export type { PluginType } from './manifest';

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
export class PluginsService {
  private readonly log = new Logger(PluginsService.name);
  readonly pluginsDir: string;

  constructor(
    readonly db: PrismaService,
    private readonly events: PluginEventsService,
    cfg: ConfigService,
  ) {
    this.pluginsDir = cfg.get<string>('PLUGINS_DIR', path.resolve(process.cwd(), '../../plugins'));
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  async findAll(): Promise<HydratedPlugin[]> {
    return (await this.db.plugin.findMany({ orderBy: { name: 'asc' } })).map(hydrate);
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
          });
        }
      } catch {
        /* plugin no declara tools */
      }
    }
    return tools;
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

    this.events.emit('plugin.installed', { plugin_id: id, version: plugin.version });
    return hydrate(plugin);
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
    return { ok: !stderr.includes('error'), output: stdout || stderr };
  }

  // ── write_skill (learning loop) ───────────────────────────────────────────

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
