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
 * config (universe / execution.real / plugin activation) exactly once, ever, even
 * across redeploys. This is deliberate: an operator may have since enabled real-money
 * mode (TOTP-gated) or customized the universe/plugin set, and a redeploy must never
 * silently reset that.
 *
 * Pretest-portfolio seeding (see PRETEST_PORTFOLIOS_TO_SEED) is gated by its OWN,
 * INDEPENDENT flag (`PRETEST_SEED_KEY`) — it does NOT re-run or depend on the momentum
 * flag above. This lets already-bootstrapped instances (v1 already applied) receive
 * the pretest portfolios on their next boot without re-running the momentum/execution/
 * universe/plugin block. Fresh instances get both blocks on first boot.
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
  // News now comes from the kernel__web_search tool (LLM-driven, on-demand), not this
  // always-on plugin — see apps/api/src/agents/agents.service.ts KERNEL_WEB_SEARCH_TOOL.
  'sentiment-analysis',
] as const;

export const BOOTSTRAP_APPLIED_KEY = 'bootstrap.momentum_v1_applied';
/**
 * Independent idempotency key for pretest-portfolio seeding. Deliberately separate
 * from BOOTSTRAP_APPLIED_KEY so this can be back-filled on already-bootstrapped
 * instances (v1 already set) without re-running the momentum/execution/universe/
 * plugin block — see the module docstring above.
 */
