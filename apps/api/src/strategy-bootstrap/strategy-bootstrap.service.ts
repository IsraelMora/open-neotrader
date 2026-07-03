import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { KvService } from '../common/kv.service';
import { kvBool } from '../common/kv.util';
import { DEFAULT_STATE as defaultPretestState } from '../pretest/pretest.service';
import { LlmService } from '../llm/llm.service';

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

/** Spec for a single seeded pretest (virtual) portfolio. */
interface PretestPortfolioSeed {
  name: string;
  description: string;
  initial_capital: number;
  plugin_ids: string[];
  plugin_configs: Record<string, Record<string, unknown>>;
}

/**
 * Three risk-differentiated VIRTUAL pretest portfolios, seeded once alongside the
 * momentum-rotation bootstrap. All three trade the SAME global `cycle.universe`
 * (see MOMENTUM_UNIVERSE / UNIVERSE_KEY above) — only their plugin set, factor
 * parameters, and __pretest_policy__ fill assumptions differ.
 *
 * Config keys below were verified against each plugin's actual on_cycle hook
 * (not assumed from the plugin name):
 *   - momentum-factor-12-1 reads config["top_pct"] / config["lookback_months"]
 *     (plugins/momentum-factor-12-1/hooks/cycle.py).
 *   - position-sizing in "vol_target" mode reads config["max_position_pct"]
 *     (percentage POINTS, e.g. 8 = 8%, per plugins/position-sizing/manifest.toml
 *     [config.max_position_pct] range 1-25) and config["default_volatility_pct"].
 *     It does NOT read a "vol_target" key — target volatility is not a config
 *     input to this hook, so that key is intentionally omitted here.
 *   - __pretest_policy__ is PretestService's reserved fill-policy config (never
 *     passed to plugins), read by PretestService._readPolicy().
 */
export const PRETEST_PORTFOLIOS_TO_SEED: PretestPortfolioSeed[] = [
  {
    name: 'Conservador Momentum',
    description:
      'Momentum de baja rotación: top 30% del universo, lookback 12 meses, tamaño de posición acotado al 8%.',
    initial_capital: 100_000,
    plugin_ids: [
      'momentum-factor-12-1',
      'trend-following',
      'relative-strength',
      'position-sizing',
      'risk-manager',
      'macro-calendar-guard',
    ],
    plugin_configs: {
      'momentum-factor-12-1': { top_pct: 30, lookback_months: 12 },
      'position-sizing': { mode: 'vol_target', max_position_pct: 8 },
      __pretest_policy__: { sizing_pct: 0.05, slippage_pct: 0.0005, commission_pct: 0 },
    },
  },
  {
    name: 'Agresivo Momentum',
    description:
      'Momentum concentrado: top 10% del universo, lookback 6 meses, tamaño de posición hasta 25%.',
    initial_capital: 100_000,
    plugin_ids: ['momentum-factor-12-1', 'trend-following', 'position-sizing', 'risk-manager'],
    plugin_configs: {
      'momentum-factor-12-1': { top_pct: 10, lookback_months: 6 },
      'position-sizing': { mode: 'vol_target', max_position_pct: 25 },
      __pretest_policy__: { sizing_pct: 0.2, slippage_pct: 0.0005, commission_pct: 0 },
    },
  },
  {
    name: 'Trend Puro',
    description: 'Solo trend-following (sin factor de momentum), tamaño de posición hasta 15%.',
    initial_capital: 100_000,
    plugin_ids: ['trend-following', 'position-sizing', 'risk-manager'],
    plugin_configs: {
      'position-sizing': { mode: 'vol_target', max_position_pct: 15 },
      __pretest_policy__: { sizing_pct: 0.1, slippage_pct: 0.0005, commission_pct: 0 },
    },
  },
];

/** Minimal shape this service cares about; the real config carries more fields (see CycleSchedulerService). */
interface SchedulerConfigPatch {
  enabled: boolean;
  override_interval_ms: number;
  run_count: number;
  [key: string]: unknown;
}

