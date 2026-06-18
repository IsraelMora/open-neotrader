import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface ProviderDef {
  env: string;
  label: string;
  grupo: string;
  nota: string;
}

export interface CredentialRow extends ProviderDef {
  estado: 'configurada' | 'ausente';
  hint: string;
  origen: '.env' | 'entorno' | '';
  plugin_id?: string;
}

/** Credenciales de la plataforma — LLM y notificaciones solamente.
 *  Las credenciales de brokers y proveedores de datos vienen de sus plugins. */
const PLATFORM_PROVIDERS: ProviderDef[] = [
  {
    env: 'ANTHROPIC_API_KEY',
    label: 'Anthropic — API key',
    grupo: 'llm',
    nota: 'requerida si no usas el plugin claude-subscription',
  },
  { env: 'GEMINI_API_KEY', label: 'Google Gemini — API key', grupo: 'llm', nota: '' },
  { env: 'OPENAI_API_KEY', label: 'OpenAI — API key', grupo: 'llm', nota: '' },
  { env: 'TELEGRAM_BOT_TOKEN', label: 'Telegram — Bot token', grupo: 'notificaciones', nota: '' },
  { env: 'TELEGRAM_CHAT_ID', label: 'Telegram — Chat ID', grupo: 'notificaciones', nota: '' },
];

@Injectable()
export class CredentialsService {
  private readonly envPath: string;

  constructor(
    cfg: ConfigService,
    private readonly db: PrismaService,
  ) {
    this.envPath = cfg.get<string>('DOTENV_PATH', path.resolve(process.cwd(), '.env'));
  }

  async list(): Promise<{ providers: CredentialRow[]; plugin_providers: CredentialRow[] }> {
    const fromFile = this.readEnvFile();

    const toRow = (p: ProviderDef, pluginId?: string): CredentialRow => {
      const inFile = fromFile[p.env];
      const inEnv = process.env[p.env];
      const value = inFile ?? inEnv ?? '';
      return {
        ...p,
        estado: value ? 'configurada' : 'ausente',
        hint: value ? this.mask(value) : '',
        origen: this.resolveOrigen(inFile, inEnv),
        ...(pluginId ? { plugin_id: pluginId } : {}),
      };
    };

    const providers = PLATFORM_PROVIDERS.map((p) => toRow(p));
    const plugin_providers = await this.listFromPlugins(fromFile);

    return { providers, plugin_providers };
  }

  private resolveOrigen(
    inFile: string | undefined,
    inEnv: string | undefined,
  ): '.env' | 'entorno' | '' {
    if (inFile) return '.env';
    if (inEnv) return 'entorno';
    return '';
  }

  /** Lee los [credentials] de cada plugin provider/extra activo de la BD. */
  private async listFromPlugins(fromFile: Record<string, string>): Promise<CredentialRow[]> {
    const plugins = await this.db.plugin.findMany({
      where: { active: true, type: { in: ['provider', 'extra'] } },
    });

    const rows: CredentialRow[] = [];
    for (const plugin of plugins) {
      const pluginRows = this.extractPluginCredentialRows(plugin, fromFile);
      rows.push(...pluginRows);
    }
    return rows;
  }

  private extractPluginCredentialRows(
    plugin: { id: string; name: string; config: string | null },
    fromFile: Record<string, string>,
  ): CredentialRow[] {
    if (!plugin.config) return [];
    let cfg: Record<string, unknown>;
    try {
      cfg = JSON.parse(plugin.config) as Record<string, unknown>;
    } catch {
      return [];
    }
    const creds = cfg['credentials'] as
      | Record<string, { label?: string; nota?: string }>
      | undefined;
    if (!creds) return [];

    return Object.entries(creds).map(([env, meta]) => {
      const inFile = fromFile[env];
      const inEnv = process.env[env];
      const value = inFile ?? inEnv ?? '';
      return {
        env,
        label: meta.label ?? env,
        grupo: plugin.name,
        nota: meta.nota ?? '',
        estado: value ? ('configurada' as const) : ('ausente' as const),
        hint: value ? this.mask(value) : '',
        origen: this.resolveOrigen(inFile, inEnv),
        plugin_id: plugin.id,
      };
    });
  }

  set(env: string, value: string | null | undefined): void {
    const trimmed = (value ?? '').trim();
    if (trimmed && /[\r\n]/.test(trimmed)) {
      throw new BadRequestException('el valor no puede contener saltos de línea');
    }

    const knownEnvs = new Set([...PLATFORM_PROVIDERS.map((p) => p.env)]);
    if (!knownEnvs.has(env) && !this.isDynamicEnv(env)) {
      throw new BadRequestException(`clave no gestionable: ${JSON.stringify(env)}`);
    }

    const lines = this.readEnvLines().filter((l) => !l.trimStart().startsWith(`${env}=`));
    if (trimmed) lines.push(`${env}=${trimmed}`);
    this.writeEnvFile(lines);

    if (trimmed) process.env[env] = trimmed;
    else delete process.env[env];
  }

  private static readonly PROTECTED_ENV_KEYS = new Set([
    'JWT_SECRET',
    'DATABASE_URL',
    'NODE_ENV',
    'API_PORT',
    'API_HOST',
    'WS_PORT',
    'BACKUP_DIR',
    'DOTENV_PATH',
    'CORS_ORIGINS',
  ]);

  /** Acepta cualquier clave UPPER_SNAKE_CASE que no sea sensible del sistema. */
  private isDynamicEnv(env: string): boolean {
    return /^[A-Z][A-Z0-9_]*$/.test(env) && !CredentialsService.PROTECTED_ENV_KEYS.has(env);
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private mask(v: string): string {
    return v.length >= 8 ? `…${v.slice(-4)}` : '…';
  }

  private readEnvLines(): string[] {
    try {
      return fs.readFileSync(this.envPath, 'utf8').split(os.EOL);
    } catch {
      return [];
    }
  }

  private readEnvFile(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of this.readEnvLines()) {
      if (!line.includes('=') || line.trimStart().startsWith('#')) continue;
      const idx = line.indexOf('=');
      const k = line.slice(0, idx).trim();
      const v = line
        .slice(idx + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
      out[k] = v;
    }
    return out;
  }

  private writeEnvFile(lines: string[]): void {
    const content = lines.join('\n') + (lines.length ? '\n' : '');
    fs.writeFileSync(this.envPath, content, { encoding: 'utf8', mode: 0o600 });
  }
}
