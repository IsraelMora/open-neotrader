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
import { AuditService } from '../audit/audit.service';

/**
 * Per-portfolio fill policy. Stored under plugin_configs['__pretest_policy__'].
 * Defaults reproduce the original hardcoded behavior: 5% sizing, no slippage, no commission.
 */
export interface PretestPolicy {
  sizing_pct: number; // fraction of cash per buy order (default 0.05)
  slippage_pct: number; // adverse price adjustment on fill (default 0)
  commission_pct: number; // fee on notional, charged to cash (default 0)
}

const POLICY_DEFAULTS: PretestPolicy = {
  sizing_pct: 0.05,
  slippage_pct: 0,
  commission_pct: 0,
};

export interface PretestTrade {
  ts: string;
  symbol: string;
  action: 'buy' | 'sell' | 'close';
  price: number;
  quantity: number;
  pnl?: number;
  /** Cost basis per share at entry (avg_price of position when trade was closed). Stored by _applySell. */
  entry_price?: number;
}

export interface PretestPosition {
  symbol: string;
  quantity: number;
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
}

/** Result of the significance gate evaluation. */
export interface GateResult {
  ready: boolean;
  reasons: string[];
  metrics: SignificanceMetrics;
}

/** Result of a PretestService.promote() call — three possible outcomes. */
export interface PromoteResult {
  ok: boolean;
  /** Set when ok is false — explains the rejection. */
  reason?: 'gate_not_ready' | 'needs_confirmation';
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
  }>;
  winner_by_return: string;
  winner_by_risk_adj: string; // mayor retorno / max_drawdown
}