export const PRETEST_SEED_KEY = 'bootstrap.pretest_seed_v5';
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
 *
 * 'Vol-Managed Index' (v3 addition) is DIFFERENT in kind from the other seven:
 * it does not use momentum/trend/relative-strength ranking at all — it holds
 * SPY unconditionally (broad-index-hold) and lets risk-manager's
 * exposure_mode="vol_target" scale total exposure toward a 12% target
 * annualized volatility (20-trading-day realized-vol window, cap=1.0x — no
 * leverage). This reproduces the batch-6 research result (vol-managed SPY:
 * Sharpe 0.96 vs SPY buy-hold's 0.78, roughly half the max drawdown) as REAL
 * plugin code, wired through PretestService.runCycle's exposure_scalar path
 * (see pretest.service.ts). __pretest_policy__.sizing_pct=1.0 so a fully
 * unscaled entry would buy with 100% of cash — exposureScalar is what throttles
 * it down to the target-vol level, not sizing_pct.
 *
 * 'Vol-Managed QQQ' (v4 addition) is the same mechanism applied to QQQ
 * (Nasdaq-100) instead of SPY, with a higher target vol (15%) and a 1.5x
 * exposure cap (light leverage) instead of 1.0x — batch-9 research found this
 * the higher-return sibling of 'Vol-Managed Index' (Sharpe 1.12 vs 0.955,
 * +215% cumulative return, maxDD -22%). Same plugin wiring, same
 * __pretest_policy__ shape (sizing_pct=1.0, exposureScalar does the
 * throttling) — only the held symbol, vol_target_benchmark, target_vol_pct,
 * and exposure_cap differ. Honest caveat kept in its description: the
 * vol-managed edge over buy-and-hold is crash-concentrated (it comes from
 * de-risking ahead of/during high-vol drawdowns, not from steady alpha).
 *
 * 'Vol-Managed TECL (Agresivo)' and 'Vol-Managed SOXL (Agresivo)' (v5 addition)
 * apply the SAME vol_target mechanism to 3x daily-leveraged sector ETFs (TECL =
 * tech, SOXL = semiconductors) instead of an unleveraged broad index. Batch-11
 * research: vol-targeting tames a 3x ETF's raw ~-80% drawdown down to
 * SPY-like risk while preserving most of the leveraged upside — TECL: +286%
 * cumulative return, Sharpe 1.03, maxDD -24.6% (better than SPY's own -34%
 * buy-and-hold drawdown); SOXL: +293% cumulative return, Sharpe 1.04, maxDD
 * -29.6%. Both use target_vol_pct=20 (batch-11 winner setting) and
 * exposure_cap=1.0 — the underlying ETF is already 3x-leveraged, so no
 * ADDITIONAL leverage is applied on top by risk-manager; exposureScalar only
 * throttles exposure DOWN from the 3x baseline toward the target-vol level.
 * Same __pretest_policy__ shape as the other Vol-Managed seeds (sizing_pct=1.0,
 * exposureScalar does the throttling). Honest caveat kept in both descriptions:
 * these are single-sector concentration bets on top of 3x leverage — the
 * batch-11 backtest window covers one bear year, so the result is not proof
 * against a multi-year bear market in that sector.
 */
export const PRETEST_PORTFOLIOS_TO_SEED: PretestPortfolioSeed[] = [
  {
    name: 'Ultra-Conservador Momentum',
    description:
      'Máxima defensa: top 40% del universo (muy diversificado), lookback 12 meses, tamaño de posición ≤5%, con macro-guard.',
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
      'momentum-factor-12-1': { top_pct: 40, lookback_months: 12 },
      'position-sizing': { mode: 'vol_target', max_position_pct: 5 },
      __pretest_policy__: { sizing_pct: 0.03, slippage_pct: 0.0005, commission_pct: 0 },
    },
  },
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
    name: 'Balanceado Momentum',
    description:
      'Punto medio: top 20% del universo, lookback 9 meses, tamaño de posición hasta 12%, con macro-guard.',
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
      'momentum-factor-12-1': { top_pct: 20, lookback_months: 9 },
      'position-sizing': { mode: 'vol_target', max_position_pct: 12 },
      __pretest_policy__: { sizing_pct: 0.1, slippage_pct: 0.0005, commission_pct: 0 },
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
    name: 'Ultra-Agresivo Momentum',
    description:
      'Máxima concentración y reactividad: top 5% del universo, lookback 6 meses, tamaño de posición al máximo (25%), sin frenos macro.',
    initial_capital: 100_000,
    plugin_ids: ['momentum-factor-12-1', 'position-sizing', 'risk-manager'],
    plugin_configs: {
      'momentum-factor-12-1': { top_pct: 5, lookback_months: 6 },
      'position-sizing': { mode: 'vol_target', max_position_pct: 25 },
      __pretest_policy__: { sizing_pct: 0.3, slippage_pct: 0.0005, commission_pct: 0 },
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
  {
    name: 'Relative-Strength Puro',
    description:
      'Solo fuerza relativa cross-sectional (familia distinta al momentum absoluto), tamaño de posición hasta 12%.',
    initial_capital: 100_000,
    plugin_ids: ['relative-strength', 'position-sizing', 'risk-manager'],
    plugin_configs: {
      'position-sizing': { mode: 'vol_target', max_position_pct: 12 },
      __pretest_policy__: { sizing_pct: 0.1, slippage_pct: 0.0005, commission_pct: 0 },
    },
  },
  {
    name: 'Vol-Managed Index',
    description:
      'Volatility-managed SPY exposure (Moreira & Muir 2017 style): holds SPY unconditionally (no ranking, no monthly rebalance) and lets risk-manager scale total exposure toward a 12% target annualized volatility (20d realized-vol window, no leverage). Batch-6 research: Sharpe 0.96 vs SPY buy-hold 0.78.',
    initial_capital: 100_000,
    plugin_ids: ['broad-index-hold', 'risk-manager'],
    plugin_configs: {
      'broad-index-hold': { symbols: 'SPY' },
      'risk-manager': {
        exposure_mode: 'vol_target',
        target_vol_pct: 12,
        vol_window_days: 20,
        exposure_cap: 1.0,
        vol_target_benchmark: 'SPY',
      },
      // sizing_pct=1.0: an UNSCALED entry would use 100% of cash — the
      // exposureScalar computed from risk-manager's exposure_scalar is what
      // actually throttles this down toward the 12%-target-vol level (see
      // PretestService.runCycle's effectivePolicy / volTargetPlugin wiring).
      __pretest_policy__: { sizing_pct: 1.0, slippage_pct: 0.0005, commission_pct: 0 },
    },
  },
  {
    name: 'Vol-Managed QQQ',
    description:
      'Volatility-managed QQQ exposure (Nasdaq-100): holds QQQ unconditionalmente (sin ranking, sin rebalanceo mensual) y deja que risk-manager escale la exposición total hacia un 15% de volatilidad anualizada objetivo (ventana de 20 días de vol realizada, cap de exposición 1.5x — apalancamiento leve). Hermano de mayor retorno de "Vol-Managed Index": investigación batch-9, Sharpe 1.12 vs 0.955 (SPY), +215% retorno acumulado, maxDD -22%. Nota honesta: la ventaja del vol-managed sobre buy-and-hold está concentrada en crashes (de-risking antes/durante caídas de alta volatilidad), no es alfa estable.',
    initial_capital: 100_000,
    plugin_ids: ['broad-index-hold', 'risk-manager'],
    plugin_configs: {
      'broad-index-hold': { symbols: 'QQQ' },
      'risk-manager': {
        exposure_mode: 'vol_target',
        target_vol_pct: 15,
        vol_window_days: 20,
        exposure_cap: 1.5,
        vol_target_benchmark: 'QQQ',
      },
      // sizing_pct=1.0: an UNSCALED entry would use 100% of cash — the
      // exposureScalar computed from risk-manager's exposure_scalar is what
      // actually throttles this down toward the 15%-target-vol level (see
      // PretestService.runCycle's effectivePolicy / volTargetPlugin wiring).
      __pretest_policy__: { sizing_pct: 1.0, slippage_pct: 0.0005, commission_pct: 0 },
    },
  },
  {
    name: 'Vol-Managed TECL (Agresivo)',
    description:
      'Volatility-managed TECL exposure (tech 3x leveraged): holds TECL unconditionalmente (sin ranking, sin rebalanceo mensual) y deja que risk-manager escale la exposición total hacia un 20% de volatilidad anualizada objetivo (ventana de 20 días de vol realizada, cap de exposición 1.0x — sin apalancamiento adicional sobre el ETF, que ya es 3x). Hermano agresivo de mayor retorno validado en investigación batch-11: el vol-targeting doma el drawdown crudo de ~-80% de un ETF 3x hasta un nivel similar al de SPY, con +286% de retorno acumulado, Sharpe 1.03 y maxDD -24.6% (mejor que el -34% del propio SPY buy-and-hold). Nota honesta: es una apuesta de concentración sectorial (tech) sobre apalancamiento 3x — la ventana de backtest de batch-11 cubre un solo año bajista, no es garantía frente a un mercado bajista prolongado en el sector.',
    initial_capital: 100_000,
    plugin_ids: ['broad-index-hold', 'risk-manager'],
    plugin_configs: {
      'broad-index-hold': { symbols: 'TECL' },
      'risk-manager': {
        exposure_mode: 'vol_target',
        target_vol_pct: 20,
        vol_window_days: 20,
        exposure_cap: 1.0,
        vol_target_benchmark: 'TECL',
      },
      // sizing_pct=1.0: an UNSCALED entry would use 100% of cash — the
      // exposureScalar computed from risk-manager's exposure_scalar is what
      // actually throttles this down toward the 20%-target-vol level (see
      // PretestService.runCycle's effectivePolicy / volTargetPlugin wiring).
      __pretest_policy__: { sizing_pct: 1.0, slippage_pct: 0.0005, commission_pct: 0 },
    },
  },
  {
    name: 'Vol-Managed SOXL (Agresivo)',
    description:
      'Volatility-managed SOXL exposure (semiconductores 3x leveraged): holds SOXL unconditionalmente (sin ranking, sin rebalanceo mensual) y deja que risk-manager escale la exposición total hacia un 20% de volatilidad anualizada objetivo (ventana de 20 días de vol realizada, cap de exposición 1.0x — sin apalancamiento adicional sobre el ETF, que ya es 3x). Hermano agresivo validado en investigación batch-11: el vol-targeting doma el drawdown crudo de ~-80% de un ETF 3x, con +293% de retorno acumulado, Sharpe 1.04 y maxDD -29.6%. Nota honesta: es una apuesta de concentración sectorial (semiconductores) sobre apalancamiento 3x — la ventana de backtest de batch-11 cubre un solo año bajista, no es garantía frente a un mercado bajista prolongado en el sector.',
    initial_capital: 100_000,
    plugin_ids: ['broad-index-hold', 'risk-manager'],
    plugin_configs: {
      'broad-index-hold': { symbols: 'SOXL' },
      'risk-manager': {
        exposure_mode: 'vol_target',
        target_vol_pct: 20,
        vol_window_days: 20,
        exposure_cap: 1.0,
        vol_target_benchmark: 'SOXL',
      },
      // sizing_pct=1.0: an UNSCALED entry would use 100% of cash — the
      // exposureScalar computed from risk-manager's exposure_scalar is what
      // actually throttles this down toward the 20%-target-vol level (see
      // PretestService.runCycle's effectivePolicy / volTargetPlugin wiring).
      __pretest_policy__: { sizing_pct: 1.0, slippage_pct: 0.0005, commission_pct: 0 },
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
      await this.seedPretestPortfoliosIfNeeded();
    } catch (err: unknown) {
      this.log.warn(
        `Bootstrap: fallo en seedPretestPortfoliosIfNeeded (no bloquea el resto): ${String(err)}`,
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

  /**
   * Idempotent PAPER-mode bootstrap of the momentum-rotation strategy: universe,
   * plugin activation/deactivation, execution.real='false', and the scheduler.
   * Gated ONLY by BOOTSTRAP_APPLIED_KEY — does NOT seed pretest portfolios (see
   * seedPretestPortfoliosIfNeeded(), gated independently by PRETEST_SEED_KEY).
   */
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

  /**
   * Runs seedPretestPortfolios() gated by PRETEST_SEED_KEY — INDEPENDENTLY of
   * BOOTSTRAP_APPLIED_KEY (the momentum flag). Seeds whenever PRETEST_SEED_KEY is
   * not yet set, regardless of whether the momentum bootstrap already ran on a
   * previous deploy — see the module docstring for why this must stay decoupled.
   */
  private async seedPretestPortfoliosIfNeeded(): Promise<void> {
    const alreadySeeded = kvBool(await this.kv.get(PRETEST_SEED_KEY), false);
    if (alreadySeeded) {
      this.log.log(`Bootstrap: pretest portfolios ya sembrados (${PRETEST_SEED_KEY}) — no-op`);
      return;
    }

    await this.seedPretestPortfolios();

    // MUST be the last write here too, for the same partial-failure-retry reason
    // as BOOTSTRAP_APPLIED_KEY above.
    await this.kv.set(PRETEST_SEED_KEY, 'true');

    this.log.log(
      `Bootstrap: pretest portfolios sembrados=[${PRETEST_PORTFOLIOS_TO_SEED.map((p) => p.name).join(', ')}]`,
    );
  }

  /**
   * Seeds the 7 risk-differentiated virtual pretest portfolios (see
   * PRETEST_PORTFOLIOS_TO_SEED). Called only from seedPretestPortfoliosIfNeeded(),
   * which owns the PRETEST_SEED_KEY idempotency gate — this method itself is not
   * gated, so it must never be called directly outside that wrapper.
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
