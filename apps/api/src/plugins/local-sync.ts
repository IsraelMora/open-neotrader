import * as fs from 'fs';
import * as path from 'path';
import { readManifest, validateManifest } from './manifest';

/** Registro de un plugin local descubierto en disco, listo para sincronizar con la BD. */
export interface LocalPluginRecord {
  id: string;
  name: string;
  description: string | null;
  version: string;
  type: string;
  author: string | null;
  installed_path: string;
}

/**
 * Escanea el directorio de plugins y devuelve un registro por cada subdirectorio
 * que contenga un `manifest.toml` válido. Ignora directorios sin manifest, manifests
 * inválidos y entradas que no son directorios. Función pura (sin acceso a la BD).
 */
export function scanLocalManifests(pluginsDir: string): LocalPluginRecord[] {
  if (!fs.existsSync(pluginsDir)) return [];

  const records: LocalPluginRecord[] = [];
  for (const entry of fs.readdirSync(pluginsDir)) {
    const dir = path.join(pluginsDir, entry);
    if (!fs.statSync(dir).isDirectory()) continue;

    const manifest = readManifest(dir);
    if (!manifest) continue;
    if (validateManifest(manifest).length > 0) continue;

    records.push({
      id: manifest.plugin.id,
      name: manifest.plugin.name,
      description: manifest.plugin.description ?? null,
      version: manifest.plugin.version,
      type: manifest.plugin.type,
      author: manifest.plugin.author ?? null,
      installed_path: dir,
    });
  }
  return records;
}
