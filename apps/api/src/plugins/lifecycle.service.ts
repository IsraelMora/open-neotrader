import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SandboxGateway } from '../sandbox/sandbox.gateway';
import { PluginEventsService } from './plugin-events.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Escucha eventos del bus y ejecuta los hooks de ciclo de vida de los plugins
 * (on_activate, on_deactivate) en el sandbox Python de forma asíncrona.
 */
@Injectable()
export class LifecycleService implements OnModuleInit {
  private readonly log = new Logger(LifecycleService.name);

  constructor(
    private readonly events: PluginEventsService,
    private readonly sandbox: SandboxGateway,
    private readonly db: PrismaService,
  ) {}

  onModuleInit() {
    // Los handlers se mantienen síncronos: delegan en runHook, que aísla la
    // promesa con void + catch de tope para no dejar rejections sin atrapar.
    this.events.on('plugin.activated', ({ plugin_id }) => {
      this.runHook('activate', plugin_id);
    });
    this.events.on('plugin.deactivated', ({ plugin_id }) => {
      this.runHook('deactivate', plugin_id);
    });
  }

  private runHook(kind: 'activate' | 'deactivate', pluginId: string): void {
    void this.executeHook(kind, pluginId).catch((err: unknown) => {
      this.log.warn(`Hook on_${kind} de '${pluginId}' lanzó: ${String(err)}`);
    });
  }

  private async executeHook(kind: 'activate' | 'deactivate', pluginId: string): Promise<void> {
    const plugin = await this.db.plugin.findUnique({ where: { id: pluginId } });
    if (!plugin?.installed_path) return;
    const res = await (
      kind === 'activate'
        ? this.sandbox.runActivateHook(pluginId, plugin.installed_path)
        : this.sandbox.runDeactivateHook(pluginId, plugin.installed_path)
    ).catch(() => null);
    if (res && !res.ok) this.log.warn(`on_${kind} hook de '${pluginId}' falló: ${res.error}`);
  }
}
