import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { KvService } from '../common/kv.service';
import { CycleExecutorService } from '../cycle/cycle-executor.service';
import { PluginsService } from '../plugins/plugins.service';

const CONFIG_KEY = 'scheduler';
const CB_KEY = 'scheduler:circuit_breaker';
const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 7 * 24 * 3600_000;
const TICK_MS = 15_000;
const DEFAULT_INTERVAL_MS = 3_600_000;
const CB_MAX_FAILURES = 3; // fallos consecutivos antes de abrir el circuit breaker
const CB_HALF_OPEN_MS = 5 * 60_000; // 5 min antes de intentar de nuevo

/**
 * Modo de ejecución declarado en manifest.toml [scheduler].mode:
 *   "polling"  → el plugin necesita ser invocado periódicamente (default)
 *   "reactive" → el plugin emite eventos propios (el platform solo coordina)
 *   "none"     → el plugin no necesita ciclos automáticos (ej: skill puro de conocimiento)
 */
export type SchedulerMode = 'polling' | 'reactive' | 'none';

export interface PluginSchedule {
  plugin_id: string;
  mode: SchedulerMode;
  interval_ms: number;
  timeframe: string; // "1m" | "5m" | "1h" | "1d" | "1w" | "1mo"
}

export interface SchedulerConfig {
  enabled: boolean;
  /** Override manual del intervalo. Si es null, se usa el de los plugins activos. */
  override_interval_ms: number | null;
  prompt?: string;
  last_run?: string;
  next_run?: string;
  run_count: number;
}

export interface CircuitBreakerState {
  state: 'closed' | 'open' | 'half_open'; // closed = ok, open = paused
  consecutive_failures: number;
  last_failure_at: string | null;
  last_success_at: string | null;
  reason: string | null;
}

export interface SchedulerStatus extends SchedulerConfig {
  effective_interval_ms: number;
  plugin_schedules: PluginSchedule[];
  running_now: boolean;
  circuit_breaker: CircuitBreakerState;
}

const DEFAULT_CONFIG: SchedulerConfig = {
  enabled: false,
  override_interval_ms: null,
  run_count: 0,
};

/** Mapa de timeframe a ms para plugins que declaran timeframe en vez de interval_ms */
const TIMEFRAME_TO_MS: Record<string, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 3_600_000,
  '4h': 4 * 3_600_000,
  '1d': 24 * 3_600_000,
  '1w': 7 * 24 * 3_600_000,
  '1mo': 30 * 24 * 3_600_000,
};

/**
 * Planifica y ejecuta ciclos de agente periódicamente.
 * Incluye circuit breaker que pausa la ejecución tras 3 fallos consecutivos.
 */
