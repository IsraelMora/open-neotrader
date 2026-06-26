import { parse as parseToml, type TomlTable } from 'smol-toml';

/** Error semántico de validación del manifiesto TOML de un plugin. */
export class ManifestError extends Error {}

const CLASES_ACTIVO = new Set(['equity', 'etf', 'crypto', 'commodity']);
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Representación normalizada de un manifiesto de plugin tras su validación.
 *
 * `payload` contiene el bloque específico del tipo (ej. `[skill]`, `[universe]`).
 * `configSpec` contiene los campos opcionales `fields` y `form` del bloque `[config]`.
 * `raw` es la tabla TOML completa tal como fue parseada.
 */
export interface Manifest {
  id: string;
  name: string;
  type: string;
  version: string;
  author: string;
  description: string;
  repository?: string;
  payload: Record<string, unknown>;
  configSpec: Record<string, unknown>;
  raw: Record<string, unknown>;
}

const REQUIRED_PLUGIN_FIELDS = [
  'id',
  'name',
  'type',
  'version',
  'author',
  'description',
] as const;

function isNonNullObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function requireStringField(
  obj: Record<string, unknown>,
  field: string,
  prefix: string,
): string {
  const val = obj[field];
  if (typeof val !== 'string' || !val.trim()) {
    throw new ManifestError(`${prefix}.${field} requerido`);
  }
  return val;
}

function extractRecord(data: TomlTable): Record<string, unknown> {
  const meta = data['plugin'];
  if (!isNonNullObject(meta)) throw new ManifestError('falta [plugin]');
  return meta;
}

function validatePluginFields(meta: Record<string, unknown>): void {
  for (const c of REQUIRED_PLUGIN_FIELDS) {
    requireStringField(meta, c, '[plugin]');
  }
}

const PAYLOAD_BLOCK_MAP: Record<string, string> = {
  skill: 'skill',
  universe: 'universe',
  preset: 'preset',
  'discipline-profile': 'discipline',
};

/**
 * Extrae y valida el bloque de payload SOLO si está presente.
 *
 * La tienda alberga todos los tipos de plugin del proyecto (skill, universe,
 * preset, discipline, discipline-profile, provider, extra, …): el contenido real
 * viaja en el tarball y el manifiesto solo aporta metadatos de catálogo. Por eso
 * NO exigimos un bloque de payload ni restringimos el `type`. Si el manifiesto
 * incluye un bloque conocido (p.ej. `[skill]`), validamos su forma — esto preserva
 * los chequeos de seguridad como el de path traversal en `[skill].file`.
 */
function extractOptionalPayload(
  data: TomlTable,
  type: string,
): Record<string, unknown> {
  const blockName = PAYLOAD_BLOCK_MAP[type];
  if (!blockName) return {};
  const payload = data[blockName];
  if (!isNonNullObject(payload)) return {};
  validatePayload(type, payload);
  return payload;
}

function extractConfigSpec(data: TomlTable): Record<string, unknown> {
  const cfg = isNonNullObject(data['config']) ? data['config'] : {};
  const configSpec: Record<string, unknown> = {};
  if (cfg['fields'] != null) configSpec['fields'] = cfg['fields'];
  if (cfg['form'] != null) configSpec['form'] = cfg['form'];
  return configSpec;
}

/**
 * Parsea y valida un manifiesto de plugin en formato TOML.
 *
 * Comprueba que el bloque `[plugin]` tenga todos los campos obligatorios,
 * que el `type` sea uno de los tipos de datos admitidos, que el `id` sea
 * kebab-case y que el bloque de payload correspondiente al tipo sea válido.
 *
 * @param text - Contenido TOML del manifiesto.
 * @returns `Manifest` normalizado listo para persistir.
 * @throws {ManifestError} Si el TOML es inválido o falla cualquier regla de negocio.
 */
export function parseAndValidateManifest(text: string): Manifest {
  let data: TomlTable;
  try {
    data = parseToml(text);
  } catch (e) {
    throw new ManifestError(`TOML inválido: ${(e as Error).message}`);
  }

  const meta = extractRecord(data);
  validatePluginFields(meta);

  const id = meta['id'] as string;
  const type = meta['type'] as string; // ya validado como string requerido por validatePluginFields

  if (!KEBAB.test(id)) throw new ManifestError(`id '${id}' no es kebab-case`);

  const payload = extractOptionalPayload(data, type);

  const configSpec = extractConfigSpec(data);

  const rawRepository = meta['repository'];
  const repository =
    typeof rawRepository === 'string' && rawRepository.trim()
      ? rawRepository.trim()
      : undefined;

  return {
    id,
    name: meta['name'] as string,
    type,
    version: meta['version'] as string,
    author: meta['author'] as string,
    description: meta['description'] as string,
    repository,
    payload,
    configSpec,
    raw: data,
  };
}

function validateUniverse(payload: Record<string, unknown>): void {
  const syms = payload['symbols'];
  if (!isNonNullObject(syms) || !Object.keys(syms).length) {
    throw new ManifestError('[universe].symbols debe ser un objeto no vacío');
  }
  for (const [sym, clase] of Object.entries(syms)) {
    if (!CLASES_ACTIVO.has(String(clase))) {
      throw new ManifestError(`clase '${String(clase)}' inválida para ${sym}`);
    }
  }
}

function validateSkill(payload: Record<string, unknown>): void {
  if (typeof payload['name'] !== 'string')
    throw new ManifestError('[skill].name requerido');
  const file = payload['file'];
  if (typeof file === 'string') {
    const partes = file.split('/');
    if (file.startsWith('/') || partes.includes('..')) {
      throw new ManifestError('[skill].file debe ser relativo sin ".."');
    }
  }
  if (typeof payload['prompt'] !== 'string' && typeof file !== 'string') {
    throw new ManifestError('[skill] necesita prompt o file');
  }
}

function validatePreset(payload: Record<string, unknown>): void {
  const cfg = payload['config'];
  if (!isNonNullObject(cfg) || !Object.keys(cfg).length) {
    throw new ManifestError('[preset].config no vacío requerido');
  }
}

const DISCIPLINE_FIELDS: [string, string][] = [
  ['dsr_threshold', 'number'],
  ['min_sources', 'number'],
  ['stress_windows', 'object'],
  ['ex_ante_discount', 'number'],
  ['require_preregistration', 'boolean'],
];

function validateDisciplineProfile(payload: Record<string, unknown>): void {
  for (const [campo, t] of DISCIPLINE_FIELDS) {
    if (typeof payload[campo] !== t)
      throw new ManifestError(`[discipline].${campo} inválido`);
  }
}

const PAYLOAD_VALIDATORS: Record<string, (p: Record<string, unknown>) => void> =
  {
    universe: validateUniverse,
    skill: validateSkill,
    preset: validatePreset,
    'discipline-profile': validateDisciplineProfile,
  };

function validatePayload(type: string, payload: Record<string, unknown>): void {
  PAYLOAD_VALIDATORS[type]?.(payload);
}
