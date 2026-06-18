import { parse } from 'smol-toml';
import * as fs from 'fs';
import * as path from 'path';

// ── Plugin types ──────────────────────────────────────────────────────────────

export type PluginType = 'skill' | 'provider' | 'discipline' | 'universe' | 'stack' | 'extra';

/** Especificación de una credencial requerida por el plugin (nombre, si es obligatoria, grupo). */
export interface CredentialSpec {
  label: string;
  required?: boolean;
  group?: string;
  description?: string;
}

/** Especificación de un campo de configuración del plugin con tipo, rango y valores permitidos. */
export interface ConfigFieldSpec {
  type: 'string' | 'number' | 'boolean' | 'array';
  label?: string;
  description?: string;
  default?: unknown;
  enum?: string[];
  min?: number;
  max?: number;
  items?: { type: string };
}

export interface ToolSpec {
  name: string;
  description: string;
}

export interface HooksSpec {
  on_activate?: string;
  on_deactivate?: string;
  on_cycle?: string;
  on_signal?: string;
}

export interface PermissionsSpec {
  network?: boolean;
  write_config?: boolean;
  emit_events?: boolean;
}

export interface StackSpec {
  requires?: string[];
}

/** Estructura completa del manifest.toml de un plugin: identidad, credentials, config, hooks y permisos. */
export interface PluginManifest {
  plugin: {
    id: string;
    name: string;
    version: string;
    type: PluginType;
    description?: string;
    author?: string;
    license?: string;
    repository?: string;
    min_platform_version?: string;
  };
  tools?: ToolSpec[];
  credentials?: Record<string, CredentialSpec>;
  config?: Record<string, ConfigFieldSpec>;
  hooks?: HooksSpec;
  permissions?: PermissionsSpec;
  stack?: StackSpec;
}

// ── Parser ─────────────────────────────────────────────────────────────────────

/** Lee y parsea el manifest.toml desde el directorio instalado del plugin. Devuelve null si no existe o es inválido. */
export function readManifest(pluginDir: string): PluginManifest | null {
  const manifestPath = path.join(pluginDir, 'manifest.toml');
  try {
    const content = fs.readFileSync(manifestPath, 'utf8');
    return parse(content) as unknown as PluginManifest;
  } catch {
    return null;
  }
}

/** Valida los campos obligatorios y el formato del manifest. Devuelve lista de errores (vacía si es válido). */
export function validateManifest(m: PluginManifest): string[] {
  const errors: string[] = [];
  if (!m.plugin?.id) errors.push('plugin.id es obligatorio');
  if (!m.plugin?.name) errors.push('plugin.name es obligatorio');
  if (!m.plugin?.version) errors.push('plugin.version es obligatorio (semver)');
  if (!m.plugin?.type) errors.push('plugin.type es obligatorio');
  const valid: PluginType[] = ['skill', 'provider', 'discipline', 'universe', 'stack', 'extra'];
  if (m.plugin?.type && !valid.includes(m.plugin.type)) {
    errors.push(`plugin.type debe ser uno de: ${valid.join(', ')}`);
  }
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(m.plugin?.id ?? '')) {
    errors.push('plugin.id debe ser kebab-case (ej. rsi-analysis)');
  }
  return errors;
}