@Injectable()
export class CycleSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(CycleSchedulerService.name);
  private ticker: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly store: KvService,
    private readonly cycleExecutor: CycleExecutorService,
    private readonly plugins: PluginsService,
  ) {}

  onModuleInit(): void {
    this.ticker = setInterval(() => void this.tick(), TICK_MS);
    this.log.log('Cycle scheduler iniciado');
  }

  onModuleDestroy(): void {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------

  /** Lee la configuración actual del scheduler desde KV store. */
  async getConfig(): Promise<SchedulerConfig> {
    const raw = await this.store.get(CONFIG_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    try {
      return JSON.parse(raw) as SchedulerConfig;
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  /** Actualiza la configuración del scheduler (habilitado, intervalo override, prompt). */
  async updateConfig(
    patch: Partial<Pick<SchedulerConfig, 'enabled' | 'override_interval_ms' | 'prompt'>>,
  ): Promise<SchedulerConfig> {
    const current = await this.getConfig();

    if (patch.override_interval_ms !== null && patch.override_interval_ms !== undefined) {
      if (
        patch.override_interval_ms < MIN_INTERVAL_MS ||
        patch.override_interval_ms > MAX_INTERVAL_MS
      ) {
        throw new Error(
          `override_interval_ms debe estar entre ${MIN_INTERVAL_MS} y ${MAX_INTERVAL_MS}`,
        );
      }
    }

    const updated: SchedulerConfig = { ...current, ...patch };
    await this.store.set(CONFIG_KEY, JSON.stringify(updated));
    this.log.log(
      `Scheduler config: enabled=${updated.enabled} override=${updated.override_interval_ms}`,
    );
    return updated;
  }

  // ---------------------------------------------------------------------------
  // Status con información de plugins
  // ---------------------------------------------------------------------------

  /** Estado completo del scheduler: config, intervalos efectivos de plugins, circuit breaker y si hay un ciclo en curso. */
  async getStatus(): Promise<SchedulerStatus> {
    const cfg = await this.getConfig();
    const pluginSchedules = await this.resolvePluginSchedules();
    const effectiveInterval = this.computeEffectiveInterval(cfg, pluginSchedules);
    const cb = await this.getCircuitBreaker();

    const lastRun = cfg.last_run ? new Date(cfg.last_run).getTime() : null;
    const nextRun =
      cfg.enabled && lastRun ? new Date(lastRun + effectiveInterval).toISOString() : undefined;

    return {
      ...cfg,
      next_run: nextRun,
      effective_interval_ms: effectiveInterval,
      plugin_schedules: pluginSchedules,
      running_now: this.running,
      circuit_breaker: cb,
    };
  }

  /** Devuelve el estado actual del circuit breaker (closed/open/half_open). */
  async getCircuitBreaker(): Promise<CircuitBreakerState> {
    const raw = await this.store.get(CB_KEY);
    if (!raw)
      return {
        state: 'closed',
        consecutive_failures: 0,
        last_failure_at: null,
        last_success_at: null,
        reason: null,
      };
    try {
      return JSON.parse(raw) as CircuitBreakerState;
    } catch {
      return {
        state: 'closed',
        consecutive_failures: 0,
        last_failure_at: null,
        last_success_at: null,
        reason: null,
      };
    }
  }

  /** Reinicia el circuit breaker manualmente, borrando el contador de fallos. */
  async resetCircuitBreaker(): Promise<void> {
    await this.store.delete(CB_KEY);
    this.log.log('Circuit breaker reiniciado manualmente');
  }

  // ---------------------------------------------------------------------------
  // Lógica central
  // ---------------------------------------------------------------------------

  /**
   * Lee los manifests de todos los plugins activos y extrae su [scheduler] section.
   * Solo considera plugins con mode = "polling".
   */
  private async resolvePluginSchedules(): Promise<PluginSchedule[]> {
    try {
      const active = await this.plugins.findActive();
      const schedules: PluginSchedule[] = [];

      for (const plugin of active) {
        const manifest = this.plugins.getManifest(plugin.installed_path);
        const sched = (manifest as unknown as Record<string, unknown>)?.['scheduler'] as
          | Record<string, unknown>
          | undefined;
        if (!sched) continue;

        const mode = (sched['mode'] as SchedulerMode | undefined) ?? 'polling';
        if (mode === 'none' || mode === 'reactive') continue;

        // Leer config del plugin almacenada — puede sobreescribir los defaults del manifest
        const pluginConfig: Record<string, unknown> = plugin.config ?? {};

        // Prioridad: config del plugin > manifest [scheduler] > default
        const timeframe =
          (pluginConfig['scheduler_timeframe'] as string | undefined) ??
          (sched['timeframe'] as string | undefined) ??
          '1d';

        const declaredMs =
          (pluginConfig['scheduler_interval_ms'] as number | undefined) ??
          (sched['interval_ms'] as number | undefined);

        const intervalMs = declaredMs ?? TIMEFRAME_TO_MS[timeframe] ?? DEFAULT_INTERVAL_MS;

        schedules.push({ plugin_id: plugin.id, mode, interval_ms: intervalMs, timeframe });
      }
      return schedules;
    } catch {
      return [];
    }
  }

  /**
   * Devuelve el intervalo efectivo: override manual > mínimo de plugins > default.
   */
  private computeEffectiveInterval(cfg: SchedulerConfig, schedules: PluginSchedule[]): number {
    if (cfg.override_interval_ms != null) {
      return cfg.override_interval_ms;
    }
    if (schedules.length === 0) return DEFAULT_INTERVAL_MS;

    // Usar el intervalo más corto entre los plugins activos (el más exigente)
    const min = Math.min(...schedules.map((s) => s.interval_ms));
    return Math.max(min, MIN_INTERVAL_MS);
  }

  private async tick(): Promise<void> {
    if (this.running) return;

    const cfg = await this.getConfig();
    if (!cfg.enabled) return;

    const cb = await this.getCircuitBreaker();
    if (!(await this.checkCircuitBreaker(cb))) return;

    const pluginSchedules = await this.resolvePluginSchedules();
    const effectiveInterval = this.computeEffectiveInterval(cfg, pluginSchedules);
    const lastRun = cfg.last_run ? new Date(cfg.last_run).getTime() : 0;
    if (Date.now() < lastRun + effectiveInterval) return;
    if (this.cycleExecutor.getRunStatus().running) return;

    this.running = true;
    this.log.log(
      `Ciclo automático #${cfg.run_count + 1} (intervalo: ${effectiveInterval / 1000}s)`,
    );

    try {
      await this.executeTick(cfg, cb);
    } finally {
      this.running = false;
    }
  }

  /** Returns true when execution should proceed, false when it should be skipped. */
  private async checkCircuitBreaker(cb: CircuitBreakerState): Promise<boolean> {
    if (cb.state !== 'open') return true;
    const lastFail = cb.last_failure_at ? new Date(cb.last_failure_at).getTime() : 0;
    if (Date.now() < lastFail + CB_HALF_OPEN_MS) return false;
    await this._saveCb({ ...cb, state: 'half_open' });
    return true;
  }

  private async executeTick(cfg: SchedulerConfig, cb: CircuitBreakerState): Promise<void> {
    try {
      const result = this.cycleExecutor.runCycle(false, cfg.prompt);
      if (!result.accepted) {
        this.log.warn('Ciclo rechazado por panel (ya hay uno en curso)');
        return;
      }

      await this._saveCb({
        state: 'closed',
        consecutive_failures: 0,
        last_failure_at: cb.last_failure_at,
        last_success_at: new Date().toISOString(),
        reason: null,
      });

      await this.store.set(
        CONFIG_KEY,
        JSON.stringify({
          ...cfg,
          last_run: new Date().toISOString(),
          run_count: cfg.run_count + 1,
        }),
      );

      // After a successful cycle, check if it's time to trigger a reflection turn.
      // Route via PanelService.reflectNow() — reusing the existing scheduler→panel edge
      // to avoid any circular module dependency (do NOT inject AgentsService here directly).
      await this._maybeReflect();
    } catch (err) {
      await this.handleTickError(err, cb);
    }
  }

  /**
   * Checks the reflection cadence and triggers a reflection via CycleExecutorService.reflectNow()
   * if the counter has reached the configured threshold.
   *
   * Config (KV key "reflection" JSON): { every_n_cycles: number }  default: 10
   * Counter (KV key "reflection.cycle_counter"): integer string, default "0"
   */
  private async _maybeReflect(): Promise<void> {
    // Skip if a cycle is still in progress (runCycle is fire-and-forget; cycleExecutor tracks the flag).
    if (this.cycleExecutor.getRunStatus().running) {
      return;
    }

    // Read cadence config.
    const REFLECTION_CADENCE_DEFAULT = 10;
    let everyNCycles = REFLECTION_CADENCE_DEFAULT;
    try {
      const raw = await this.store.get('reflection');
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const configured = parsed['every_n_cycles'];
        if (typeof configured === 'number') {
          everyNCycles = configured;
        }
      }
    } catch {
      everyNCycles = REFLECTION_CADENCE_DEFAULT;
    }

    // 0 = disabled.
    if (everyNCycles === 0) return;

    // Read and increment counter.
    const rawCounter = await this.store.get('reflection.cycle_counter');
    const counter = (parseInt(rawCounter ?? '0', 10) || 0) + 1;

    if (counter >= everyNCycles) {
      // Threshold reached: trigger reflection, reset counter only on success.
      try {
        await this.cycleExecutor.reflectNow();
        await this.store.set('reflection.cycle_counter', '0');
      } catch (err: unknown) {
        // Log but don't propagate — reflection failure must not disrupt the cycle scheduler.
        // Counter is NOT reset: next cycle will retry immediately (counter still at threshold).
        this.log.warn(`_maybeReflect: cycleExecutor.reflectNow() error — ${String(err)}`);
      }
    } else {
      await this.store.set('reflection.cycle_counter', String(counter));
    }
  }

  private async handleTickError(err: unknown, cb: CircuitBreakerState): Promise<void> {
    const msg = err instanceof Error ? err.message : String(err);
    this.log.error(`Error en ciclo automático: ${msg}`);

    const failures = cb.consecutive_failures + 1;
    const newState: CircuitBreakerState['state'] =
      failures >= CB_MAX_FAILURES || cb.state === 'half_open' ? 'open' : 'closed';

    await this._saveCb({
      state: newState,
      consecutive_failures: failures,
      last_failure_at: new Date().toISOString(),
      last_success_at: cb.last_success_at,
      reason: msg.slice(0, 200),
    });

    if (newState === 'open') {
      this.log.warn(
        `Circuit breaker ABIERTO tras ${failures} fallos. Ciclos pausados ${CB_HALF_OPEN_MS / 60000}min. Causa: ${msg}`,
      );
    }
  }

  private async _saveCb(state: CircuitBreakerState): Promise<void> {
    await this.store.set(CB_KEY, JSON.stringify(state));
  }

  /** Dispara un ciclo inmediato fuera del intervalo programado; lanza si ya hay uno en curso. */
  async runNow(prompt?: string): Promise<void> {
    if (this.running || this.cycleExecutor.getRunStatus().running) {
      throw new Error('Ya hay un ciclo en ejecución. Espera a que termine.');
    }
    this.running = true;
    try {
      const result = this.cycleExecutor.runCycle(false, prompt);
      if (!result.accepted) throw new Error('Ciclo rechazado (ya hay uno en curso)');
      const cfg = await this.getConfig();
      await this.store.set(
        CONFIG_KEY,
        JSON.stringify({
          ...cfg,
          last_run: new Date().toISOString(),
          run_count: cfg.run_count + 1,
        }),
      );
    } finally {
      this.running = false;
    }
  }
}
