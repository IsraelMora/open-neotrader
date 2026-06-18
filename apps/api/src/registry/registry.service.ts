import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PluginsService } from '../plugins/plugins.service';
import { StoreService } from '../store/store.service';

export interface CatalogPlugin {
  id: string; // = manifestId
  publisher_id: string;
  name: string;
  version: string;
  type: string;
  description: string;
  tags: string[];
  verified: boolean;
  git_url?: string;
}

interface StoreItem {
  id: string;
  publisherId: string;
  manifestId: string;
  type: string;
  name: string;
  description: string;
  latestVersion: string;
  repository?: string | null;
  _count?: { votes: number; reports: number };
}

interface StoreList {
  items: StoreItem[];
  total: number;
  page: number;
  pageSize: number;
}

function mapItem(item: StoreItem): CatalogPlugin {
  return {
    id: item.manifestId,
    publisher_id: item.publisherId,
    name: item.name,
    version: item.latestVersion,
    type: item.type,
    description: item.description,
    tags: [],
    verified: (item._count?.reports ?? 0) === 0,
    git_url: item.repository ?? undefined,
  };
}

@Injectable()
export class RegistryService {
  private readonly log = new Logger(RegistryService.name);

  constructor(
    private readonly plugins: PluginsService,
    private readonly store: StoreService,
  ) {}

  // ── Catalog (desde la tienda) ─────────────────────────────────────────────

  async listCatalog(opts: {
    type?: string;
    tag?: string;
    search?: string;
    verified_only?: boolean;
    page?: number;
    pageSize?: number;
  }): Promise<{
    total: number;
    page: number;
    pageSize: number;
    plugins: (CatalogPlugin & { installed: boolean; active: boolean })[];
  }> {
    const qs: Record<string, string> = {};
    if (opts.type) qs['type'] = opts.type;
    if (opts.search) qs['q'] = opts.search;
    if (opts.page) qs['page'] = String(opts.page);
    if (opts.pageSize) qs['pageSize'] = String(opts.pageSize);

    const storeList = (await this.store.browse(qs)) as StoreList;
    const installed = await this.plugins.findAll();
    const installedIds = new Set(installed.map((p) => p.id));
    const activeIds = new Set(installed.filter((p) => p.active).map((p) => p.id));

    let result = storeList.items.map(mapItem);

    if (opts.verified_only) {
      result = result.filter((p) => p.verified);
    }
    if (opts.tag) {
      result = result.filter((p) => p.tags.includes(opts.tag!));
    }

    return {
      total: storeList.total,
      page: storeList.page,
      pageSize: storeList.pageSize,
      plugins: result.map((p) => ({
        ...p,
        installed: installedIds.has(p.id),
        active: activeIds.has(p.id),
      })),
    };
  }

  async getCatalogPlugin(
    id: string,
  ): Promise<CatalogPlugin & { installed: boolean; active: boolean }> {
    // id = manifestId; publisher_id buscado en listado
    const storeList = (await this.store.browse({ q: id })) as StoreList;
    const item = storeList.items.find((i) => i.manifestId === id);
    if (!item) throw new NotFoundException(`Plugin '${id}' no encontrado en la tienda`);

    const entry = mapItem(item);
    const installed = await this.plugins.findAll();
    const installedPlugin = installed.find((p) => p.id === id);

    return {
      ...entry,
      installed: !!installedPlugin,
      active: installedPlugin?.active ?? false,
    };
  }

  // ── Install desde catálogo ────────────────────────────────────────────────

  async installFromCatalog(id: string): Promise<{ ok: boolean; message: string }> {
    const entry = await this.getCatalogPlugin(id);

    if (entry.installed) {
      return { ok: false, message: `Plugin '${id}' ya está instalado` };
    }

    if (!entry.git_url) {
      return {
        ok: false,
        message: `Plugin '${id}' no tiene repositorio git — el publicador debe añadir [plugin].repository en el manifest.toml`,
      };
    }

    try {
      await this.plugins.install(entry.git_url);
      this.log.log(`Plugin '${id}' instalado via git clone desde ${entry.git_url}`);
      return { ok: true, message: `Plugin '${id}' instalado desde ${entry.git_url}` };
    } catch (err) {
      const msg = (err as Error).message;
      this.log.error(`Error instalando '${id}': ${msg}`);
      return { ok: false, message: msg };
    }
  }

  // ── Estadísticas ──────────────────────────────────────────────────────────

  async catalogStats(): Promise<Record<string, unknown>> {
    const storeList = (await this.store.browse({})) as StoreList;
    const installed = await this.plugins.findAll();
    const installedIds = new Set(installed.map((p) => p.id));

    const items = storeList.items;
    const byType = items.reduce<Record<string, number>>((acc, p) => {
      acc[p.type] = (acc[p.type] ?? 0) + 1;
      return acc;
    }, {});

    return {
      total: storeList.total,
      verified: items.filter((p) => (p._count?.reports ?? 0) === 0).length,
      with_repo: items.filter((p) => !!p.repository).length,
      installed_from_catalog: items.filter((p) => installedIds.has(p.manifestId)).length,
      by_type: byType,
    };
  }
}
