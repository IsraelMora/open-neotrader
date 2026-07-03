import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { KvService } from '../common/kv.service';
import { kvBool } from '../common/kv.util';

/**
 * StrategyBootstrapService — deploy-time, idempotent PAPER-mode seeder.
 *
 * Context: the prod instance is mono-operator (registration locked) and there is no
 * app-level credential to hit the runtime config API from outside. This service
 * configures the running instance to run the momentum-rotation strategy in PAPER
 * mode automatically on boot, exactly once.
 *
 * Hard boundary: this seeder is PAPER-ONLY. It must never set `execution.real=true`
 * and must never touch `real_execution.halted` (the real-money kill-switch) — that
 * remains a human-TOTP-gated action (see RealBrokerReconciliationService / the TOTP
 * clear endpoint). It only ever writes `execution.real = 'false'` explicitly.
 *
 * Idempotency: gated by KV `bootstrap.momentum_v1_applied`. Once set to 'true', every
 * subsequent boot is a no-op — this guarantees the seeder mutates the operator's
 * config exactly once, ever, even across redeploys.
 *
 * Fail-soft: mirrors the OnModuleInit pattern in MigrationRunnerService (registered
 * in its own module, runs on boot) but never throws — any error is logged and
 * swallowed so a bootstrap failure can never block application startup. Per-plugin
 * writes are individually fail-soft (a missing plugin row or a DB error on one
 * plugin does not stop the rest from being processed).
 *
 * Design note: this does NOT create a `Strategy` row via StrategyService.apply().
 * That row mainly exists to gate REAL-money entries with a walk-forward verdict
 * (see TradeIntentService._checkWalkForwardGate()) — since this seeder only ever
 * operates in PAPER mode, a Strategy row buys nothing here. Setting the KV keys
 * directly is simpler and keeps this service's blast radius to config only.
 */

export const MOMENTUM_UNIVERSE = 'SPY,QQQ,IWM,EFA,EEM,TLT,IEF,GLD,DBC,DBMF,BIL';

/** 45 minutes: a sane default cadence that respects the free/low-rate LLM budget. */
const DEFAULT_SCHEDULER_INTERVAL_MS = 45 * 60_000;

export const PLUGINS_TO_ACTIVATE = [
  'momentum-factor-12-1',
  'trend-following',
  'relative-strength',
  'position-sizing',
  'risk-manager',
  'macro-calendar-guard',
  'market-context',
] as const;

export const PLUGINS_TO_DEACTIVATE = [
  'bollinger-squeeze',
  'wyckoff-volume',
  'pairs-trading',
  'session-breakout',
  'mean-reversion',
  'vwap-reversion',
] as const;

export const BOOTSTRAP_APPLIED_KEY = 'bootstrap.momentum_v1_applied';
const UNIVERSE_KEY = 'cycle.universe';
const EXECUTION_REAL_KEY = 'execution.real';
const SCHEDULER_KEY = 'scheduler';

/** Minimal shape this service cares about; the real config carries more fields (see CycleSchedulerService). */
interface SchedulerConfigPatch {
  enabled: boolean;
  override_interval_ms: number;
  [key: string]: unknown;
}

@Injectable()
export class StrategyBootstrapService implements OnModuleInit {
  private readonly log = new Logger(StrategyBootstrapService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly kv: KvService,
  ) {}

  /** Runs on boot. Never throws — a bootstrap failure must never block application startup. */
  async onModuleInit(): Promise<void> {
    try {
      await this.run();
    } catch (err: unknown) {
      this.log.warn(
        `StrategyBootstrapService: bootstrap falló (no bloquea el arranque): ${String(err)}`,
      );
    }
  }

  /** Idempotent PAPER-mode bootstrap of the momentum-rotation strategy. */
  async run(): Promise<void> {
    const alreadyApplied = kvBool(await this.kv.get(BOOTSTRAP_APPLIED_KEY), false);
    if (alreadyApplied) {
      this.log.log('Bootstrap momentum_v1 ya aplicado — no-op');
      return;
    }

    await this.kv.set(UNIVERSE_KEY, MOMENTUM_UNIVERSE);

    for (const id of PLUGINS_TO_ACTIVATE) {
      await this.setPluginActive(id, true);
    }
    for (const id of PLUGINS_TO_DEACTIVATE) {
      await this.setPluginActive(id, false);
    }

    // PAPER MODE ONLY. Never write 'true' here — real execution stays a deliberate,
    // human-gated action. This is the only write this service ever makes to this key.
    await this.kv.set(EXECUTION_REAL_KEY, 'false');

    await this.enableScheduler();

    // Marks the bootstrap as done — MUST be the last write, and only after every
    // preceding step has been attempted, so a partial failure is retried on next boot.
    await this.kv.set(BOOTSTRAP_APPLIED_KEY, 'true');

    this.log.log(
      `Bootstrap momentum_v1 aplicado: universo=${MOMENTUM_UNIVERSE} | ` +
        `activados=[${PLUGINS_TO_ACTIVATE.join(', ')}] | ` +
        `desactivados=[${PLUGINS_TO_DEACTIVATE.join(', ')}] | ` +
        `modo=PAPER (execution.real=false) | scheduler habilitado`,
    );
  }

  /** Per-plugin, fail-soft active-flag write. A missing row or DB error never stops the rest. */
  private async setPluginActive(id: string, active: boolean): Promise<void> {
    try {
      const result = await this.db.plugin.updateMany({ where: { id }, data: { active } });
      if (result.count === 0) {
        this.log.warn(`Bootstrap: plugin '${id}' no encontrado — omitido (fail-soft)`);
      }
    } catch (err: unknown) {
      this.log.warn(
        `Bootstrap: fallo al setear active=${active} en plugin '${id}': ${String(err)}`,
      );
    }
  }

  /** Enables the scheduler, preserving any existing config fields and override_interval_ms. */
  private async enableScheduler(): Promise<void> {
    try {
      const raw = await this.kv.get(SCHEDULER_KEY);
      let current: Record<string, unknown> = {};
      if (raw) {
        try {
          current = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          current = {};
        }
      }
      const existingInterval = current['override_interval_ms'];
      const updated: SchedulerConfigPatch = {
        ...current,
        enabled: true,
        override_interval_ms:
          typeof existingInterval === 'number' ? existingInterval : DEFAULT_SCHEDULER_INTERVAL_MS,
      };
      await this.kv.set(SCHEDULER_KEY, JSON.stringify(updated));
    } catch (err: unknown) {
      this.log.warn(`Bootstrap: fallo al habilitar el scheduler: ${String(err)}`);
    }
  }
}