@Injectable()
export class StrategyBootstrapService implements OnModuleInit {
  private readonly log = new Logger(StrategyBootstrapService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly kv: KvService,
    private readonly llm: LlmService,
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

  /**
   * Runs every independently-guarded bootstrap step. Each step (momentum seeding,
   * Gemini backend switch, ...) has its own idempotency flag and its own try/catch,
   * so a failure in one step can never abort or skip the others.
   */
  async run(): Promise<void> {
    try {
      await this.applyMomentumBootstrap();
    } catch (err: unknown) {
      this.log.warn(
        `Bootstrap: fallo en applyMomentumBootstrap (no bloquea el resto): ${String(err)}`,
      );
    }

    try {
      this.applyLlmConfigFromEnv();
    } catch (err: unknown) {
      this.log.warn(
        `Bootstrap: fallo en applyLlmConfigFromEnv (no bloquea el resto): ${String(err)}`,
      );
    }
  }

  /** Idempotent PAPER-mode bootstrap of the momentum-rotation strategy. */
  private async applyMomentumBootstrap(): Promise<void> {
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
    await this.seedPretestPortfolios();

    // Marks the bootstrap as done — MUST be the last write, and only after every
    // preceding step has been attempted, so a partial failure is retried on next boot.
    await this.kv.set(BOOTSTRAP_APPLIED_KEY, 'true');

    this.log.log(
      `Bootstrap momentum_v1 aplicado: universo=${MOMENTUM_UNIVERSE} | ` +
        `activados=[${PLUGINS_TO_ACTIVATE.join(', ')}] | ` +
        `desactivados=[${PLUGINS_TO_DEACTIVATE.join(', ')}] | ` +
        `modo=PAPER (execution.real=false) | scheduler habilitado | ` +
        `pretest portfolios sembrados=[${PRETEST_PORTFOLIOS_TO_SEED.map((p) => p.name).join(', ')}]`,
    );
  }

  /**
   * Seeds the 3 risk-differentiated virtual pretest portfolios (see
   * PRETEST_PORTFOLIOS_TO_SEED), gated by the SAME bootstrap.momentum_v1_applied
   * flag as the rest of this bootstrap — no separate idempotency key needed.
   *
   * Idempotent by name: PretestPortfolio.name is @unique, so each spec is created
   * only if a row with that name doesn't already exist yet (findUnique-then-create,
   * never upsert — an operator's manual edits to an existing portfolio are never
   * overwritten). Per-portfolio fail-soft: one failure never blocks the rest or the
   * overall bootstrap.
   *
   * Writes directly via PrismaService (not PretestService.create()) to avoid pulling
   * PretestService's full dependency graph (sandbox/LLM/providers/agents/audit) into
   * this boot-time seeder; the row shape mirrors PretestService.create() exactly,
   * including the shared DEFAULT_STATE factory.
   */
  private async seedPretestPortfolios(): Promise<void> {
    for (const spec of PRETEST_PORTFOLIOS_TO_SEED) {
      try {
        const existing = await this.db.pretestPortfolio.findUnique({
          where: { name: spec.name },
        });
        if (existing) {
          this.log.log(`Bootstrap: pretest portfolio '${spec.name}' ya existe — omitido`);
          continue;
        }
        await this.db.pretestPortfolio.create({
          data: {
            name: spec.name,
            description: spec.description,
            initial_capital: spec.initial_capital,
            plugin_ids: JSON.stringify(spec.plugin_ids),
            plugin_configs: JSON.stringify(spec.plugin_configs),
            state: JSON.stringify(defaultPretestState(spec.initial_capital)),
          },
        });
        this.log.log(`Bootstrap: pretest portfolio '${spec.name}' creado`);
      } catch (err: unknown) {
        this.log.warn(
          `Bootstrap: fallo al sembrar pretest portfolio '${spec.name}': ${String(err)}`,
        );
      }
    }
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
      const existingRunCount = current['run_count'];
      const updated: SchedulerConfigPatch = {
        ...current,
        enabled: true,
        override_interval_ms:
          typeof existingInterval === 'number' ? existingInterval : DEFAULT_SCHEDULER_INTERVAL_MS,
        // Cosmetic fix: default run_count to 0 when the scheduler KV is being created
        // (or an existing config is missing the field) — CycleSchedulerService reads
        // cfg.run_count + 1 on the first tick; leaving it undefined would produce NaN.
        run_count: typeof existingRunCount === 'number' ? existingRunCount : 0,
      };
      await this.kv.set(SCHEDULER_KEY, JSON.stringify(updated));
    } catch (err: unknown) {
      this.log.warn(`Bootstrap: fallo al habilitar el scheduler: ${String(err)}`);
    }
  }

  /**
   * Provider-agnostic, deploy-time sync of the LLM backend/model from env vars
   * (LLM_BACKEND, LLM_MODEL). Env is the deployment source of truth for this
   * config, so — unlike the momentum bootstrap — this step has NO version flag
   * and runs on EVERY boot: if the operator changes LLM_BACKEND/LLM_MODEL and
   * redeploys, the change takes effect on next boot without any manual KV reset.
   *
   * Provider-agnostic by design: it never inspects or requires any provider's
   * API key (e.g. GEMINI_API_KEY/ANTHROPIC_API_KEY/OPENAI_API_KEY) — that stays
   * the operator's concern at call time. If the credential for the configured
   * backend is missing, LlmService.getReadiness() already fails loud on its own
   * onModuleInit, which is a separate, existing signal.
   *
   * Idempotent without a flag: reads the CURRENT live config via
   * LlmService.getConfig() and only calls patchConfig() when the env values
   * differ from what's already active — a plain no-op otherwise.
   *
   * Fail-soft: never throws out of onModuleInit (see run()). Never logs any
   * secret — only the backend/model strings, which are not credentials.
   */
  private applyLlmConfigFromEnv(): void {
    const envBackend = process.env.LLM_BACKEND?.trim();
    const envModel = process.env.LLM_MODEL?.trim();

    if (!envBackend || !envModel) {
      this.log.log('LLM_BACKEND/LLM_MODEL no configurados en env — LLM sin cambios');
      return;
    }

    const current = this.llm.getConfig();
    if (current.backend === envBackend && current.model === envModel) {
      this.log.debug(`LLM ya coincide con env (backend=${envBackend} model=${envModel}) — no-op`);
      return;
    }

    this.llm.patchConfig({ backend: envBackend, model: envModel });
    this.log.log(`LLM configurado desde env: backend=${envBackend} model=${envModel}`);
  }
}
