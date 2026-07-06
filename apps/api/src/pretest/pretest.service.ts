/**
 * PretestService — Motor de carteras virtuales para validar estrategias.
 *
 * Permite crear múltiples portfolios virtuales con distintas combinaciones
 * de plugins y parámetros, ejecutarlos contra datos de mercado reales, y
 * comparar su rendimiento ANTES de arriesgar dinero real.
 *
 * Diferencias clave vs paper-trading plugin:
 *   - El paper-trading plugin simula UNA cartera al lado de la real
 *   - Pretest corre N carteras INDEPENDIENTES en paralelo, sin la cartera real
 *   - Cada pretest tiene su propio conjunto de plugins (no los globalmente activos)
 *   - No hay ejecución de órdenes reales en ningún caso
 *   - El objetivo es encontrar la mejor config antes del despliegue real
 *
 * PR1 changes: fill prices now come from ProviderGatewayService.getQuote(null,symbol).last
 * (not from LLM tool-call args). Equity is mark-to-market (live quote per open position),
 * not cost-basis. getQuote failures are handled gracefully: skip fill or fallback to
 * last-known current_price / avg_price for MTM.
 */
import {
  Injectable,
  Logger,
  NotFoundException,
  Inject,
  forwardRef,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SandboxGateway } from '../sandbox/sandbox.gateway';
import { PluginsService, HydratedPlugin } from '../plugins/plugins.service';
import { LlmService } from '../llm/llm.service';
import { ContextMemoryService } from '../context-memory/context-memory.service';
import { ProviderGatewayService } from '../providers/provider-gateway.service';
import { AgentsService } from '../agents/agents.service';
import { KvService } from '../common/kv.service';
import { kvBool, kvNum } from '../common/kv.util';
import { AuditService } from '../audit/audit.service';
import { GovernedPaperExecutionService } from '../execution/governed-paper-execution.service';
import { GovernedAccountState, RiskPolicy } from '../execution/governed-account-state';

/**
 * Per-portfolio fill policy. Stored under plugin_configs['__pretest_policy__'].
 * Defaults reproduce the original hardcoded behavior: 5% sizing, no slippage, no commission.
 */
export interface PretestPolicy {
  sizing_pct: number; // fraction of cash per buy order (default 0.05)
  slippage_pct: number; // adverse price adjustment on fill (default 0)
  commission_pct: number; // fee on notional, charged to cash (default 0)
  /** Borrow-cost accrual on open short notional, charged to cash each
   * _updateEquityMetrics tick (fraction of |short_qty| * mark_price).
   * Default is a small per-cycle drag, mirroring a stock-loan fee. Only ever
   * has an effect when a short position is actually open — zero impact on
   * long-only portfolios (default enable_short=false everywhere). */
  borrow_cost_pct: number;
}

const POLICY_DEFAULTS: PretestPolicy = {
  sizing_pct: 0.05,
  slippage_pct: 0,
  commission_pct: 0,
  borrow_cost_pct: 0.0001,
};

/**
 * Fill-price integrity guard threshold. A simulated fill is rejected when its
 * getQuote.last price deviates from the symbol's latest recent bar close by more
 * than this fraction. Motivated by the 2026-07-04 incident: getQuote.last
 * returned ~half the true price for split-affected ETFs (IWM/SOXL/TECL) on a
 * market-closed weekend, so fills recorded a cost basis ~2x below reality and
 * later marked to phantom +50-85% gains. The bad price was a clean ~100%
 * deviation; 0.5 (50%) catches it with wide margin while still allowing the
 * large-but-real single-day moves that 3x leveraged ETFs (SOXL/TECL) can print.
 * The reference comes from getOhlcv (adjusted close) — a DIFFERENT provider
 * endpoint than getQuote (raw regularMarketPrice) — giving an independent cross-check.
 */
const MAX_FILL_PRICE_DEVIATION = 0.5;

/** Buy & hold benchmark for the alpha gate. SPY = broad US-equity index proxy. */
const BENCHMARK_SYMBOL = 'SPY';

/**
 * Fallback universe when KV `cycle.universe` is unset. Mirrors
 * AgentsService.DEFAULT_UNIVERSE so a pretest cycle and the real agent cycle
 * default to the same instrument set absent explicit operator config.
 */
const DEFAULT_UNIVERSE = [
  'AAPL',
  'MSFT',
  'GOOGL',
  'AMZN',
  'NVDA',
  'META',
  'TSLA',
  'SPY',
  'QQQ',
  'AMD',
];

export interface PretestTrade {
  ts: string;
  symbol: string;
  /**
   * 'short' = sell-to-open (opens/adds to a short position, negative qty).
   * 'cover' = buy-to-close (closes a short position, an exit-class action).
   */
  action: 'buy' | 'sell' | 'close' | 'short' | 'cover';
  price: number;
  quantity: number;
  pnl?: number;
  /** Cost basis per share at entry (avg_price of position when trade was closed). Stored by _applySell/_applyCover. */
  entry_price?: number;
}

export interface PretestPosition {
  symbol: string;
  /** Signed quantity: positive = long, NEGATIVE = short (shares owed). */
  quantity: number;
  /** Entry price. For shorts this is the effective sell-to-open price (net of commission). */
  avg_price: number;
  current_price?: number;
  unrealized_pnl?: number;
}

export interface PretestState {
  equity: number;
  cash: number;
  positions: PretestPosition[];
  trades: PretestTrade[];
  max_equity: number;
  max_drawdown_pct: number;
  realized_pnl: number;
  win_trades: number;
  loss_trades: number;
  /** Buy & hold benchmark return (%) over the portfolio's active span, tracked
   * by _updateEquityMetrics. Undefined until the first benchmark quote resolves;
   * absence makes the alpha gate fail-soft (skipped, never blocks). */
  benchmark_return_pct?: number;
  /** Benchmark price at portfolio inception (first MTM). Internal baseline. */
  benchmark_start_price?: number;
  // ── unify-pretest-execution: kernel risk-floor bookkeeping ──────────────────
  // The same fields GovernedAccountState/GovernedPaperExecutionService.evaluateEntryGate
  // uses for the live paper account — undefined until the first entry-gate evaluation
  // for THIS portfolio (each pretest portfolio has its OWN independent baseline, never
  // shared with the live paper account or with each other).
  /** High-water-mark equity for the drawdown-halt gate. Defaults to `equity` when unset. */
  hwm?: number;
  day_key?: string;
  day_start_equity?: number;
  week_key?: string;
  week_start_equity?: number;
}

export interface PretestPortfolio {
  id: string;
  name: string;
  description: string | null;
  initial_capital: number;
  plugin_ids: string[];
  plugin_configs: Record<string, Record<string, unknown>>;
  state: PretestState;
  run_count: number;
  last_run_at: Date | null;
  is_active: boolean;
  created_at: Date;
}

/** Per-portfolio significance metrics computed on-demand from trades[]. */
export interface SignificanceMetrics {
  /** Per-trade Sharpe (non-annualized, sample std n-1). 0 when n<2 or std=0. */
  sharpe: number;
  /** Σ(positive pnl) / |Σ(negative pnl)|. null when no losing trades. */
  profit_factor: number | null;
  /** win_trades / n_trades. */
  win_rate: number;
  /** max_drawdown_pct from portfolio state. */
  max_dd: number;
  /** Count of closing trades (sell/close) that carry a pnl value. */
  n_trades: number;
  /** Count of closing trades with pnl < 0. Used by gate min_loss_trades check. */
  loss_trades: number;
  /** Portfolio return − buy&hold benchmark return (%). null when no benchmark is
   * tracked or initial_capital is unknown → the alpha gate check is then skipped. */
  alpha_pct: number | null;
  /** Average pnl ($) of winning closing trades. 0 when no winners. */
  avg_win: number;
  /** Average |pnl| ($) of losing closing trades. 0 when no losers. */
  avg_loss: number;
  /** avg_win / avg_loss. null when no losing trades (undefined denominator). */
  payoff_ratio: number | null;
  /**
   * Expectancy per trade ($) — the statistical edge: (win_rate * avg_win) − (loss_rate * avg_loss).
   * Positive expectancy means the strategy has a real edge over its own trade history;
   * negative/zero means it is (on average) not profitable per trade regardless of any
   * single winning streak. loss_rate = loss_trades / n_trades (mirrors win_rate's denominator —
   * both exclude break-even trades with pnl === 0).
   */
  expectancy: number;
}

/** Result of the significance gate evaluation. */
export interface GateResult {
  ready: boolean;
  reasons: string[];
  metrics: SignificanceMetrics;
}

/**
 * Result of computePluginReputation.
 * reputation_score is null when zero gate-READY portfolios contain the plugin (unrated).
 */
export interface ReputationResult {
  ok: true;
  reputation_score: number | null;
  sample: {
    portfolios_count: number;
    avg_sharpe: number;
    avg_return_pct: number;
    worst_dd_pct: number;
  } | null;
}

// ── Reputation formula constants (F3-s3) ─────────────────────────────────────
/** Normalization ceiling for Sharpe ratio: avg_sharpe >= SHARPE_TARGET clamps nSharpe to 1. */
const SHARPE_TARGET = 2.0;
/** Normalization ceiling for return (%): avg_return_pct >= RETURN_TARGET clamps nReturn to 1. */
const RETURN_TARGET = 50;
/** Drawdown tolerance (%): worst_dd_pct >= DD_TOLERANCE clamps nRisk to 0 (worst penalty). */
const DD_TOLERANCE = 50;
/** Weight for Sharpe contribution (risk-adjusted consistency dominates). */
const W_SHARPE = 0.5;
/** Weight for return contribution. */
const W_RETURN = 0.3;
/** Weight for risk (drawdown) contribution. */
const W_RISK = 0.2;

/** Result of a PretestService.promote() call — four possible outcomes. */
export interface PromoteResult {
  ok: boolean;
  /** Set when ok is false — explains the rejection. */
  reason?: 'gate_not_ready' | 'needs_confirmation' | 'gate_error';
  /** Reasons from the significance gate when reason === 'gate_not_ready'. */
  gate_reasons?: string[];
  /** Pending plugin set when reason === 'needs_confirmation'. */
  pending?: {
    plugin_ids: string[];
    plugin_configs: Record<string, Record<string, unknown>>;
  };
  /** Per-plugin apply results when ok === true. */
  applied?: Array<{ plugin_id: string; activated: boolean; config_set: boolean }>;
  /** Per-plugin failures collected during best-effort apply loop. */
  failed?: Array<{ plugin_id: string; step: 'activate' | 'setConfig'; error: string }>;
}

export interface PretestCompare {
  portfolios: Array<{
    id: string;
    name: string;
    equity: number;
    return_pct: number;
    max_drawdown_pct: number;
    total_trades: number;
    win_rate: number;
    realized_pnl: number;
    plugin_count: number;
    gate_status: 'READY' | 'NOT_READY';
    /** Expectancy per trade ($) — see SignificanceMetrics.expectancy. */
    expectancy: number;
    avg_win: number;
    avg_loss: number;
    payoff_ratio: number | null;
  }>;
  winner_by_return: string;
  winner_by_risk_adj: string; // mayor retorno / max_drawdown
}