const DEFAULT_STATE = (capital: number): PretestState => ({
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
    @Optional()
    private readonly audit?: AuditService,
  ) {}

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
   * - Corre los skill plugins del pretest (no los globalmente activos)
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

    // Construir plugins del pretest (solo los declarados, no los globalmente activos)
    const allPlugins = await this.plugins.findActive();
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

    // ── Ciclo de señales ──────────────────────────────────────────────────────
    const cycleCtx: Record<string, unknown> = {
      pretest_mode: true,
      pretest_id: id,
      portfolio_state: portfolio.state,
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
      '\nEres un agente en modo PRETEST. Evalúa las señales pero NO ejecutes órdenes reales. Indica qué acciones tomarías y por qué.',
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

    // ── Leer política de fills del portfolio ──────────────────────────────────
    const policy = this._readPolicy(portfolio);

    // ── Simular fills (async: price from getQuote.last + slippage) ────────────
    // Use validated tool_calls from the governed turn (providers already dropped by virtual guard).
    const trades = await this._simulateFills(turnResult.tool_calls, portfolio.state, policy);

    // Actualizar estado virtual (sync trade application + commission, async MTM equity)
    const newState = this._applyTrades(portfolio.state, trades, policy);
    await this._updateEquityMetrics(newState);

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

  /** Ejecuta UN ciclo para TODOS los portfolios activos (comparación en paralelo). */
  async runAllActive(): Promise<Array<{ id: string; name: string; ok: boolean; error?: string }>> {
    const active = await this.db.pretestPortfolio.findMany({ where: { is_active: true } });
    const results = await Promise.allSettled(active.map((p) => this.runCycle(p.id)));
    return results.map((r, i) => ({
      id: active[i].id,
      name: active[i].name,
      ok: r.status === 'fulfilled',
      error: r.status === 'rejected' ? String(r.reason) : undefined,
    }));
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
      const metrics = this.computeSignificance(p.state);
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
  computeSignificance(state: PretestState): SignificanceMetrics {
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

    // profit_factor = Σ(+pnl) / |Σ(-pnl)|; null if no losses
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

    return {
      sharpe,
      profit_factor,
      win_rate,
      max_dd: state.max_drawdown_pct,
      n_trades: n,
      loss_trades: losses,
    };
  }

  /**
   * Evaluates significance gate for a portfolio by ID.
   * Reads thresholds from KvService (system-wide config), falling back to defaults.
   * Returns { ready, reasons, metrics }.
   */
  async gate(id: string): Promise<GateResult> {
    const portfolio = await this.findOne(id);
    const metrics = this.computeSignificance(portfolio.state);
    const thresholds = await this._readGateThresholds();
    const reasons = this._evaluateGate(metrics, thresholds);
    return { ready: reasons.length === 0, reasons, metrics };
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
  }> {
    const parseNum = (raw: string | null, fallback: number): number => {
      if (raw === null) return fallback;
      const n = Number(raw);
      return isFinite(n) ? n : fallback;
    };
    const [rawMinTrades, rawMinSharpe, rawMaxDd, rawMinLossTrades] = await Promise.all([
      this.kv.get('pretest.gate.min_trades'),
      this.kv.get('pretest.gate.min_sharpe'),
      this.kv.get('pretest.gate.max_dd_pct'),
      this.kv.get('pretest.gate.min_loss_trades'),
    ]);

    const min_trades_raw = parseNum(rawMinTrades, 20);
    const min_sharpe_raw = parseNum(rawMinSharpe, 1.0);
    const max_dd_pct_raw = parseNum(rawMaxDd, 20);
    const min_loss_trades_raw = parseNum(rawMinLossTrades, 3);

    // Clamp: max_dd_pct must be in [1, 100] — anything below 1 almost certainly indicates
    // a fraction was stored (e.g. 0.20 meaning 20%) rather than a percentage; coerce to default 20.
    const max_dd_pct = max_dd_pct_raw >= 1 && max_dd_pct_raw <= 100 ? max_dd_pct_raw : 20;
    // Clamp: min_sharpe must be >= 0
    const min_sharpe = min_sharpe_raw >= 0 ? min_sharpe_raw : 0;
    // Clamp: min_trades must be >= 1
    const min_trades = min_trades_raw >= 1 ? min_trades_raw : 1;
    // Clamp: min_loss_trades must be >= 0
    const min_loss_trades = min_loss_trades_raw >= 0 ? min_loss_trades_raw : 0;

    return { min_trades, min_sharpe, max_dd_pct, min_loss_trades };
  }

  /** Evaluates metrics against thresholds and returns a list of failure reasons. */
  private _evaluateGate(
    metrics: SignificanceMetrics,
    thresholds: {
      min_trades: number;
      min_sharpe: number;
      max_dd_pct: number;
      min_loss_trades: number;
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
    const g = await this.gate(id);
    if (!g.ready) {
      await this.audit?.log({
        event_type: 'promotion_gate_blocked',
        meta: { pretest_id: id, reasons: g.reasons },
      });
      return { ok: false, reason: 'gate_not_ready', gate_reasons: g.reasons };
    }

    // Step 3: HUMAN-CONFIRM — fail-safe parse: only literal 'false' disables.
    const rawConfirm = await this.kv.get('promotion.require_human_confirm');
    const requireConfirm = rawConfirm !== 'false';

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
    await this.audit?.log({
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

    return { sizing_pct, slippage_pct, commission_pct };
  }

  /**
   * Resolves fill prices via ProviderGateway.getQuote(null, symbol).last.
   * LLM-fabricated args['price'] is NEVER used.
   * Slippage is applied at fill time: buy = last*(1+slippage_pct), sell = last*(1-slippage_pct).
   * On getQuote rejection: skip the trade entirely (log warning, no throw).
   */
  async _simulateFills(
    toolCalls: Array<{ plugin_id: string; function: string; args: Record<string, unknown> }>,
    state: PretestState,
    policy: PretestPolicy = POLICY_DEFAULTS,
  ): Promise<PretestTrade[]> {
    const trades: PretestTrade[] = [];
    for (const tc of toolCalls) {
      const args = tc.args;
      const symbol = args['symbol'] as string | undefined;
      const action = (args['action'] as string | undefined)?.toLowerCase() as
        | 'buy'
        | 'sell'
        | 'close'
        | undefined;
      if (!symbol || !action || !['buy', 'sell', 'close'].includes(action)) continue;

      let last: number;
      try {
        const quote = await this.gateway.getQuote(null, symbol);
        last = quote.last;
      } catch (err) {
        this.log.warn(`Fill skipped for ${symbol}: getQuote failed — ${String(err)}`);
        continue;
      }

      if (last <= 0) continue;

      // Apply slippage: buy fills at a higher price, sell fills at a lower price
      const price =
        action === 'buy' ? last * (1 + policy.slippage_pct) : last * (1 - policy.slippage_pct);

      const quantity = this._calcQuantity(action, symbol, price, state, policy);
      if (quantity <= 0) continue;

      trades.push({ ts: new Date().toISOString(), symbol, action, price, quantity });
    }
    return trades;
  }

  private _calcQuantity(
    action: 'buy' | 'sell' | 'close',
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
    const pos = state.positions.find((p) => p.symbol === symbol);
    return pos?.quantity ?? 0;
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
   * Mark-to-market equity: for each open position fetch live quote and compute
   * current_price + unrealized_pnl. Falls back to last-known current_price
   * (or avg_price if no current_price) on getQuote rejection.
   * Never throws — failures are logged as warnings.
   */
  async _updateEquityMetrics(state: PretestState): Promise<void> {
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
      }),
    );

    // MTM equity = cash + Σ(current_price * quantity) for all open positions
    const posValue = state.positions.reduce(
      (sum, p) => sum + (p.current_price ?? p.avg_price) * p.quantity,
      0,
    );
    state.equity = state.cash + posValue;

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
