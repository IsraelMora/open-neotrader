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
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SandboxGateway } from '../sandbox/sandbox.gateway';
import { PluginsService, HydratedPlugin } from '../plugins/plugins.service';
import { LlmService } from '../llm/llm.service';
import { ContextMemoryService } from '../context-memory/context-memory.service';
import { ProviderGatewayService } from '../providers/provider-gateway.service';
import { AgentsService } from '../agents/agents.service';

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
    private readonly agents: AgentsService,
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

    const stats = all.map((p) => {
      const total_trades = p.state.trades.length;
      const win_rate = total_trades > 0 ? p.state.win_trades / total_trades : 0;
      const return_pct = (p.state.equity - p.initial_capital) / p.initial_capital;
      const risk_adj =
        p.state.max_drawdown_pct > 0 ? return_pct / p.state.max_drawdown_pct : return_pct;
      return {
        id: p.id,
        name: p.name,
        equity: p.state.equity,
        return_pct: return_pct * 100,
        max_drawdown_pct: p.state.max_drawdown_pct,
        total_trades,
        win_rate: win_rate * 100,
        realized_pnl: p.state.realized_pnl,
        plugin_count: p.plugin_ids.length,
        _risk_adj: risk_adj,
      };
    });

    const winnerReturn = stats.reduce((a, b) => (b.return_pct > a.return_pct ? b : a), stats[0]);
    const winnerRiskAdj = stats.reduce((a, b) => (b._risk_adj > a._risk_adj ? b : a), stats[0]);

    return {
      portfolios: stats.map(({ _risk_adj: _, ...rest }) => rest),
      winner_by_return: winnerReturn.name,
      winner_by_risk_adj: winnerRiskAdj.name,
    };
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
