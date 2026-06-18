/**
 * PluginWatcherService — hot-reload de plugins en desarrollo.
 *
 * Observa los directorios de plugins activos con fs.watch.
 * Si cambia SKILL.md emite 'plugin.skill_updated' para que el LLM
 * use el conocimiento más reciente en el próximo ciclo.
 * Si cambia manifest.toml refresca los metadatos del plugin en BD.
 *
 * Solo activo cuando NODE_ENV !== "production" o PLUGIN_HOT_RELOAD=true.
 */
import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { PluginsService } from './plugins.service';
import { PluginEventsService } from './plugin-events.service';

@Injectable()
export class PluginWatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(PluginWatcherService.name);
  private readonly enabled: boolean;
  private watchers = new Map<string, fs.FSWatcher>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly plugins: PluginsService,
    private readonly events: PluginEventsService,
    cfg: ConfigService,
  ) {
    const isProduction = cfg.get<string>('NODE_ENV') === 'production';
    const forceEnabled = cfg.get<string>('PLUGIN_HOT_RELOAD') === 'true';
    this.enabled = forceEnabled || !isProduction;
  }

  async onModuleInit() {
    if (!this.enabled) return;
    this.log.log('Plugin hot-reload activo');
    await this.watchAll();
  }

  onModuleDestroy() {
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
  }

  private async refresh() {
    if (!this.enabled) return;
    await this.watchAll();
  }

  private async watchAll() {
    const active = await this.plugins.findActive();
    const activePaths = new Set(active.map((p) => p.installed_path).filter(Boolean) as string[]);

    // Eliminar watchers de plugins ya no activos
    for (const [watchedPath, watcher] of this.watchers.entries()) {
      if (!activePaths.has(watchedPath)) {
        watcher.close();
        this.watchers.delete(watchedPath);
      }
    }

    // Añadir watchers para plugins nuevos
    for (const pluginPath of activePaths) {
      if (this.watchers.has(pluginPath)) continue;
      this.watchDir(pluginPath);
    }
  }

  private watchDir(pluginPath: string) {
    if (!fs.existsSync(pluginPath)) return;

    try {
      const watcher = fs.watch(pluginPath, { recursive: false }, (event, filename) => {
        if (!filename) return;
        const debounceKey = `${pluginPath}/${filename}`;
        const existing = this.debounceTimers.get(debounceKey);
        if (existing) clearTimeout(existing);
        this.debounceTimers.set(
          debounceKey,
          setTimeout(() => this.handleChange(pluginPath, filename), 300),
        );
      });

      watcher.on('error', (err) => {
        this.log.warn(`Watcher error en ${pluginPath}: ${err}`);
        this.watchers.delete(pluginPath);
      });

      this.watchers.set(pluginPath, watcher);
      this.log.debug(`Watching: ${path.basename(pluginPath)}`);
    } catch (err) {
      this.log.warn(`No se pudo observar ${pluginPath}: ${err}`);
    }
  }

  private handleChange(pluginPath: string, filename: string) {
    const pluginId = path.basename(pluginPath);

    if (filename === 'SKILL.md') {
      this.log.log(`SKILL.md actualizado: ${pluginId}`);
      this.events.emit('plugin.skill_updated', { plugin_id: pluginId, path: pluginPath });
    } else if (filename === 'manifest.toml') {
      this.log.log(`manifest.toml actualizado: ${pluginId}`);
      this.events.emit('plugin.manifest_updated', { plugin_id: pluginId, path: pluginPath });
      // Refrescar metadatos en BD (sin bloquear)
      void this.reloadManifest(pluginId, pluginPath);
    }
  }

  private async reloadManifest(pluginId: string, pluginPath: string) {
    try {
      const manifest = this.plugins.getManifest(pluginPath);
      if (!manifest) return;
      // Actualizar descripción y nombre en BD si cambiaron
      await this.plugins.db.plugin.updateMany({
        where: { id: pluginId },
        data: {
          name: manifest.plugin.name,
          description: manifest.plugin.description ?? null,
        },
      });
      this.log.debug(`Manifest recargado: ${pluginId}`);
    } catch (err) {
      this.log.warn(`Error recargando manifest de ${pluginId}: ${err}`);
    }
  }
}
