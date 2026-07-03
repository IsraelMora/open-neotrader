import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { KvService } from '../common/kv.service';
import { kvNum } from '../common/kv.util';
import { PretestService } from '../pretest/pretest.service';

/** KV key: interval between automatic pretest cycles, in ms. <=0 disables the scheduler. */
const CONFIG_KEY = 'pretest.scheduler_interval_ms';

/** Default cadence: 6 hours. Pretests are virtual-only, so a slower default than the
 * real cycle (45min) is fine and keeps LLM/API usage modest for N parallel portfolios.
 * Raised from 60min (Fix B): the main cycle + 3 pretests each run the LLM, and at a
 * 60min pretest cadence the combined daily call volume blew through the Gemini
 * free-tier quota (~60% of production cycles hit 429s over an 11h run). 6h cuts
 * pretest LLM calls 6x. KV `pretest.scheduler_interval_ms` still overrides this. */
const DEFAULT_INTERVAL_MS = 6 * 60 * 60_000;

/** How often the internal timer wakes up to check whether a run is due. */
const TICK_MS = 60_000;

/**
 * PretestSchedulerService — runs ALL active pretest (virtual) portfolios automatically,
 * on a configurable interval, via PretestService.runAllActive().
 *
 * Mirrors CycleSchedulerService's pattern (OnModuleInit setInterval + KV-config +
 * fail-soft + overlap-guard), scaled down: pretests are virtual-only (never touch real
 * money / execution.real / real_execution.halted), so there is no circuit breaker or
 * broker-facing state to protect here — a failed pretest cycle for one portfolio is
 * just logged and retried on the next tick.
 *
 * - Config: KV `pretest.scheduler_interval_ms` (default 6h). A value <= 0 disables
 *   the scheduler (tick becomes a no-op).
 * - Overlap guard: a `running` flag skips a tick while a previous run is still in flight.
 * - Fail-soft: tick() NEVER throws — KV read errors and PretestService.runAllActive()
 *   rejections are caught, logged, and never propagate out of the timer callback.
 * - Does NOT run at startup: onModuleInit seeds `lastRunAt` to "now", so the first
 *   actual run happens one full interval later (not immediately on boot).
 */
@Injectable()
export class PretestSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(PretestSchedulerService.name);
  private ticker: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastRunAt: number | null = null;

  constructor(
    private readonly kv: KvService,
    private readonly pretest: PretestService,
  ) {}

  onModuleInit(): void {
    // Do NOT run at startup — seed lastRunAt to "now" so the first eligible run is
    // one full interval later, not immediately on boot.
    this.lastRunAt = Date.now();
    this.ticker = setInterval(() => void this.tick(), TICK_MS);
    this.log.log('Pretest scheduler iniciado');
  }

  onModuleDestroy(): void {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  /**
   * Checks whether a run is due and, if so, executes PretestService.runAllActive()
   * for every active pretest portfolio. Never throws — every failure path (KV read,
   * runAllActive rejection) is caught and logged; the `running` overlap guard is
   * always released in a `finally`.
   */
  private async tick(): Promise<void> {
    if (this.running) return; // overlap guard: previous run still in flight

    let intervalMs: number;
    try {
      const raw = await this.kv.get(CONFIG_KEY);
      intervalMs = kvNum(raw, DEFAULT_INTERVAL_MS);
    } catch (err: unknown) {
      this.log.warn(`Pretest scheduler: fallo leyendo config KV — ${String(err)}`);
      return;
    }

    if (intervalMs <= 0) return; // disabled

    const last = this.lastRunAt ?? Date.now();
    if (Date.now() < last + intervalMs) return; // not due yet

    this.running = true;
    this.lastRunAt = Date.now();
    try {
      const results = await this.pretest.runAllActive();
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0) {
        this.log.warn(
          `Pretest ciclo automático: ${failed.length}/${results.length} portfolios fallaron — ` +
            failed.map((f) => `${f.name}: ${f.error}`).join('; '),
        );
      } else {
        this.log.log(`Pretest ciclo automático: ${results.length} portfolio(s) ejecutado(s)`);
      }
    } catch (err: unknown) {
      this.log.warn(`Pretest scheduler: fallo ejecutando runAllActive() — ${String(err)}`);
    } finally {
      this.running = false;
    }
  }
}