export const DEFAULT_STATE = (capital: number): PretestState => ({
  equity: capital,
  cash: capital,
  positions: [],
  trades: [],
  max_equity: capital,
  max_drawdown_pct: 0,
  realized_pnl: 0,
  win_trades: 0,
  loss_trades: 0,
});

@Injectable()
export class PretestService {
  private readonly log = new Logger(PretestService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly sandbox: SandboxGateway,
    private readonly plugins: PluginsService,
    private readonly llm: LlmService,
    private readonly memory: ContextMemoryService,
    private readonly gateway: ProviderGatewayService,
    @Inject(forwardRef(() => AgentsService))
    private readonly agents: AgentsService,
    private readonly kv: KvService,
    private readonly audit: AuditService,
    // GovernedPaperExecutionService — the SAME shared kernel-gated execution core
    // TradeIntentService's paper branch uses. @Optional() so every existing direct
    // `new PretestService(...)` test call site (which predates this dependency) keeps
    // working unmodified — see the `governedPaperExec` getter below, which lazily builds
    // one wired to this SAME `gateway`/`audit` when Nest (or a test) doesn't inject it.
    @Optional() private readonly governedPaperExecInjected?: GovernedPaperExecutionService,
  ) {}

  private _governedPaperExec?: GovernedPaperExecutionService;
  /** Lazily-resolved governed-execution core — see constructor doc comment. */
  private get governedPaperExec(): GovernedPaperExecutionService {
    if (!this._governedPaperExec) {
      this._governedPaperExec =
        this.governedPaperExecInjected ??
        new GovernedPaperExecutionService(this.gateway, this.audit);
    }
    return this._governedPaperExec;
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────────

  async create(dto: {
    name: string;
    description?: string;
    initial_capital?: number;
    plugin_ids: string[];
    plugin_configs?: Record<string, Record<string, unknown>>;
  }): Promise<PretestPortfolio> {
    const capital = dto.initial_capital ?? 10_000;
    const row = await this.db.pretestPortfolio.create({
      data: {
        name: dto.name,
        description: dto.description ?? null,
        initial_capital: capital,
        plugin_ids: JSON.stringify(dto.plugin_ids),
        plugin_configs: JSON.stringify(dto.plugin_configs ?? {}),
        state: JSON.stringify(DEFAULT_STATE(capital)),
      },
    });
    return this._hydrate(row);
  }

  /** Lista todos los portfolios de pretest ordenados por fecha de creación descendente. */
  async findAll(): Promise<PretestPortfolio[]> {
    const rows = await this.db.pretestPortfolio.findMany({ orderBy: { created_at: 'desc' } });
    return rows.map((r) => this._hydrate(r));
  }

  /** Devuelve un portfolio por ID; lanza NotFoundException si no existe. */
  async findOne(id: string): Promise<PretestPortfolio> {
    const row = await this.db.pretestPortfolio.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Pretest ${id} no encontrado`);
    return this._hydrate(row);
  }

  /** Actualiza metadatos o configuración de un portfolio (nombre, plugins, config, estado activo). */
  async update(
    id: string,
    dto: {
      name?: string;
      description?: string;
      plugin_ids?: string[];
      plugin_configs?: Record<string, Record<string, unknown>>;
      is_active?: boolean;
    },
  ): Promise<PretestPortfolio> {
    const row = await this.db.pretestPortfolio.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.plugin_ids !== undefined && { plugin_ids: JSON.stringify(dto.plugin_ids) }),
        ...(dto.plugin_configs !== undefined && {
          plugin_configs: JSON.stringify(dto.plugin_configs),
        }),
        ...(dto.is_active !== undefined && { is_active: dto.is_active }),
      },
    });
    return this._hydrate(row);
  }

  /** Resetea el estado virtual del portfolio al capital inicial (borra trades y posiciones). */
  async reset(id: string): Promise<PretestPortfolio> {
    const existing = await this.findOne(id);
    const row = await this.db.pretestPortfolio.update({
      where: { id },
      data: {
        state: JSON.stringify(DEFAULT_STATE(existing.initial_capital)),
        run_count: 0,
        last_run_at: null,
      },
    });
    return this._hydrate(row);
  }

  /** Elimina permanentemente un portfolio de pretest. */
  async delete(id: string): Promise<void> {
    await this.db.pretestPortfolio.delete({ where: { id } });
  }

  // ── Ejecución ─────────────────────────────────────────────────────────────────

  /**
   * Ejecuta un ciclo de pretest para un portfolio virtual.
   * - Corre los skill plugins DECLARADOS por el portfolio (portfolio.plugin_ids),
   *   sin importar si están globalmente activos — el pretest es una simulación
   *   aislada de su propia configuración declarada
   * - Pasa las señales al LLM en modo pretest (sin ejecución real)
   * - Simula el fill de órdenes a precio de mercado real (ProviderGateway.getQuote)
   * - Actualiza equity mark-to-market (MTM) usando quotes reales por posición
   */
  async runCycle(
    id: string,
    systemPrompt?: string,
  ): Promise<{
    portfolio: PretestPortfolio;
    signals: unknown[];
    llm_text: string;
    trades_simulated: PretestTrade[];
  }> {
    const portfolio = await this.findOne(id);
    if (!portfolio.is_active) throw new Error('Portfolio de pretest no está activo');

    this.log.log(`Pretest ciclo: ${portfolio.name} (plugins: ${portfolio.plugin_ids.join(', ')})`);

    // Construir plugins del pretest: TODOS los declarados en portfolio.plugin_ids,
    // sin importar su estado global de activación. Un portfolio de pretest declara
    // su propia configuración de plugins (portfolio.plugin_ids) y debe correrlos
    // siempre — findAll() (no findActive()) es la fuente correcta aquí, porque
    // filtrar sobre "solo los activos globalmente" descarta silenciosamente
    // plugins declarados pero no activados globalmente (p.ej. broad-index-hold),
    // dejando el ciclo sin señales (signalsLen=0) sin ningún error visible.
    // Un id declarado que ya no existe (desinstalado) se descarta fail-soft.
    const allPlugins = await this.plugins.findAll();
    const pretestPlugins = allPlugins.filter((p: HydratedPlugin) =>
      portfolio.plugin_ids.includes(p.id),
    );

    // Aplicar config overrides del pretest
    const pluginsWithOverrides = pretestPlugins.map((p: HydratedPlugin) => ({
      ...p,
      config: {
        ...(p.config ?? {}),
        ...(portfolio.plugin_configs[p.id] ?? {}),
      },
    }));

    const pluginIds = pluginsWithOverrides.map((p: HydratedPlugin) => p.id);

    // Per-plugin effective config (manifest/persisted defaults overlaid with
    // portfolio.plugin_configs[pluginId]), keyed by plugin id. runner.py's
    // cmd_run_cycle layers this on top of each plugin's manifest [config] defaults
    // for that plugin ONLY — this is what makes different pretest portfolios that
    // share a plugin (e.g. momentum-factor-12-1 with different top_pct/lookback_months)
    // actually diverge instead of all running with identical manifest defaults.
    const pluginConfigs: Record<string, Record<string, unknown>> = {};
    for (const p of pluginsWithOverrides) {
      pluginConfigs[p.id] = p.config;
    }

    // ── Vol-target exposure scalar (opt-in) ────────────────────────────────────
    // If a discipline plugin in this portfolio is configured with
    // exposure_mode:'vol_target' (risk-manager), invoke its on_cycle hook
    // directly — mirrors AgentsService._runVetoLayer's run_hook pattern — to
    // obtain a continuous exposure_scalar ∈ [0, cap] driven by REAL realized
    // volatility (plugins/risk-manager/scripts/risk_manager_core.py
    // compute_vol_target_exposure). Portfolios that never set exposure_mode
    // get exposureScalar=1 — a pure no-op, existing behavior fully unchanged.
    const volTargetPlugin = pluginsWithOverrides.find(
      (p: HydratedPlugin) =>
        p.type === 'discipline' && pluginConfigs[p.id]?.['exposure_mode'] === 'vol_target',
    );
    // The vol_target hook needs the benchmark symbol's own OHLCV to compute realized
    // volatility. The benchmark (e.g. 'TECL', 'SOXL') is often NOT a member of the
    // global `cycle.universe` momentum ranking set — it's the symbol this specific
    // Vol-Managed portfolio unconditionally holds via broad-index-hold, not something
    // ranked by momentum/trend hooks. Without this, ctx["ohlcv"][benchmark] is empty,
    // compute_vol_target_exposure has no bars to work with, and returns None ->
    // exposure_scalar collapses to the 0.0 fail-safe -> the portfolio NEVER trades.
    // Fetching it here (in addition to `universe`) ensures the benchmark's real bars
    // reach the hook regardless of whether it's also in the momentum universe.
    const volTargetBenchmark = volTargetPlugin
      ? (() => {
          const raw = pluginConfigs[volTargetPlugin.id]?.['vol_target_benchmark'];
          return typeof raw === 'string' && raw.trim() ? raw : 'SPY';
        })()
      : undefined;

    // Market data for the strategy hooks: resolve the SAME `cycle.universe` KV key the
    // real agent cycle reads (AgentsService._buildMarketContext) and fetch OHLCV so
    // universe-dependent hooks (momentum-factor-12-1, trend-following, ...) receive
    // real data. Without this, ctx["universe"] stays empty and those hooks never emit
    // a signal — the portfolio would never trade. `volTargetBenchmark` is unioned into
    // the fetch (but NOT into `universe` itself — it must not pollute momentum ranking).
    const market = await this._buildMarketContext(volTargetBenchmark ? [volTargetBenchmark] : []);

    let exposureScalar = 1;
    if (volTargetPlugin) {
      try {
        const hookResp = await this.sandbox.call({
          cmd: 'run_hook',
          plugin_id: volTargetPlugin.id,
          hook: 'on_cycle',
          context: {
            pending_signals: [],
            portfolio: this._positionsToPortfolioDict(portfolio.state),
            positions: portfolio.state.positions,
            portfolio_value: portfolio.state.equity,
            ohlcv: market.ohlcv,
            config: pluginConfigs[volTargetPlugin.id],
          },
        });
        const raw = (hookResp.result as Record<string, unknown> | undefined)?.['exposure_scalar'];
        // Fail-safe: hook error, missing key, or a non-finite/negative value
        // all collapse to 0 exposure (stay in cash) — never silently fall
        // back to "fully invested" when the real scalar couldn't be obtained.
        exposureScalar = typeof raw === 'number' && isFinite(raw) && raw >= 0 ? raw : 0;
      } catch (err) {
        this.log.warn(`vol_target exposure hook failed for ${volTargetPlugin.id}: ${String(err)}`);
        exposureScalar = 0;
        await this._auditVolTargetExposureFailure(id, portfolio.name, volTargetPlugin.id, err);
      }
    }

    // ── Ciclo de señales ──────────────────────────────────────────────────────
    const cycleCtx: Record<string, unknown> = {
      pretest_mode: true,
      pretest_id: id,
      universe: market.universe,
      ohlcv: market.ohlcv,
      // Legacy global config left empty: this pretest engine always differentiates
      // per plugin via plugin_configs below, never via a single shared config.
      config: {},
      plugin_configs: pluginConfigs,
      portfolio: this._positionsToPortfolioDict(portfolio.state),
      portfolio_state: portfolio.state,
      portfolio_value: portfolio.state.equity,
    };

    const hookResult = await this.sandbox.runCycle(pluginIds, cycleCtx);
    const hookCtx = (hookResult.result ?? cycleCtx) as Record<string, unknown>;
    const signals: unknown[] = Array.isArray(hookCtx['pending_signals'])
      ? (hookCtx['pending_signals'] as unknown[])
      : [];

    // ── LLM en modo pretest ───────────────────────────────────────────────────
    const memCtx = await this.memory.toContextString();
    const context = [
      memCtx,
      `[PRETEST: ${portfolio.name}]`,
      `[Capital virtual: $${portfolio.state.equity.toFixed(2)}]`,
      `[SEÑALES PRETEST]\n${JSON.stringify(signals, null, 2)}`,
      systemPrompt ?? '',
      '\nEres un agente en modo PRETEST/paper. Las órdenes son virtuales (no reales), pero DEBÉS emitir emit_trade_intent para registrar cada decisión que tomarías — no te limites a describirla en texto.',
    ]
      .filter(Boolean)
      .join('\n\n');

    // Route the LLM call through the governed turn kernel (audit, tool validation, virtual guard).
    // virtual_only:true ensures no provider (broker) tool-calls reach the sandbox.
    const turnResult = await this.agents.runGovernedTurn({
      source: 'pretest',
      context,
      virtual_only: true,
    });

    // ── Deterministic passive-holder execution (broad-index-hold and friends) ──
    // A passive-hold strategy (e.g. broad-index-hold: "hold the configured index
    // at the vol-target exposure") is a deterministic rule, not an LLM judgment
    // call. Its emitted signal is often the ONLY signal in the cycle, which is
    // not compelling enough to make the (light) pretest LLM actually call
    // emit_trade_intent — it just describes the decision in text instead,
    // leaving `turnResult.tool_calls` empty and the portfolio stuck at 0 trades.
    // See `_synthesizePassiveHoldToolCalls` for the merge+de-dup logic; the
    // result is fed through the SAME kernel risk floor + exposure-scaled fill
    // path as everything else below.
    const mergedToolCalls = this._synthesizePassiveHoldToolCalls(signals, turnResult.tool_calls);

    // ── Leer política de fills del portfolio ──────────────────────────────────
    const policy = this._readPolicy(portfolio);
    // Vol-target scaling: new-entry sizing is throttled by exposureScalar (1 = no-op).
    // This is the "gate new entries" half of the mechanism; the other half —
    // rebalancing EXISTING positions toward the scalar — is _buildVolTargetRebalanceTrades below.
    const effectivePolicy: PretestPolicy =
      exposureScalar === 1 ? policy : { ...policy, sizing_pct: policy.sizing_pct * exposureScalar };

    // ── Kernel risk floor (shared with the live paper/real account) ───────────
    // Gates NEW ENTRIES (long/short) through GovernedPaperExecutionService.evaluateEntryGate
    // BEFORE they ever reach _simulateFills — pretest previously had NO risk floor at all.
    // exit/hold are never gated (closeability invariant). A rejected entry is stripped here
    // (never fills) and recorded via a 'pretest_entry_rejected' audit event. `gated.state`
    // carries forward any hwm/day-week baseline changes and MUST be used for every
    // downstream step. `mergedToolCalls` includes the synthesized passive-holder calls
    // above, so a drawdown-halted (or otherwise gated) passive portfolio never buys.
    const gated = await this._applyKernelRiskFloor(
      id,
      portfolio.name,
      mergedToolCalls,
      portfolio.state,
    );

    // ── Simular fills (async: price from getQuote.last + slippage) ────────────
    // Use validated tool_calls from the governed turn (providers already dropped by virtual
    // guard, and now also filtered by the kernel risk floor above). Reference closes from
    // the already-fetched market bars arm the fill-price integrity guard at no extra cost.
    const referenceCloses = this._latestCloses(market.ohlcv);
    const trades = await this._simulateFills(
      gated.toolCalls,
      gated.state,
      effectivePolicy,
      referenceCloses,
    );

    // ── Vol-target rebalance of EXISTING long positions toward exposureScalar ──
    const rebalanceTrades = volTargetPlugin
      ? await this._buildVolTargetRebalanceTrades(gated.state, exposureScalar, referenceCloses)
      : [];

    // Actualizar estado virtual (sync trade application + commission, async MTM equity)
    const newState = this._applyTrades(
      gated.state,
      [...trades, ...rebalanceTrades],
      effectivePolicy,
    );
    await this._updateEquityMetrics(newState, effectivePolicy, referenceCloses);

    await this.db.pretestPortfolio.update({
      where: { id },
      data: {
        state: JSON.stringify(newState),
        run_count: { increment: 1 },
        last_run_at: new Date(),
      },
    });

    return {
      portfolio: { ...portfolio, state: newState },
      signals,
      llm_text: turnResult.text,
      trades_simulated: trades,
    };
  }

  /**
   * Ejecuta UN ciclo para TODOS los portfolios activos, SECUENCIALMENTE.
   *
   * Deliberately sequential (not Promise.all): N portfolios share the same
   * universe, so running them concurrently would burst N LLM calls + N×|universe|
   * OHLCV fetches per tick and rate-limit a shared (often free-tier) provider/LLM.
   * One portfolio at a time keeps load bounded; fail-soft per portfolio so one
   * failure never aborts the rest.
   */
  async runAllActive(): Promise<Array<{ id: string; name: string; ok: boolean; error?: string }>> {
    const active = await this.db.pretestPortfolio.findMany({ where: { is_active: true } });
    const results: Array<{ id: string; name: string; ok: boolean; error?: string }> = [];
    for (const p of active) {
      try {
        await this.runCycle(p.id);
        results.push({ id: p.id, name: p.name, ok: true });
      } catch (err) {
        results.push({ id: p.id, name: p.name, ok: false, error: String(err) });
      }
    }
    return results;
  }

  /** Comparativa de rendimiento entre todos los portfolios de pretest. */
  async compare(): Promise<PretestCompare> {
    const all = await this.findAll();
    if (all.length === 0) return { portfolios: [], winner_by_return: '', winner_by_risk_adj: '' };

    // Read gate thresholds once for all portfolios
    const thresholds = await this._readGateThresholds();

    const stats = all.map((p) => {
      const return_pct = (p.state.equity - p.initial_capital) / p.initial_capital;
      const risk_adj =
        p.state.max_drawdown_pct > 0 ? return_pct / p.state.max_drawdown_pct : return_pct;
      const metrics = this.computeSignificance(p.state, p.initial_capital);
      // Use computeSignificance win_rate (closing trades only) for consistency —
      // avoids the deflation bug where total_trades included buy records.
      const reasons = this._evaluateGate(metrics, thresholds);
      const gate_status: 'READY' | 'NOT_READY' = reasons.length === 0 ? 'READY' : 'NOT_READY';
      return {
        id: p.id,
        name: p.name,
        equity: p.state.equity,
        return_pct: return_pct * 100,
        max_drawdown_pct: p.state.max_drawdown_pct,
        total_trades: p.state.trades.length,
        win_rate: metrics.win_rate * 100,
        realized_pnl: p.state.realized_pnl,
        plugin_count: p.plugin_ids.length,
        gate_status,
        expectancy: metrics.expectancy,
        avg_win: metrics.avg_win,
        avg_loss: metrics.avg_loss,
        payoff_ratio: metrics.payoff_ratio,
        _risk_adj: risk_adj,
      };
    });

    // Exclude NOT_READY portfolios from winner selection
    const eligible = stats.filter((s) => s.gate_status === 'READY');
    const pool = eligible.length > 0 ? eligible : [];

    const winnerReturn =
      pool.length > 0
        ? pool.reduce((a, b) => (b.return_pct > a.return_pct ? b : a), pool[0])
        : null;
    const winnerRiskAdj =
      pool.length > 0 ? pool.reduce((a, b) => (b._risk_adj > a._risk_adj ? b : a), pool[0]) : null;

    return {
      portfolios: stats.map(({ _risk_adj: _, ...rest }) => rest),
      winner_by_return: winnerReturn?.name ?? '',
      winner_by_risk_adj: winnerRiskAdj?.name ?? '',
    };
  }

  // ── Significance Gate ─────────────────────────────────────────────────────────

  /**
   * Computes significance metrics on-demand from the portfolio state's trades[].
   * Only closing trades (sell/close) with a pnl value are included.
   * Per-trade return: r_i = pnl_i / (entry_price_i * qty_i)
   *   where entry_price_i is the cost-basis avg_price stored by _applySell.
   *   Falls back to t.price (exit fill price) for old records missing entry_price.
   * Sharpe: mean(r) / sample_std(r, n-1). Returns 0 when n<2 or std=0.
   * profit_factor: Σ(+pnl) / |Σ(-pnl)|. null when no losing trades (gate checks loss_trades separately).
   * win_rate: count(pnl>0) / n_trades.
   * loss_trades: count(pnl<0).
   * max_dd: state.max_drawdown_pct.
   */
  computeSignificance(state: PretestState, initialCapital?: number): SignificanceMetrics {
    // Alpha = portfolio return − buy&hold benchmark return. Requires both a tracked
    // benchmark and a known initial_capital; otherwise null (gate skips the check).
    const alpha_pct =
      state.benchmark_return_pct !== undefined && initialCapital !== undefined && initialCapital > 0
        ? ((state.equity - initialCapital) / initialCapital) * 100 - state.benchmark_return_pct
        : null;

    // Only closing trades with a pnl field are included in significance computation
    const closingTrades = state.trades.filter(
      (t) => (t.action === 'sell' || t.action === 'close') && t.pnl !== undefined,
    );
    const n = closingTrades.length;

    if (n === 0) {
      return {
        sharpe: 0,
        profit_factor: null,
        win_rate: 0,
        max_dd: state.max_drawdown_pct,
        n_trades: 0,
        loss_trades: 0,
        alpha_pct,
        avg_win: 0,
        avg_loss: 0,
        payoff_ratio: null,
        expectancy: 0,
      };
    }

    // Per-trade return: r_i = pnl_i / (entry_price_i * quantity_i)
    // entry_price is the cost-basis (avg_price at position open), stored by _applySell.
    // Fall back to t.price (exit fill price) for legacy records missing entry_price.
    const returns = closingTrades.map((t) => {
      const basis_price = t.entry_price ?? t.price;
      const cost_basis = basis_price * t.quantity;
      return cost_basis > 0 ? t.pnl! / cost_basis : 0;
    });

    // Sharpe: mean / sample std (n-1)
    const mean = returns.reduce((sum, r) => sum + r, 0) / n;
    let sharpe = 0;
    if (n >= 2) {
      const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (n - 1);
      const std = Math.sqrt(variance);
      // Use a relative tolerance to guard against floating-point residuals when all returns are equal.
      // If std is negligibly small relative to |mean| (or absolutely tiny), treat as 0.
      const REL_EPSILON = 1e-10;
      const effectively_zero =
        std <= REL_EPSILON || (Math.abs(mean) > 0 && std / Math.abs(mean) <= REL_EPSILON);
      sharpe = effectively_zero ? 0 : mean / std;
    }

    // profit_factor / win_rate / expectancy tracking — extracted to keep this function's
    // cognitive complexity within the sonarjs limit (see _computeWinLossStats doc comment).
    const winLoss = this._computeWinLossStats(closingTrades, n);

    return {
      sharpe,
      profit_factor: winLoss.profit_factor,
      win_rate: winLoss.win_rate,
      max_dd: state.max_drawdown_pct,
      n_trades: n,
      loss_trades: winLoss.losses,
      alpha_pct,
      avg_win: winLoss.avg_win,
      avg_loss: winLoss.avg_loss,
      payoff_ratio: winLoss.payoff_ratio,
      expectancy: winLoss.expectancy,
    };
  }

  /**
   * profit_factor / win_rate / expectancy-tracking stats from a set of closing trades —
   * extracted from computeSignificance to keep its cognitive complexity within the sonarjs
   * limit. See SignificanceMetrics doc comment for the field definitions.
   */
  private _computeWinLossStats(
    closingTrades: PretestTrade[],
    n: number,
  ): {
    profit_factor: number | null;
    win_rate: number;
    losses: number;
    avg_win: number;
    avg_loss: number;
    payoff_ratio: number | null;
    expectancy: number;
  } {
    let sumPos = 0;
    let sumNeg = 0;
    let wins = 0;
    let losses = 0;
    for (const t of closingTrades) {
      const pnl = t.pnl!;
      if (pnl > 0) {
        sumPos += pnl;
        wins++;
      } else if (pnl < 0) {
        sumNeg += Math.abs(pnl);
        losses++;
      }
    }
    const profit_factor: number | null = sumNeg > 0 ? sumPos / sumNeg : null;
    const win_rate = wins / n;
    const loss_rate = losses / n;

    const avg_win = wins > 0 ? sumPos / wins : 0;
    const avg_loss = losses > 0 ? sumNeg / losses : 0;
    const payoff_ratio = avg_loss > 0 ? avg_win / avg_loss : null;
    const expectancy = win_rate * avg_win - loss_rate * avg_loss;

    return {
      profit_factor,
      win_rate,
      losses,
      avg_win: Math.round(avg_win * 100) / 100,
      avg_loss: Math.round(avg_loss * 100) / 100,
      payoff_ratio: payoff_ratio !== null ? Math.round(payoff_ratio * 10000) / 10000 : null,
      expectancy: Math.round(expectancy * 100) / 100,
    };
  }

  /**
   * Evaluates significance gate for a portfolio by ID.
   * Reads thresholds from KvService (system-wide config), falling back to defaults.
   * Returns { ready, reasons, metrics }.
   *
   * F3-s3: When ready===true, fires a fire-and-forget recompute of reputation_score
   * for each plugin in the portfolio. Recompute failures are WARN-logged and NEVER
   * alter the gate result or delay the caller.
   */
  async gate(id: string): Promise<GateResult> {
    const portfolio = await this.findOne(id);
    const metrics = this.computeSignificance(portfolio.state, portfolio.initial_capital);
    const thresholds = await this._readGateThresholds();
    const reasons = this._evaluateGate(metrics, thresholds);
    const ready = reasons.length === 0;

    if (ready) {
      // Fire-and-forget: reputation recompute must NEVER affect the gate result or delay caller
      void this._recomputePluginReputations(portfolio.plugin_ids).catch((e: unknown) =>
        this.log.warn(`reputation recompute failed: ${(e as Error).message}`),
      );
    }

    return { ready, reasons, metrics };
  }

  /**
   * Computes a composite reputation score (0–100) for a plugin based on gate-READY
   * pretest portfolios that contain it.
   *
   * Attribution is portfolio-level: all plugins in a gate-ready portfolio share credit
   * from that portfolio's performance metrics. Per-trade attribution is deferred (F3-s3
   * non-goal). This approximation is documented here and in the spec.
   *
   * Returns null reputation_score when zero gate-READY portfolios contain the plugin.
   * Never throws for an unknown pluginId (unknown id = 0 containing portfolios → null).
   *
   * Cost guard: evaluates gate readiness IN-MEMORY via computeSignificance + _evaluateGate
   * with thresholds read ONCE. Never calls this.gate(id) per portfolio (would be O(N) DB+KV).
   */
  async computePluginReputation(pluginId: string): Promise<ReputationResult> {
    // Step 1: Load all portfolios (hydrated, with state + plugin_ids)
    const all = await this.findAll();

    // Step 2: Filter to portfolios containing this plugin
    const containing = all.filter((p) => p.plugin_ids.includes(pluginId));
    if (containing.length === 0) {
      return { ok: true, reputation_score: null, sample: null };
    }

    // Step 3: Read gate thresholds ONCE (cost guard — never call this.gate per portfolio)
    const thresholds = await this._readGateThresholds();

    // Step 4: Filter to gate-READY portfolios using in-memory evaluation
    const ready = containing.filter((p) => {
      const metrics = this.computeSignificance(p.state, p.initial_capital);
      const reasons = this._evaluateGate(metrics, thresholds);
      return reasons.length === 0;
    });

    if (ready.length === 0) {
      return { ok: true, reputation_score: null, sample: null };
    }

    // Step 5: Aggregate metrics across gate-ready portfolios
    let sumSharpe = 0;
    let sumReturnPct = 0;
    let worstDdPct = 0;

    for (const p of ready) {
      const metrics = this.computeSignificance(p.state, p.initial_capital);
      sumSharpe += metrics.sharpe;
      const returnPct = ((p.state.equity - p.initial_capital) / p.initial_capital) * 100;
      sumReturnPct += returnPct;
      if (p.state.max_drawdown_pct > worstDdPct) {
        worstDdPct = p.state.max_drawdown_pct;
      }
    }

    const n = ready.length;
    const avg_sharpe = sumSharpe / n;
    const avg_return_pct = sumReturnPct / n;
    const worst_dd_pct = worstDdPct;

    // Step 6: Apply composite formula
    const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
    const nSharpe = clamp(avg_sharpe / SHARPE_TARGET, 0, 1);
    const nReturn = clamp(avg_return_pct / RETURN_TARGET, 0, 1);
    const nRisk = clamp(1 - worst_dd_pct / DD_TOLERANCE, 0, 1);
    const raw = W_SHARPE * nSharpe + W_RETURN * nReturn + W_RISK * nRisk;
    const reputation_score = Math.round(clamp(raw, 0, 1) * 100 * 10) / 10; // round to 1 decimal

    return {
      ok: true,
      reputation_score,
      sample: { portfolios_count: n, avg_sharpe, avg_return_pct, worst_dd_pct },
    };
  }

  /**
   * Recomputes and persists reputation_score for each plugin in the given list.
   * Per-plugin try/catch: one failure never prevents other plugins from being updated.
   * Silently catches P2025 (record not found) and any other error — logs WARN only.
   */
  private async _recomputePluginReputations(pluginIds: string[]): Promise<void> {
    for (const id of pluginIds) {
      try {
        const result = await this.computePluginReputation(id);
        const reputation_detail = result.sample
          ? JSON.stringify({ ...result.sample, computed_at: new Date().toISOString() })
          : null;
        await this.db.plugin.update({
          where: { id },
          data: {
            reputation_score: result.reputation_score,
            reputation_detail,
          },
        });
      } catch (e: unknown) {
        this.log.warn(`reputation persist failed for plugin ${id}: ${(e as Error).message}`);
      }
    }
  }

  /** Reads gate thresholds from KvService, falling back to defaults on missing/NaN.
   * Clamps values to valid ranges to prevent misconfiguration from silently breaking the gate:
   *   max_dd_pct  must be in (0, 100] — a value like 0.20 (fraction) would mean 0.20% and
   *               reject everything; coerce out-of-range values to the 20% default.
   *   min_sharpe  must be >= 0 (negative Sharpe threshold is meaningless).
   *   min_trades  must be >= 1 (zero would mean n_trades=0 passes, defeating the purpose).
   *   min_loss_trades must be >= 0 (zero is a valid "disabled" setting).
   */
  private async _readGateThresholds(): Promise<{
    min_trades: number;
    min_sharpe: number;
    max_dd_pct: number;
    min_loss_trades: number;
    min_alpha: number;
  }> {
    const [rawMinTrades, rawMinSharpe, rawMaxDd, rawMinLossTrades, rawMinAlpha] = await Promise.all(
      [
        this.kv.get('pretest.gate.min_trades'),
        this.kv.get('pretest.gate.min_sharpe'),
        this.kv.get('pretest.gate.max_dd_pct'),
        this.kv.get('pretest.gate.min_loss_trades'),
        this.kv.get('pretest.gate.min_alpha'),
      ],
    );

    const min_trades_raw = kvNum(rawMinTrades, 20);
    const min_sharpe_raw = kvNum(rawMinSharpe, 1.0);
    const max_dd_pct_raw = kvNum(rawMaxDd, 20);
    const min_loss_trades_raw = kvNum(rawMinLossTrades, 3);
    // Default 0: a promotable strategy must at least MATCH buy & hold. A negative
    // threshold (operator opt-in) tolerates mild underperformance; no upper clamp.
    const min_alpha = kvNum(rawMinAlpha, 0);

    // Clamp: max_dd_pct must be in [1, 100] — anything below 1 almost certainly indicates
    // a fraction was stored (e.g. 0.20 meaning 20%) rather than a percentage; coerce to default 20.
    const max_dd_pct = max_dd_pct_raw >= 1 && max_dd_pct_raw <= 100 ? max_dd_pct_raw : 20;
    // Clamp: min_sharpe must be >= 0
    const min_sharpe = min_sharpe_raw >= 0 ? min_sharpe_raw : 0;
    // Clamp: min_trades must be >= 1
    const min_trades = min_trades_raw >= 1 ? min_trades_raw : 1;
    // Clamp: min_loss_trades must be >= 0
    const min_loss_trades = min_loss_trades_raw >= 0 ? min_loss_trades_raw : 0;

    return { min_trades, min_sharpe, max_dd_pct, min_loss_trades, min_alpha };
  }

  /** Evaluates metrics against thresholds and returns a list of failure reasons. */
  private _evaluateGate(
    metrics: SignificanceMetrics,
    thresholds: {
      min_trades: number;
      min_sharpe: number;
      max_dd_pct: number;
      min_loss_trades: number;
      min_alpha: number;
    },
  ): string[] {
    const reasons: string[] = [];
    if (metrics.n_trades < thresholds.min_trades) {
      reasons.push(`min_trades not met: ${metrics.n_trades} < ${thresholds.min_trades}`);
    }
    if (metrics.sharpe < thresholds.min_sharpe) {
      reasons.push(`min_sharpe not met: ${metrics.sharpe.toFixed(4)} < ${thresholds.min_sharpe}`);
    }
    if (metrics.max_dd > thresholds.max_dd_pct) {
      reasons.push(`max_dd exceeded: ${metrics.max_dd.toFixed(2)}% > ${thresholds.max_dd_pct}%`);
    }
    // A strategy with zero (or too few) losses has never been stress-tested — canonical overfit.
    // profit_factor=null (no losses) now FAILS this check when min_loss_trades > 0.
    if (metrics.loss_trades < thresholds.min_loss_trades) {
      reasons.push(
        `insufficient loss trades: ${metrics.loss_trades} < ${thresholds.min_loss_trades} (cannot validate risk on a strategy that never lost)`,
      );
    }
    // Alpha gate: a strategy that does not beat buy & hold destroys value and must
    // not reach live. Fail-soft: skipped entirely when no benchmark is tracked
    // (alpha_pct === null), so existing portfolios are never retroactively blocked.
    if (metrics.alpha_pct !== null && metrics.alpha_pct < thresholds.min_alpha) {
      reasons.push(
        `negative alpha vs buy&hold: ${metrics.alpha_pct.toFixed(2)}% < ${thresholds.min_alpha}% (strategy underperforms simply holding)`,
      );
    }
    return reasons;
  }

  // ── Gated promotion ──────────────────────────────────────────────────────────

  /**
   * Promotes a gate-ready pretest portfolio to live by activating its plugin set
   * and applying per-plugin config overrides via PluginsService.
   *
   * Three-outcome state machine (strict order):
   *  1. gate_not_ready  — gate.ready===false; NEVER activates/sets config; audits promotion_gate_blocked.
   *  2. needs_confirmation — gate ready but human confirm required (default) and not provided.
   *  3. applied — gate ready AND (confirm provided OR operator disabled confirm); best-effort apply.
   *
   * Fail-safe parse for require_human_confirm: only the literal string 'false' disables it.
   * Any other value (null, missing, 'true', 'yes', ...) keeps it enabled.
   */
  async promote(id: string, opts?: { confirm?: boolean }): Promise<PromoteResult> {
    // Step 1: findOne — NotFoundException propagates (404 at REST, caught at kernel dispatch).
    const pf = await this.findOne(id);

    // Step 2: GATE HARD CHECK — cannot be bypassed.
    // gate() throw (unexpected error) → fail-closed with gate_error; does NOT activate/setConfig.
    let g: GateResult;
    try {
      g = await this.gate(id);
    } catch (gateErr: unknown) {
      const errMsg = gateErr instanceof Error ? gateErr.message : String(gateErr);
      await this.audit.log({
        event_type: 'promotion_gate_blocked',
        meta: { pretest_id: id, error: errMsg },
      });
      return { ok: false, reason: 'gate_error' };
    }
    if (!g.ready) {
      await this.audit.log({
        event_type: 'promotion_gate_blocked',
        meta: { pretest_id: id, reasons: g.reasons },
      });
      return { ok: false, reason: 'gate_not_ready', gate_reasons: g.reasons };
    }

    // Step 3: HUMAN-CONFIRM — fail-safe parse: only literal 'false' disables.
    const rawConfirm = await this.kv.get('promotion.require_human_confirm');
    const requireConfirm = kvBool(rawConfirm, true);

    if (requireConfirm && !opts?.confirm) {
      return {
        ok: false,
        reason: 'needs_confirmation',
        pending: {
          plugin_ids: pf.plugin_ids,
          plugin_configs: pf.plugin_configs,
        },
      };
    }

    // Step 4: APPLY — best-effort per-plugin loop; never abort on single failure.
    const confirmedBy: 'human' | 'operator_disabled' = opts?.confirm
      ? 'human'
      : 'operator_disabled';
    const { applied, failed } = await this._applyPlugins(pf.plugin_ids, pf.plugin_configs);

    const partial = failed.length > 0;
    const failedIds = failed.map((f) => f.plugin_id);

    // Step 5: Single audit event for the full apply.
    await this.audit.log({
      event_type: 'pretest_promoted',
      meta: {
        pretest_id: id,
        confirmed_by: confirmedBy,
        applied,
        failed,
        partial,
        failed_ids: failedIds,
        gate_metrics: g.metrics,
      },
    });

    return { ok: true, applied, failed };
  }

  /**
   * Best-effort per-plugin activation and config application.
   * Never aborts on individual plugin failure; collects applied[] / failed[].
   */
  private async _applyPlugins(
    pluginIds: string[],
    pluginConfigs: Record<string, Record<string, unknown>>,
  ): Promise<{
    applied: Array<{ plugin_id: string; activated: boolean; config_set: boolean }>;
    failed: Array<{ plugin_id: string; step: 'activate' | 'setConfig'; error: string }>;
  }> {
    const applied: Array<{ plugin_id: string; activated: boolean; config_set: boolean }> = [];
    const failed: Array<{ plugin_id: string; step: 'activate' | 'setConfig'; error: string }> = [];

    for (const pluginId of pluginIds) {
      let activated = false;
      let config_set = false;

      try {
        await this.plugins.activate(pluginId);
        activated = true;
      } catch (err: unknown) {
        const error = err instanceof Error ? err.message : String(err);
        failed.push({ plugin_id: pluginId, step: 'activate', error });
        applied.push({ plugin_id: pluginId, activated: false, config_set: false });
        continue;
      }

      if (Object.prototype.hasOwnProperty.call(pluginConfigs, pluginId)) {
        try {
          await this.plugins.setConfig(pluginId, pluginConfigs[pluginId]);
          config_set = true;
        } catch (err: unknown) {
          const error = err instanceof Error ? err.message : String(err);
          failed.push({ plugin_id: pluginId, step: 'setConfig', error });
        }
      }

      applied.push({ plugin_id: pluginId, activated, config_set });
    }

    return { applied, failed };
  }

  /**
   * Resolves the trading universe (KV `cycle.universe`, the same key the real agent
   * cycle reads) and fetches OHLCV bars per symbol via ProviderGateway. Mirrors
   * AgentsService._buildMarketContext so pretest strategy hooks receive the same
   * market-data shape they'd get in the real cycle, WITHOUT the sandbox ever touching
   * the network (bars are injected; runner.py exposes them as provider_tools.get_ohlcv).
   * Fail-soft: KV read errors fall back to DEFAULT_UNIVERSE; per-symbol OHLCV fetch
   * errors are skipped (logged warn), never thrown.
   *
   * `extraSymbols` are fetched ALONGSIDE the resolved universe (e.g. a vol_target
   * discipline's benchmark symbol) but are deliberately NOT added to the returned
   * `universe` array — they must reach ctx["ohlcv"] without being treated as a
   * momentum/trend-following ranking candidate.
   */
  /**
   * Latest close per symbol from the market bars, used as the independent
   * reference for the fill-price integrity guard. Skips symbols with no usable
   * final close (empty series / non-finite value) — the guard treats a missing
   * reference as "cannot validate → allow".
   */
  private _latestCloses(ohlcv: Record<string, unknown[]>): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [symbol, bars] of Object.entries(ohlcv)) {
      const lastBar = bars[bars.length - 1] as { close?: unknown } | undefined;
      const close = Number(lastBar?.close);
      if (Number.isFinite(close) && close > 0) out[symbol] = close;
    }
    return out;
  }

  private async _buildMarketContext(extraSymbols: string[] = []): Promise<{
    universe: string[];
    ohlcv: Record<string, unknown[]>;
  }> {
    let universe: string[] = DEFAULT_UNIVERSE;
    try {
      const raw = await this.kv.get('cycle.universe');
      if (raw && raw.trim()) {
        const parsed = raw
          .split(',')
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean);
        if (parsed.length > 0) universe = parsed;
      }
    } catch {
      /* use default */
    }
    universe = universe.slice(0, 30);

    const timeframe = (await this.kv.get('cycle.timeframe')) || '1d';
    // Default 400 (~19 months of daily bars) — mirrors AgentsService._buildMarketContext.
    // See that method's comment for the rationale (Fix A: momentum-factor-12-1 needs
    // ~14 MONTHLY bars resampled from daily history; 300 was too tight).
    const bars = Number((await this.kv.get('cycle.bars')) || 0) || 400;
    const dataProvider = (await this.kv.get('cycle.data_provider')) || 'yahoo-finance-provider';

    // Union extraSymbols (e.g. a vol_target benchmark not in `universe`) into the
    // fetch set — deduped, case-normalized to match `universe`'s uppercasing.
    const extraNormalized = extraSymbols.map((s) => s.trim().toUpperCase()).filter(Boolean);
    const fetchSymbols = Array.from(new Set([...universe, ...extraNormalized]));

    const ohlcv: Record<string, unknown[]> = {};
    await Promise.all(
      fetchSymbols.map(async (symbol) => {
        try {
          const raw = await this.gateway.getOhlcv(dataProvider, symbol, timeframe, bars);
          ohlcv[symbol] = (raw ?? []).map((b) => ({
            date: typeof b.ts === 'string' ? b.ts.slice(0, 10) : b.ts,
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
            volume: b.volume,
          }));
        } catch (e: unknown) {
          this.log.warn(
            `Pretest OHLCV fetch falló para ${symbol}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }),
    );
    return { universe, ohlcv };
  }

  /** Maps open positions to the { symbol: {...} } shape strategy hooks read as ctx["portfolio"]. */
  private _positionsToPortfolioDict(state: PretestState): Record<string, unknown> {
    const dict: Record<string, unknown> = {};
    for (const p of state.positions) {
      dict[p.symbol] = {
        quantity: p.quantity,
        avg_price: p.avg_price,
        current_price: p.current_price ?? p.avg_price,
      };
    }
    return dict;
  }

  // ── Simulación de fills ───────────────────────────────────────────────────────

  /**
   * Reads the fill policy for a portfolio.
   * Merges defaults with plugin_configs['__pretest_policy__'] (if present).
   * All fields are numeric-coerced and clamped: 0 <= pct <= 1; sizing_pct > 0.
   * The '__pretest_policy__' key is reserved config — it is NOT a plugin id
   * and is never passed to the plugin_ids loop in runCycle.
   */
  _readPolicy(portfolio: Pick<PretestPortfolio, 'plugin_configs'>): PretestPolicy {
    const raw = portfolio.plugin_configs['__pretest_policy__'] ?? {};

    const coerce = (v: unknown, fallback: number): number => {
      const n = Number(v);
      return isFinite(n) ? n : fallback;
    };

    const sizing_pct = Math.max(
      Number.EPSILON,
      Math.min(1, coerce(raw['sizing_pct'], POLICY_DEFAULTS.sizing_pct)),
    );
    const slippage_pct = Math.max(
      0,
      Math.min(1, coerce(raw['slippage_pct'], POLICY_DEFAULTS.slippage_pct)),
    );
    const commission_pct = Math.max(
      0,
      Math.min(1, coerce(raw['commission_pct'], POLICY_DEFAULTS.commission_pct)),
    );
    const borrow_cost_pct = Math.max(
      0,
      Math.min(1, coerce(raw['borrow_cost_pct'], POLICY_DEFAULTS.borrow_cost_pct)),
    );

    return { sizing_pct, slippage_pct, commission_pct, borrow_cost_pct };
  }

  /**
   * Reads the SAME global KV `execution.*` risk-floor keys TradeIntentService reads for the
   * live paper/real account (see TradeIntentService._readExecutionPolicy / ExecutionPolicy) —
   * a pretest portfolio's RiskPolicy must always be sourced from this shared configuration,
   * never a pretest-local override, so pretest can only ever be AS STRICT or STRICTER than the
   * live account, never looser. Defaults mirror TradeIntentService.DEFAULT_EXECUTION_POLICY
   * exactly (kept as a small, intentional duplication of literals rather than importing from
   * trade-intent.service.ts, to avoid coupling PretestModule to TradeIntentModule).
   */
  private async _readRiskPolicy(): Promise<RiskPolicy> {
    const [
      rawMaxPosPct,
      rawMaxOpenPos,
      rawMaxDrawdown,
      rawMaxShortNotionalPct,
      rawLossBreakerEnabled,
      rawMaxDailyLossPct,
      rawMaxWeeklyLossPct,
    ] = await Promise.all([
      this.kv.get('execution.max_position_pct'),
      this.kv.get('execution.max_open_positions'),
      this.kv.get('execution.max_drawdown_halt_pct'),
      this.kv.get('execution.max_short_notional_pct'),
      this.kv.get('execution.loss_circuit_breaker_enabled'),
      this.kv.get('execution.max_daily_loss_pct'),
      this.kv.get('execution.max_weekly_loss_pct'),
    ]);

    let max_position_pct = kvNum(rawMaxPosPct, 0.1);
    if (max_position_pct <= 0 || max_position_pct > 1) max_position_pct = 0.1;

    let max_open_positions = Math.round(kvNum(rawMaxOpenPos, 10));
    if (max_open_positions < 1) max_open_positions = 1;

    let max_drawdown_halt_pct = kvNum(rawMaxDrawdown, 25);
    if (max_drawdown_halt_pct <= 0 || max_drawdown_halt_pct > 100) max_drawdown_halt_pct = 25;

    let max_short_notional_pct = kvNum(rawMaxShortNotionalPct, 0.1);
    if (max_short_notional_pct <= 0 || max_short_notional_pct > 1) max_short_notional_pct = 0.1;

    const loss_circuit_breaker_enabled = kvBool(rawLossBreakerEnabled, true);

    let max_daily_loss_pct = kvNum(rawMaxDailyLossPct, 0.03);
    if (max_daily_loss_pct <= 0 || max_daily_loss_pct > 1) max_daily_loss_pct = 0.03;

    let max_weekly_loss_pct = kvNum(rawMaxWeeklyLossPct, 0.06);
    if (max_weekly_loss_pct <= 0 || max_weekly_loss_pct > 1) max_weekly_loss_pct = 0.06;

    return {
      max_position_pct,
      max_open_positions,
      max_drawdown_halt_pct,
      max_short_notional_pct,
      loss_circuit_breaker_enabled,
      max_daily_loss_pct,
      max_weekly_loss_pct,
    };
  }

  /**
   * Synthesizes deterministic `emit_trade_intent`-shaped tool calls from any
   * `pending_signals` entry that follows the generic `*_hold_signal` naming
   * convention (e.g. broad-index-hold's `broad_index_hold_signal` — not
   * hardcoded to that specific plugin; any future passive-holder plugin can
   * opt in by following the same convention) with `action:'long'`.
   *
   * A passive-hold strategy is a deterministic rule ("hold the configured
   * index"), not an LLM judgment call — its single signal is often not
   * compelling enough to make the (light) pretest LLM actually call
   * emit_trade_intent, leaving the portfolio stuck at 0 trades. This merges
   * the synthesized calls with whatever the LLM emitted, de-duped by symbol
   * so the LLM and the passive holder never double-buy the same symbol.
   */
  private _synthesizePassiveHoldToolCalls(
    signals: unknown[],
    llmToolCalls: Array<{ plugin_id: string; function: string; args: Record<string, unknown> }>,
  ): Array<{ plugin_id: string; function: string; args: Record<string, unknown> }> {
    const llmLongSymbols = new Set(
      llmToolCalls
        .filter((tc) => (tc.args['action'] as string | undefined)?.toLowerCase() === 'long')
        .map((tc) =>
          typeof tc.args['symbol'] === 'string' ? tc.args['symbol'].toUpperCase() : '',
        ),
    );
    const passiveToolCalls: Array<{
      plugin_id: string;
      function: string;
      args: Record<string, unknown>;
    }> = [];
    const seenPassiveSymbols = new Set<string>();
    for (const sig of signals) {
      if (!sig || typeof sig !== 'object') continue;
      const s = sig as Record<string, unknown>;
      const sigType = typeof s['type'] === 'string' ? s['type'] : '';
      const sigAction = typeof s['action'] === 'string' ? s['action'].toLowerCase() : '';
      const sigSymbol = typeof s['symbol'] === 'string' ? s['symbol'].toUpperCase() : '';
      if (!sigType.endsWith('_hold_signal') || sigAction !== 'long' || !sigSymbol) continue;
      if (llmLongSymbols.has(sigSymbol) || seenPassiveSymbols.has(sigSymbol)) continue;
      seenPassiveSymbols.add(sigSymbol);
      passiveToolCalls.push({
        plugin_id: 'decision',
        function: 'emit_trade_intent',
        args: { symbol: sigSymbol, action: 'long' },
      });
    }
    return [...llmToolCalls, ...passiveToolCalls];
  }

  /** Best-effort audit of a pretest entry rejected by the shared kernel risk floor. */
  private async _auditPretestEntryRejected(
    pretestId: string,
    pretestName: string,
    symbol: string,
    action: 'long' | 'short',
    reason: string | undefined,
  ): Promise<void> {
    try {
      await this.audit.log({
        event_type: 'pretest_entry_rejected',
        meta: { pretest_id: pretestId, pretest_name: pretestName, symbol, action, reason },
      });
    } catch (err) {
      this.log.warn(`Failed to audit pretest_entry_rejected: ${String(err)}`);
    }
  }

  /**
   * Applies the shared kernel risk floor (GovernedPaperExecutionService.evaluateEntryGate) to
   * this cycle's tool calls, BEFORE they ever reach `_simulateFills`. This is the safety fix:
   * pretest previously had NO risk floor at all (no drawdown halt, no max-open-positions, no
   * daily/weekly circuit breaker) — a pretest portfolio could keep "trading" through an
   * arbitrarily large drawdown. `exit`/`hold` tool calls are NEVER gated here (closeability
   * invariant — same as the live account) and pass through untouched.
   *
   * A REJECTED long/short tool call is stripped from the returned list (so it never reaches
   * `_mapIntentAction`/`_simulateFills` — no fill is ever computed for it) and is recorded via
   * `pretest_entry_rejected` audit event, so a blocked pretest strategy stays observable
   * instead of silently vanishing.
   *
   * Returns the (possibly baseline-reset — day/week rollover, or a fresh mark-to-market hwm)
   * `state` alongside the filtered tool calls — callers MUST use this returned `state` for
   * every downstream step (mirrors the live-account gate's contract).
   *
   * WITHIN-CYCLE max_open_positions reservation: `evaluateEntryGate` only checks the REAL
   * (already-persisted) `positions.length` — it has no idea that an earlier tool call in this
   * SAME cycle was already approved, because fills only happen later in `_simulateFills` /
   * `_applyTrades`, once, after this whole loop. Without tracking that here, a cycle emitting
   * 2-3 new-entry tool calls (the ReAct kernel allows up to 3) would gate every one of them
   * against the SAME static `positions.length`, letting the ceiling be exceeded within a
   * single cycle — looser than the live account, where each intent is processed/persisted
   * individually so the next one sees the updated count. `reservedNewSymbols` tracks symbols
   * provisionally allowed THIS cycle that are not already open positions; adding to an
   * EXISTING position (a symbol already held, or already reserved this cycle) never consumes
   * a reservation slot.
   */
  private async _applyKernelRiskFloor(
    pretestId: string,
    pretestName: string,
    toolCalls: Array<{ plugin_id: string; function: string; args: Record<string, unknown> }>,
    state: PretestState,
  ): Promise<{
    toolCalls: Array<{ plugin_id: string; function: string; args: Record<string, unknown> }>;
    state: PretestState;
  }> {
    const riskPolicy = await this._readRiskPolicy();
    let currentState = state;
    const allowed: Array<{ plugin_id: string; function: string; args: Record<string, unknown> }> =
      [];
    const reservedNewSymbols = new Set<string>();

    for (const tc of toolCalls) {
      const symbol = tc.args['symbol'] as string | undefined;
      const rawAction = (tc.args['action'] as string | undefined)?.toLowerCase();

      if (!symbol || (rawAction !== 'long' && rawAction !== 'short')) {
        // exit/hold/unrecognized — never gated here; unrecognized actions are still handled
        // (or skipped) downstream by _mapIntentAction, unchanged.
        allowed.push(tc);
        continue;
      }

      const governedState: GovernedAccountState = currentState;
      const gate = await this.governedPaperExec.evaluateEntryGate(governedState, riskPolicy);
      currentState = { ...currentState, ...gate.state };

      if (!gate.pass) {
        this.log.warn(
          `PRETEST ENTRY REJECTED [${pretestName}]: ${rawAction} ${symbol} — ${gate.reason}`,
        );
        await this._auditPretestEntryRejected(
          pretestId,
          pretestName,
          symbol,
          rawAction,
          gate.reason,
        );
        continue; // strip — never reaches _simulateFills
      }

      // The shared gate above only saw the REAL open positions — it cannot know about other
      // new-entry tool calls already approved earlier in THIS cycle (they haven't filled yet).
      // Reject a NEW symbol here once the real + reserved-this-cycle count hits the ceiling.
      // Adding to an already-held (or already-reserved) symbol never consumes a slot.
      const alreadyHeld =
        currentState.positions.some((p) => p.symbol === symbol) || reservedNewSymbols.has(symbol);
      if (!alreadyHeld) {
        const effectiveOpenCount = currentState.positions.length + reservedNewSymbols.size;
        if (effectiveOpenCount >= riskPolicy.max_open_positions) {
          const reason = `max open positions reached within this cycle (${effectiveOpenCount}/${riskPolicy.max_open_positions})`;
          this.log.warn(
            `PRETEST ENTRY REJECTED [${pretestName}]: ${rawAction} ${symbol} — ${reason}`,
          );
          await this._auditPretestEntryRejected(pretestId, pretestName, symbol, rawAction, reason);
          continue; // strip — never reaches _simulateFills
        }
        reservedNewSymbols.add(symbol);
      }

      allowed.push(tc);
    }

    return { toolCalls: allowed, state: currentState };
  }

  /**
   * Maps the `emit_trade_intent` tool's real action vocabulary
   * (`long`/`short`/`exit`/`hold` — see plugins/decision/tools.json) onto the
   * internal fill-engine vocabulary (`buy`/`sell`/`close`/`short`/`cover`)
   * consumed by `_calcQuantity`/`_applyTrades`.
   *
   * Bug fixed here: `_simulateFills` used to only accept the internal
   * vocabulary directly, so every `long`/`exit`/`hold` tool call (the ONLY
   * vocabulary the LLM actually emits) was silently skipped — paper pretest
   * portfolios never filled a single trade in production.
   *
   * - `long`  → `buy` (open/add a long).
   * - `short` → `short` (already native).
   * - `exit`  → resolved by the CURRENT position side: `close` (sell) when
   *   long, `cover` when short, skip (undefined) when flat — no-op, never
   *   crashes.
   * - `hold`  → skip (undefined) — explicit no-op.
   * - Legacy `buy`/`sell`/`close`/`short`/`cover` synonyms are still accepted
   *   as-is for backward compatibility with any other caller.
   */
  private _mapIntentAction(
    rawAction: string | undefined,
    symbol: string,
    state: PretestState,
  ): 'buy' | 'sell' | 'close' | 'short' | 'cover' | undefined {
    if (!rawAction) return undefined;
    switch (rawAction) {
      case 'hold':
        return undefined;
      case 'long':
        return 'buy';
      case 'short':
        return 'short';
      case 'exit': {
        const pos = state.positions.find((p) => p.symbol === symbol);
        if (!pos || pos.quantity === 0) return undefined; // no position — no-op
        return pos.quantity > 0 ? 'close' : 'cover';
      }
      case 'buy':
      case 'sell':
      case 'close':
      case 'cover':
        return rawAction;
      default:
        return undefined;
    }
  }

  /**
   * Resolves fill prices via ProviderGateway.getQuote(null, symbol).last.
   * LLM-fabricated args['price'] is NEVER used.
   * Slippage is applied at fill time: buy = last*(1+slippage_pct), sell = last*(1-slippage_pct).
   * On getQuote rejection: skip the trade entirely (log warning, no throw).
   */
  /**
   * True when `price` is close enough to the symbol's reference bar close to be a
   * trustworthy quote — used for both fill prices and mark-to-market marks. When
   * no finite/positive reference exists we CANNOT validate, so we allow it: the
   * guard must never block on momentarily-unavailable reference data (that would
   * silently halt all pretest trading/marking on any OHLCV outage). See
   * MAX_FILL_PRICE_DEVIATION.
   */
  private _isQuotePlausible(
    symbol: string,
    last: number,
    referenceCloses: Record<string, number>,
  ): boolean {
    const ref = referenceCloses[symbol];
    if (!Number.isFinite(ref) || ref <= 0) return true;
    return Math.abs(last / ref - 1) <= MAX_FILL_PRICE_DEVIATION;
  }

  async _simulateFills(
    toolCalls: Array<{ plugin_id: string; function: string; args: Record<string, unknown> }>,
    state: PretestState,
    policy: PretestPolicy = POLICY_DEFAULTS,
    referenceCloses: Record<string, number> = {},
  ): Promise<PretestTrade[]> {
    const trades: PretestTrade[] = [];
    for (const tc of toolCalls) {
      const args = tc.args;
      const symbol = args['symbol'] as string | undefined;
      const rawAction = (args['action'] as string | undefined)?.toLowerCase();
      const action = symbol ? this._mapIntentAction(rawAction, symbol, state) : undefined;
      if (!symbol || !action) continue;

      let last: number;
      try {
        const quote = await this.gateway.getQuote(null, symbol);
        last = quote.last;
      } catch (err) {
        this.log.warn(`Fill skipped for ${symbol}: getQuote failed — ${String(err)}`);
        continue;
      }

      if (last <= 0) continue;

      // Fill-price integrity guard: refuse a quote that deviates implausibly from
      // the symbol's latest recent bar close (independent provider endpoint).
      // Prevents the 2026-07-04 phantom-gains incident from recurring.
      if (!this._isQuotePlausible(symbol, last, referenceCloses)) {
        this.log.warn(
          `Fill skipped for ${symbol}: quote ${last} deviates >${MAX_FILL_PRICE_DEVIATION * 100}% ` +
            `from reference close ${referenceCloses[symbol]} — likely bad/stale price data`,
        );
        continue;
      }

      // Apply slippage: buy/cover (both buy-side executions) fill at a higher
      // price; sell/close/short (both sell-side executions) fill at a lower price.
      const price =
        action === 'buy' || action === 'cover'
          ? last * (1 + policy.slippage_pct)
          : last * (1 - policy.slippage_pct);

      const quantity = this._calcQuantity(action, symbol, price, state, policy);
      if (quantity <= 0) continue;

      trades.push({ ts: new Date().toISOString(), symbol, action, price, quantity });
    }
    return trades;
  }

  private _calcQuantity(
    action: 'buy' | 'sell' | 'close' | 'short' | 'cover',
    symbol: string,
    price: number,
    state: PretestState,
    policy: PretestPolicy = POLICY_DEFAULTS,
  ): number {
    if (action === 'buy') {
      // Use policy.sizing_pct of available cash per order.
      // Divide by price*(1+commission_pct) so the full cost (notional + fee) fits in budget.
      const budget = state.cash * policy.sizing_pct;
      const cost_per_share = price * (1 + policy.commission_pct);
      return cost_per_share > 0 ? Math.floor(budget / cost_per_share) : 0;
    }
    if (action === 'short') {
      // Same sizing_pct-of-cash budget as buy: uses available cash as a proxy
      // for the margin/notional the paper account is willing to risk on the
      // short. Never opens a short on top of an existing long (guarded in _applyShort).
      const budget = state.cash * policy.sizing_pct;
      const notional_per_share = price * (1 + policy.commission_pct);
      return notional_per_share > 0 ? Math.floor(budget / notional_per_share) : 0;
    }
    if (action === 'cover') {
      const pos = state.positions.find((p) => p.symbol === symbol);
      return pos && pos.quantity < 0 ? Math.abs(pos.quantity) : 0;
    }
    // sell / close (long exits)
    const pos = state.positions.find((p) => p.symbol === symbol);
    return pos && pos.quantity > 0 ? pos.quantity : 0;
  }

  /**
   * Rebalances EXISTING long positions toward exposureScalar × portfolio
   * equity, pro-rata across all currently-held long positions (weighted by
   * their current notional). This is the "minimal faithful mechanism"
   * documented in the vol-managed-exposure change: the per-signal fill model
   * has no native "target weight" concept, so instead of reimplementing a
   * full target-weight rebalancer, this scales whatever the LLM/plugins have
   * already chosen to hold, toward the risk-manager-emitted exposure_scalar
   * (never hardcoded — see runCycle's volTargetPlugin hook call).
   *
   * New entries are separately throttled via sizing_pct scaling in runCycle
   * (effectivePolicy) — this method only ever touches ALREADY-open long
   * positions. Shorts are left untouched (vol-target is a long-exposure
   * concept in the batch-6 research). No-op when nothing is held yet — the
   * next cycle's entry, sized via the scaled sizing_pct, is what establishes
   * the book in the first place.
   */
  /** Fresh marks for every held long position; falls back to last-known mark
   * (or cost basis) on a getQuote failure — never throws. Extracted from
   * _buildVolTargetRebalanceTrades to keep its cognitive complexity low. */
  private async _freshMarks(
    positions: PretestPosition[],
    referenceCloses: Record<string, number> = {},
  ): Promise<Map<string, number>> {
    const marks = new Map<string, number>();
    for (const pos of positions) {
      try {
        const quote = await this.gateway.getQuote(null, pos.symbol);
        // Same integrity guard as fills/MTM: an implausible mark here would price a
        // real rebalance trade and permanently corrupt avg_price. Skip it so priceOf
        // falls back to the last-known mark.
        if (!isFinite(quote.last) || quote.last <= 0) {
          /* unusable quote — silent skip, priceOf falls back to last-known mark */
        } else if (this._isQuotePlausible(pos.symbol, quote.last, referenceCloses)) {
          marks.set(pos.symbol, quote.last);
        } else {
          this.log.warn(
            `Rebalance mark guard for ${pos.symbol}: quote ${quote.last} deviates ` +
              `>${MAX_FILL_PRICE_DEVIATION * 100}% from reference close ${referenceCloses[pos.symbol]} — using last-known`,
          );
        }
      } catch {
        /* fall through to last-known mark below */
      }
    }
    return marks;
  }

  /** One symbol's rebalance trade toward its pro-rata share of `delta` USD, or
   * null when there's nothing tradeable (price<=0 or resulting qty is 0). */
  private _oneRebalanceTrade(
    pos: PretestPosition,
    price: number,
    symbolDeltaUsd: number,
    ts: string,
  ): PretestTrade | null {
    if (price <= 0) return null;
    if (symbolDeltaUsd > 0) {
      // Scale up: buy more of this symbol. _applyBuy silently skips if cash
      // is insufficient — no separate cash check needed here.
      const qty = Math.floor(symbolDeltaUsd / price);
      return qty > 0 ? { ts, symbol: pos.symbol, action: 'buy', price, quantity: qty } : null;
    }
    // Scale down: sell part of this symbol, capped at the held quantity.
    const qty = Math.min(pos.quantity, Math.floor(Math.abs(symbolDeltaUsd) / price));
    return qty > 0 ? { ts, symbol: pos.symbol, action: 'sell', price, quantity: qty } : null;
  }

  /**
   * Audit trail for a failed vol-target exposure hook. exposureScalar already fails
   * safe to 0 (portfolio goes/stays 100% cash) by the time this is called — this only
   * ADDS observability so a persistently-failing hook is discoverable via the audit
   * API/UI instead of only a server-log warning. Fail-soft: never throws out of runCycle.
   */
  private async _auditVolTargetExposureFailure(
    pretestId: string,
    pretestName: string,
    pluginId: string,
    err: unknown,
  ): Promise<void> {
    try {
      await this.audit.log({
        event_type: 'vol_target_exposure_failed',
        meta: {
          pretest_id: pretestId,
          pretest_name: pretestName,
          plugin_id: pluginId,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    } catch (auditErr: unknown) {
      this.log.warn(`Failed to audit vol_target_exposure_failed: ${String(auditErr)}`);
    }
  }

  private async _buildVolTargetRebalanceTrades(
    state: PretestState,
    exposureScalar: number,
    referenceCloses: Record<string, number> = {},
  ): Promise<PretestTrade[]> {
    const longPositions = state.positions.filter((p) => p.quantity > 0);
    if (longPositions.length === 0 || !isFinite(exposureScalar) || exposureScalar < 0) return [];

    const marks = await this._freshMarks(longPositions, referenceCloses);
    const priceOf = (pos: PretestPosition): number =>
      marks.get(pos.symbol) ?? pos.current_price ?? pos.avg_price;

    const currentInvested = longPositions.reduce((sum, p) => sum + p.quantity * priceOf(p), 0);
    if (currentInvested <= 0) return [];

    const targetInvested = exposureScalar * state.equity;
    const delta = targetInvested - currentInvested;
    // Ignore sub-$1 deltas — not worth a trade, avoids churn from float noise.
    if (Math.abs(delta) < 1) return [];

    const ts = new Date().toISOString();
    const trades: PretestTrade[] = [];
    for (const pos of longPositions) {
      const price = priceOf(pos);
      const weight = (pos.quantity * price) / currentInvested;
      const trade = this._oneRebalanceTrade(pos, price, delta * weight, ts);
      if (trade) trades.push(trade);
    }
    return trades;
  }

  private _applyTrades(
    state: PretestState,
    trades: PretestTrade[],
    policy: PretestPolicy = POLICY_DEFAULTS,
  ): PretestState {
    const next: PretestState = {
      ...state,
      // trades list is populated on success inside _applyBuy/_applySell; not pre-appended here.
      trades: [...state.trades],
      positions: [...state.positions],
    };

    for (const trade of trades) {
      if (trade.action === 'buy') {
        this._applyBuy(next, trade, policy.commission_pct);
      } else if (trade.action === 'sell' || trade.action === 'close') {
        this._applySell(next, trade, policy.commission_pct);
      } else if (trade.action === 'short') {
        this._applyShort(next, trade, policy.commission_pct);
      } else if (trade.action === 'cover') {
        this._applyCover(next, trade, policy.commission_pct);
      }
    }

    // Note: _updateEquityMetrics is now async and must be awaited by callers (runCycle).
    // It is NOT called here — callers must await _updateEquityMetrics(state) after this.
    return next;
  }

  private _applyBuy(state: PretestState, trade: PretestTrade, commission_pct = 0): void {
    const notional = trade.price * trade.quantity;
    const buy_commission = notional * commission_pct;
    const total_cost = notional + buy_commission;
    if (total_cost > state.cash) return; // insufficient funds — skip, do NOT record to state.trades
    state.cash -= total_cost;
    // Record only after confirming the trade executes
    state.trades.push(trade);
    // Embed buy commission into cost basis: avg_price = (notional + buy_commission) / qty.
    // This satisfies the cash/pnl conservation invariant and is industry-standard cost accounting.
    const cost_basis_price = (notional + buy_commission) / trade.quantity;
    const existing = state.positions.find((p) => p.symbol === trade.symbol);
    if (existing) {
      const total_qty = existing.quantity + trade.quantity;
      existing.avg_price =
        (existing.avg_price * existing.quantity + cost_basis_price * trade.quantity) / total_qty;
      existing.quantity = total_qty;
    } else {
      state.positions.push({
        symbol: trade.symbol,
        quantity: trade.quantity,
        avg_price: cost_basis_price,
      });
    }
  }

  private _applySell(state: PretestState, trade: PretestTrade, commission_pct = 0): void {
    const posIdx = state.positions.findIndex((p) => p.symbol === trade.symbol);
    if (posIdx < 0) return; // no position to sell — skip, do NOT record to state.trades
    const pos = state.positions[posIdx];
    const qty = Math.min(trade.quantity, pos.quantity);
    const proceeds = trade.price * qty;
    const commission_cost = proceeds * commission_pct;
    const pnl = (trade.price - pos.avg_price) * qty - commission_cost;
    trade.pnl = pnl;
    // Store the cost-basis per share so computeSignificance can use the correct
    // denominator for per-trade returns (entry cost basis, not exit fill price).
    trade.entry_price = pos.avg_price;
    state.cash += proceeds - commission_cost;
    state.realized_pnl += pnl;
    if (pnl > 0) state.win_trades++;
    else state.loss_trades++;
    pos.quantity -= qty;
    if (pos.quantity <= 0) state.positions.splice(posIdx, 1);
    // Record only after the sell executes
    state.trades.push(trade);
  }

  /**
   * Short entry (sell-to-open). Position quantity goes NEGATIVE (shares owed).
   * Cash is credited with the (commission-net) sale proceeds, mirroring a sell —
   * but this cash is a liability offset by the short's mark-to-market value,
   * which _updateEquityMetrics accounts for via the position's signed quantity.
   * Guarded against opening a short on top of an existing LONG position in the
   * same symbol (mixed long/short per symbol is not modeled) — skips instead.
   */
  private _applyShort(state: PretestState, trade: PretestTrade, commission_pct = 0): void {
    const existing = state.positions.find((p) => p.symbol === trade.symbol);
    if (existing && existing.quantity > 0) return; // cannot short while long the same symbol
    const notional = trade.price * trade.quantity;
    const sell_commission = notional * commission_pct;
    const net_proceeds = notional - sell_commission;
    if (net_proceeds <= 0 || trade.quantity <= 0) return;
    state.cash += net_proceeds;
    state.trades.push(trade);
    // Effective short-entry price nets out commission (worse execution price),
    // mirroring how _applyBuy embeds buy commission into cost basis.
    const cost_basis_price = net_proceeds / trade.quantity;
    if (existing) {
      const existing_abs = Math.abs(existing.quantity);
      const total_qty = existing_abs + trade.quantity;
      existing.avg_price =
        (existing.avg_price * existing_abs + cost_basis_price * trade.quantity) / total_qty;
      existing.quantity = -total_qty;
    } else {
      state.positions.push({
        symbol: trade.symbol,
        quantity: -trade.quantity,
        avg_price: cost_basis_price,
      });
    }
  }

  /**
   * Cover (buy-to-close a short) — an EXIT-class action, mirroring _applySell for
   * longs. Short P&L = (entry_price − cover_price) × qty − commission: profit
   * when covered lower than the entry short price, loss when covered higher.
   */
  private _applyCover(state: PretestState, trade: PretestTrade, commission_pct = 0): void {
    const posIdx = state.positions.findIndex((p) => p.symbol === trade.symbol && p.quantity < 0);
    if (posIdx < 0) return; // no short position to cover — skip, do NOT record to state.trades
    const pos = state.positions[posIdx];
    const qty = Math.min(trade.quantity, Math.abs(pos.quantity));
    if (qty <= 0) return;
    const cost = trade.price * qty;
    const commission_cost = cost * commission_pct;
    const pnl = (pos.avg_price - trade.price) * qty - commission_cost;
    trade.pnl = pnl;
    trade.entry_price = pos.avg_price;
    state.cash -= cost + commission_cost;
    state.realized_pnl += pnl;
    if (pnl > 0) state.win_trades++;
    else state.loss_trades++;
    pos.quantity += qty; // moves toward 0 (never overshoots into long: qty is capped above)
    if (pos.quantity >= 0) state.positions.splice(posIdx, 1);
    // Record only after the cover executes
    state.trades.push(trade);
  }

  /**
   * Mark-to-market equity: for each open position fetch live quote and compute
   * current_price + unrealized_pnl. Falls back to last-known current_price
   * (or avg_price if no current_price) on getQuote rejection.
   * Never throws — failures are logged as warnings.
   *
   * Equity formula generalizes to shorts for free: posValue sums
   * (current_price * quantity) with quantity SIGNED (negative for shorts), so
   * equity = cash + long_MTM − short_liability automatically.
   *
   * Short positions also accrue a borrow-cost fee each tick (policy.borrow_cost_pct
   * of |quantity| * mark_price), charged to cash — a stock-loan fee approximation.
   * Zero effect on long-only portfolios (no short positions ever exist there).
   */
  async _updateEquityMetrics(
    state: PretestState,
    policy: PretestPolicy = POLICY_DEFAULTS,
    referenceCloses: Record<string, number> = {},
  ): Promise<void> {
    await Promise.all(
      state.positions.map(async (pos) => {
        let marketPrice: number;
        try {
          const quote = await this.gateway.getQuote(null, pos.symbol);
          if (!isFinite(quote.last) || quote.last <= 0) {
            // Provider resolved but returned an unusable price (e.g. last=0 for unknown format).
            // Treat the same as a rejection: fall back to last-known price.
            const fallback = pos.current_price ?? pos.avg_price;
            this.log.warn(
              `MTM fallback for ${pos.symbol}: quote.last=${quote.last} is not a positive finite number, using ${fallback}`,
            );
            marketPrice = fallback;
          } else if (!this._isQuotePlausible(pos.symbol, quote.last, referenceCloses)) {
            // Bad-but-positive quote (the 2026-07-04 half-price failure mode). Accepting
            // it here would permanently poison the monotonic max_equity / max_drawdown_pct
            // HWMs and the significance gate. Fall back to the last-known price instead.
            const fallback = pos.current_price ?? pos.avg_price;
            this.log.warn(
              `MTM guard for ${pos.symbol}: quote ${quote.last} deviates >${MAX_FILL_PRICE_DEVIATION * 100}% ` +
                `from reference close ${referenceCloses[pos.symbol]} — using ${fallback}`,
            );
            marketPrice = fallback;
          } else {
            marketPrice = quote.last;
          }
        } catch (err) {
          // Fallback: use last-known current_price if available, else avg_price (cost basis)
          marketPrice = pos.current_price ?? pos.avg_price;
          this.log.warn(
            `MTM fallback for ${pos.symbol}: using ${marketPrice} — getQuote failed: ${String(err)}`,
          );
        }

        pos.current_price = marketPrice;
        pos.unrealized_pnl = (marketPrice - pos.avg_price) * pos.quantity;

        // Borrow-cost accrual on open short notional (quantity < 0), charged to cash.
        if (pos.quantity < 0 && policy.borrow_cost_pct > 0) {
          const borrow_cost = Math.abs(pos.quantity) * marketPrice * policy.borrow_cost_pct;
          state.cash -= borrow_cost;
        }
      }),
    );

    // MTM equity = cash + Σ(current_price * quantity) for all open positions.
    // quantity is SIGNED (negative for shorts) so this is simultaneously
    // cash + long_MTM − short_liability without special-casing shorts.
    const posValue = state.positions.reduce(
      (sum, p) => sum + (p.current_price ?? p.avg_price) * p.quantity,
      0,
    );
    state.equity = state.cash + posValue;

    // Benchmark tracking for the alpha gate: buy & hold of BENCHMARK_SYMBOL over the
    // portfolio's span. Baseline is captured on the first MTM; later cycles compute
    // the return vs that baseline. Fail-soft: any failure leaves the benchmark fields
    // untouched so the alpha gate simply skips (never blocks) this cycle.
    try {
      const bench = await this.gateway.getQuote(null, BENCHMARK_SYMBOL);
      if (
        isFinite(bench.last) &&
        bench.last > 0 &&
        this._isQuotePlausible(BENCHMARK_SYMBOL, bench.last, referenceCloses)
      ) {
        if (state.benchmark_start_price === undefined) {
          state.benchmark_start_price = bench.last;
        }
        state.benchmark_return_pct =
          ((bench.last - state.benchmark_start_price) / state.benchmark_start_price) * 100;
      }
    } catch (err) {
      this.log.warn(`Benchmark MTM skipped (${BENCHMARK_SYMBOL}): ${String(err)}`);
    }

    if (state.equity > state.max_equity) {
      state.max_equity = state.equity;
    }

    const dd =
      state.max_equity > 0 ? ((state.max_equity - state.equity) / state.max_equity) * 100 : 0;
    if (dd > state.max_drawdown_pct) {
      state.max_drawdown_pct = dd;
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────────

  private _hydrate(row: {
    id: string;
    name: string;
    description: string | null;
    initial_capital: number;
    plugin_ids: string;
    plugin_configs: string | null;
    state: string;
    run_count: number;
    last_run_at: Date | null;
    is_active: boolean;
    created_at: Date;
    updated_at: Date;
  }): PretestPortfolio {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      initial_capital: row.initial_capital,
      plugin_ids: JSON.parse(row.plugin_ids) as string[],
      plugin_configs: row.plugin_configs
        ? (JSON.parse(row.plugin_configs) as Record<string, Record<string, unknown>>)
        : {},
      state: JSON.parse(row.state) as PretestState,
      run_count: row.run_count,
      last_run_at: row.last_run_at,
      is_active: row.is_active,
      created_at: row.created_at,
    };
  }
}
