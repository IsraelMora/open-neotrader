/**
 * Helpers para leer valores del KV (tabla configEntry) tolerando los DOS encodings
 * que conviven en la columna `value`:
 *   - crudo: `KvService.set` guarda el string tal cual ('openai', '300', 'true').
 *   - JSON-encoded: el panel (`PanelService.saveConfig`) guarda `JSON.stringify(value)`
 *     ('"openai"', '300', 'true', '"true"' si el valor venía como string).
 *
 * Sin esto, un `=== 'true'` falla cuando el panel guardó `'"true"'`, y `Number('"300"')`
 * da NaN → el sistema usa el default y, p.ej., la ejecución real nunca se activa.
 */

/** Desenvuelve un string JSON-encoded ('"x"' → 'x'); deja intacto lo demás (incluyendo number/boolean crudos). */
export function unwrapKv(v: string | null): string | null {
  if (v == null) return v;
  try {
    const parsed: unknown = JSON.parse(v);
    return typeof parsed === 'string' ? parsed : v;
  } catch {
    return v;
  }
}

/** Lee un string del KV desenvolviendo el JSON-encoding del panel. */
export function kvStr(v: string | null): string | null {
  return unwrapKv(v);
}

/**
 * Lee un booleano con match ESTRICTO sobre 'true'/'false' (case-sensitive), pero
 * desenvolviendo el JSON-encoding del panel ('"true"' → 'true', '"false"' → 'false').
 * Cualquier otro valor (incluido 'True', '1', '') → fallback. Esto preserva la semántica
 * estricta del código existente y solo agrega tolerancia al doble-encoding.
 */
export function kvBool(v: string | null, fallback: boolean): boolean {
  if (v == null) return fallback;
  const s = unwrapKv(v);
  if (s === 'true') return true;
  if (s === 'false') return false;
  return fallback;
}

/** Lee un número tolerando JSON-encoding ('"300"' → 300). null o no-numérico → fallback. */
export function kvNum(v: string | null, fallback: number): number {
  if (v == null) return fallback;
  const n = Number(unwrapKv(v));
  return Number.isFinite(n) ? n : fallback;
}
