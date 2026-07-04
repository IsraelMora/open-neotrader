/**
 * GovernedPaperExecutionService — the SHARED governed-execution core for every
 * non-real-money account (the live paper portfolio AND every pretest portfolio).
 *
 * Extracted from TradeIntentService's paper branch (_passesPaperEntryGate,
 * _markToMarketPaper, _checkPeriodLossLimit, _dayKey/_weekKey, _passesAutoRisk's paper
 * branch, _clampToPositionCeiling, _clampToShortNotionalCeiling, _executePaper /
 * _executePaperLong / _executePaperShort, _positionsValue) so BOTH the live paper account
 * and pretest run through the IDENTICAL kernel risk floor + fill math, differing only by
 * which GovernedAccountState (account adapter) and RiskPolicy they pass in.
 *
 * The real-money path (_executeReal, RealAccountState, kill-switch, walk-forward gate) is
 * NOT part of this core and stays entirely inside TradeIntentService, untouched.
 *
 * Canonical action vocabulary: long/short/exit/hold ONLY (see governed-account-state.ts).
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ProviderGatewayService } from '../providers/provider-gateway.service';
import { AuditService } from '../audit/audit.service';
import {
  EntryGateResult,
  EvaluateAndExecuteResult,
  FillPolicy,
  FillResult,
  GovernedAccountState,
  GovernedPosition,
  RiskPolicy,
  TradeAction,
} from './governed-account-state';

@Injectable()
export class GovernedPaperExecutionService {
  private readonly log = new Logger(GovernedPaperExecutionService.name);

  constructor(
    private readonly gateway: ProviderGatewayService,
    // AuditService @Optional() — best-effort logging of a loss-circuit-breaker trip.
    // Callers (TradeIntentService, PretestService) log their OWN entry-rejected events;
    // this is only the shared breaker-trip audit that used to live inline in
    // _passesPaperEntryGate.
    @Optional() private readonly audit?: AuditService,
  ) {}

  // ── Drawdown ──────────────────────────────────────────────────────────────────

  /**
   * Real drawdown from the true high-water-mark (hwm). hwm defaults to the current equity
   * when unset (fresh account, no trades yet) — never false-halts a brand-new account.
   */
  computeDrawdownPct(state: GovernedAccountState): number {
    const hwm = state.hwm ?? state.equity;
    return hwm > 0 ? Math.max(0, ((hwm - state.equity) / hwm) * 100) : 0;
  }

  // ── Mark-to-market ────────────────────────────────────────────────────────────

  /**
   * Mark-to-market of ALL open positions against CURRENT prices, one batched round of
   * quote fetches. `equity = cash + Σ(current_price * signed_quantity)`.
   *
   * Fail-CLOSED: a failure to price any single open position returns `ok: false` — the
   * caller MUST refuse the entry rather than gate against a partially-stale/fabricated
   * equity number. Only ever called before an ENTRY (long/short) decision.
   */
  async markToMarket(
    state: GovernedAccountState,
  ): Promise<{ equity: number; hwm: number; ok: boolean }> {
    const baseHwm = state.hwm ?? state.equity;

    if (state.positions.length === 0) {
      return { equity: state.equity, hwm: Math.max(baseHwm, state.equity), ok: true };
    }

    let ok = true;
    let positionsValue = 0;
    await Promise.all(
      state.positions.map(async (pos) => {
        try {
          const quote = await this.gateway.getQuote(null, pos.symbol);
          if (!quote || !isFinite(quote.last) || quote.last <= 0) {
            ok = false;
            return;
          }
          positionsValue += quote.last * pos.quantity;
        } catch {
          ok = false;
        }
      }),
    );

    if (!ok) {
      return { equity: state.equity, hwm: baseHwm, ok: false };
    }

    const equity = state.cash + positionsValue;
    return { equity, hwm: Math.max(baseHwm, equity), ok: true };
  }

  // ── Calendar-period keys (loss circuit-breaker) ──────────────────────────────

  /** UTC calendar-day key ("YYYY-MM-DD"). */
  dayKey(now: Date): string {
    return now.toISOString().slice(0, 10);
  }

  /** UTC Monday-anchored week-start key ("YYYY-MM-DD" of that week's Monday). */
  weekKey(now: Date): string {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const day = d.getUTCDay(); // 0=Sun..6=Sat
    const diffToMonday = (day + 6) % 7; // Mon=0, Tue=1, ..., Sun=6
    d.setUTCDate(d.getUTCDate() - diffToMonday);
    return d.toISOString().slice(0, 10);
  }

  /**
   * Rolls the day/week loss-circuit-breaker baselines forward when the calendar period has
   * changed since they were last recorded. Pure function, no side effects.
   */
  syncPeriodBaselines(
    state: GovernedAccountState,
    mtmEquity: number,
    now: Date,
  ): { state: GovernedAccountState; changed: boolean } {
    const dayKey = this.dayKey(now);
    const weekKey = this.weekKey(now);

    const dayChanged = state.day_key !== dayKey;
    const weekChanged = state.week_key !== weekKey;
    if (!dayChanged && !weekChanged) {
      return { state, changed: false };
    }

    return {
      state: {
        ...state,
        day_key: dayKey,
        day_start_equity: dayChanged ? mtmEquity : state.day_start_equity,
        week_key: weekKey,
        week_start_equity: weekChanged ? mtmEquity : state.week_start_equity,
      },
      changed: true,
    };
  }

  /**
   * Evaluates ONE period (day or week) of the loss circuit-breaker. `startEquity`
   * undefined/non-positive means the baseline hasn't been established yet — always passes.
   */
  checkPeriodLossLimit(
    startEquity: number | undefined,
    currentEquity: number,
    maxLossPct: number,
    label: 'daily' | 'weekly',
  ): { pass: boolean; reason?: string } {
    if (startEquity === undefined || startEquity <= 0) return { pass: true };
    const lossPct = (startEquity - currentEquity) / startEquity;
    if (lossPct >= maxLossPct) {
      return {
        pass: false,
        reason:
          `circuit breaker: ${label} loss ${(lossPct * 100).toFixed(2)}% >= ` +
          `${(maxLossPct * 100).toFixed(2)}% — new entries blocked until the next ${
            label === 'daily' ? 'day' : 'week'
          } (UTC)`,
      };
    }
    return { pass: true };
  }

  /** Best-effort audit of a loss-circuit-breaker trip. Never breaks execution. */
  private async _auditLossBreakerTrip(period: 'daily' | 'weekly', reason: string): Promise<void> {
    if (!this.audit) return;
    try {
      await this.audit.log({
        event_type: 'loss_circuit_breaker_tripped',
        meta: { period, reason },
      });
    } catch {
      // audit is best-effort — a logging failure must never affect execution.
    }
  }

  // ── Entry gate ────────────────────────────────────────────────────────────────

  /**
   * Kernel entry gate for NEW ENTRIES (long/short): mark-to-market (fail-closed) →
   * daily/weekly loss circuit-breaker (if enabled) → peak-to-trough drawdown halt →
   * max-open-positions ceiling. "exit"/"hold" NEVER call this — closing/holding always
   * bypasses every gate (closeability invariant), enforced by callers.
   *
   * Returns the (possibly period-baseline-reset) `state` alongside pass/reason. Callers
   * MUST use this returned `state` for any subsequent fill/persistence. When `baselineChanged`
   * is true AND the entry is ultimately rejected, the caller MUST persist `state` immediately
   * (a rejected intent never reaches the fill step).
   */
  async evaluateEntryGate(
    state: GovernedAccountState,
    policy: RiskPolicy,
  ): Promise<EntryGateResult> {
    const mtm = await this.markToMarket(state);
    if (!mtm.ok) {
      this.log.warn(
        'ENTRY BLOCKED: mark-to-market failed for one or more open positions — refusing new entry (fail-closed)',
      );
      return {
        pass: false,
        reason: 'mark-to-market unavailable for one or more open positions — refusing new entry',
        state,
        baselineChanged: false,
      };
    }

    const { state: syncedState, changed: baselineChanged } = this.syncPeriodBaselines(
      state,
      mtm.equity,
      new Date(),
    );

    if (policy.loss_circuit_breaker_enabled) {
      const daily = this.checkPeriodLossLimit(
        syncedState.day_start_equity,
        mtm.equity,
        policy.max_daily_loss_pct,
        'daily',
      );
      if (!daily.pass) {
        await this._auditLossBreakerTrip('daily', daily.reason ?? '');
        return { pass: false, reason: daily.reason, state: syncedState, baselineChanged };
      }

      const weekly = this.checkPeriodLossLimit(
        syncedState.week_start_equity,
        mtm.equity,
        policy.max_weekly_loss_pct,
        'weekly',
      );
      if (!weekly.pass) {
        await this._auditLossBreakerTrip('weekly', weekly.reason ?? '');
        return { pass: false, reason: weekly.reason, state: syncedState, baselineChanged };
      }
    }

    const freshState: GovernedAccountState = { ...syncedState, equity: mtm.equity, hwm: mtm.hwm };

    const drawdown = this.computeDrawdownPct(freshState);
    if (drawdown >= policy.max_drawdown_halt_pct) {
      return {
        pass: false,
        reason: `circuit breaker: drawdown ${drawdown}% >= ${policy.max_drawdown_halt_pct}%`,
        state: freshState,
        baselineChanged,
      };
    }

    if (freshState.positions.length >= policy.max_open_positions) {
      return {
        pass: false,
        reason: `max open positions reached (${freshState.positions.length}/${policy.max_open_positions})`,
        state: freshState,
        baselineChanged,
      };
    }

    return { pass: true, state: freshState, baselineChanged };
  }

  // ── Sizing ceilings ───────────────────────────────────────────────────────────

  /**
   * Hard, non-bypassable ceiling on entry sizing: qty can never exceed what
   * maxPositionPct allows for the current equity.
   */
  clampToPositionCeiling(
    qty: number,
    equity: number,
    price: number,
    maxPositionPct: number,
    context: string,
  ): number {
    if (qty <= 0) return qty;
    const maxQty = Math.floor((equity * maxPositionPct) / price);
    if (qty > maxQty) {
      this.log.warn(
        `POSITION SIZE CLAMPED (${context}): qty ${qty} → ${maxQty} ` +
          `(ceiling: equity=${equity} * max_position_pct=${maxPositionPct} / price=${price})`,
      );
      return maxQty;
    }
    return qty;
  }

  /**
   * Additional, short-specific ceiling ON TOP OF clampToPositionCeiling: a short's notional
   * can never exceed maxShortNotionalPct of equity. Only ever REDUCES qty further.
   */
  clampToShortNotionalCeiling(
    qty: number,
    equity: number,
    price: number,
    maxShortNotionalPct: number,
    context: string,
  ): number {
    if (qty <= 0) return qty;
    const maxQty = Math.floor((equity * maxShortNotionalPct) / price);
    if (qty > maxQty) {
      this.log.warn(
        `SHORT SIZE CLAMPED (${context}): qty ${qty} → ${maxQty} ` +
          `(ceiling: equity=${equity} * max_short_notional_pct=${maxShortNotionalPct} / price=${price})`,
      );
      return maxQty;
    }
    return qty;
  }

  /** Computes total position value using fillPrice for the traded symbol, avg_price for others. */
  positionsValue(positions: GovernedPosition[], fillPrice: number, tradedSymbol: string): number {
    return positions.reduce((sum, p) => {
      const price = p.symbol === tradedSymbol ? fillPrice : p.avg_price;
      return sum + price * p.quantity;
    }, 0);
  }

  // ── Fill logic ────────────────────────────────────────────────────────────────

  /**
   * Applies a governed trade to account state (pure function). Returns executed quantity,
   * any realized_pnl (exit only), and the updated state.
   *
   * commissionPct (default 0) embeds a fee into the cost basis on long/short entries and
   * subtracts it from realized_pnl on exit — mirrors PretestService's original commission
   * accounting. Callers that never modeled commission (the live paper account) simply never
   * pass it, so this is a byte-identical no-op for them.
   *
   * "long"  → buy floor(cash * sizingPct / fillPrice) shares, clamped to maxPositionPct.
   *           Refuses to open on top of an existing SHORT (use "exit" to cover first).
   * "short" → sell-to-open, clamped to maxPositionPct AND maxShortNotionalPct. Position
   *           quantity goes NEGATIVE. Refuses to open on top of an existing LONG.
   * "exit"  → closes the ENTIRE existing position (long or short). quantity is SIGNED, so
   *           realized_pnl = (fill - avg) * quantity generalizes to both a long exit and a
   *           short cover.
   * "hold"  → no trade, quantity=0.
   */
  executeFill(
    action: TradeAction,
    symbol: string,
    fillPrice: number,
    state: GovernedAccountState,
    sizingPct: number,
    maxPositionPct: number,
    maxShortNotionalPct: number,
    commissionPct = 0,
  ): FillResult {
    const newState: GovernedAccountState = {
      ...state,
      positions: state.positions.map((p) => ({ ...p })),
    };
    const baseHwm = state.hwm ?? state.equity;
    const baseEquity = state.equity;

    if (action === 'long') {
      return this._executeLong(
        symbol,
        fillPrice,
        newState,
        baseHwm,
        sizingPct,
        maxPositionPct,
        baseEquity,
        commissionPct,
      );
    }

    if (action === 'short') {
      return this._executeShort(
        symbol,
        fillPrice,
        newState,
        baseHwm,
        sizingPct,
        maxPositionPct,
        maxShortNotionalPct,
        baseEquity,
        commissionPct,
      );
    }

    if (action === 'exit') {
      const posIdx = newState.positions.findIndex((p) => p.symbol === symbol);
      if (posIdx < 0) {
        newState.hwm = Math.max(baseHwm, newState.equity);
        return { quantity: 0, realized_pnl: null, newState };
      }
      const pos = newState.positions[posIdx];
      const quantity = pos.quantity;
      const proceeds = fillPrice * quantity;
      const commission_cost = Math.abs(proceeds) * commissionPct;
      const realized_pnl = (fillPrice - pos.avg_price) * quantity - commission_cost;
      // Both a long exit (proceeds>0, commission debited from proceeds) and a short cover
      // (proceeds<0, i.e. a debit to buy back — commission makes that debit LARGER) are
      // covered by this single formula: cash += proceeds - commission_cost.
      newState.cash += proceeds - commission_cost;
      newState.positions.splice(posIdx, 1);
      newState.equity = newState.cash + this.positionsValue(newState.positions, fillPrice, symbol);
      newState.hwm = Math.max(baseHwm, newState.equity);
      return { quantity, realized_pnl, newState };
    }

    // "hold": no portfolio mutation.
    newState.hwm = Math.max(baseHwm, newState.equity);
    return { quantity: 0, realized_pnl: null, newState };
  }

  private _executeLong(
    symbol: string,
    fillPrice: number,
    newState: GovernedAccountState,
    baseHwm: number,
    sizingPct: number,
    maxPositionPct: number,
    baseEquity: number,
    commissionPct: number,
  ): FillResult {
    const existing = newState.positions.find((p) => p.symbol === symbol);
    if (existing && existing.quantity < 0) {
      newState.hwm = Math.max(baseHwm, newState.equity);
      return { quantity: 0, realized_pnl: null, newState };
    }

    const budget = newState.cash * sizingPct;
    const costPerShare = fillPrice * (1 + commissionPct);
    const quantity = this.clampToPositionCeiling(
      costPerShare > 0 ? Math.floor(budget / costPerShare) : 0,
      baseEquity,
      fillPrice,
      maxPositionPct,
      'long',
    );
    if (quantity <= 0) {
      newState.hwm = Math.max(baseHwm, newState.equity);
      return { quantity: 0, realized_pnl: null, newState };
    }
    const notional = fillPrice * quantity;
    const commission = notional * commissionPct;
    newState.cash -= notional + commission;
    const costBasisPrice = (notional + commission) / quantity;

    if (existing) {
      const totalQty = existing.quantity + quantity;
      existing.avg_price =
        (existing.avg_price * existing.quantity + costBasisPrice * quantity) / totalQty;
      existing.quantity = totalQty;
    } else {
      newState.positions.push({ symbol, quantity, avg_price: costBasisPrice });
    }

    newState.equity = newState.cash + this.positionsValue(newState.positions, fillPrice, symbol);
    newState.hwm = Math.max(baseHwm, newState.equity);
    return { quantity, realized_pnl: null, newState };
  }

  private _executeShort(
    symbol: string,
    fillPrice: number,
    newState: GovernedAccountState,
    baseHwm: number,
    sizingPct: number,
    maxPositionPct: number,
    maxShortNotionalPct: number,
    baseEquity: number,
    commissionPct: number,
  ): FillResult {
    const existing = newState.positions.find((p) => p.symbol === symbol);
    if (existing && existing.quantity > 0) {
      newState.hwm = Math.max(baseHwm, newState.equity);
      return { quantity: 0, realized_pnl: null, newState };
    }

    const budget = newState.cash * sizingPct;
    const notionalPerShare = fillPrice * (1 + commissionPct);
    let quantity = this.clampToPositionCeiling(
      notionalPerShare > 0 ? Math.floor(budget / notionalPerShare) : 0,
      baseEquity,
      fillPrice,
      maxPositionPct,
      'short',
    );
    quantity = this.clampToShortNotionalCeiling(
      quantity,
      baseEquity,
      fillPrice,
      maxShortNotionalPct,
      'short',
    );
    if (quantity <= 0) {
      newState.hwm = Math.max(baseHwm, newState.equity);
      return { quantity: 0, realized_pnl: null, newState };
    }

    const notional = fillPrice * quantity;
    const commission = notional * commissionPct;
    const netProceeds = notional - commission;
    newState.cash += netProceeds;
    const costBasisPrice = netProceeds / quantity;

    if (existing) {
      const existingAbs = Math.abs(existing.quantity);
      const totalQty = existingAbs + quantity;
      existing.avg_price =
        (existing.avg_price * existingAbs + costBasisPrice * quantity) / totalQty;
      existing.quantity = -totalQty;
    } else {
      newState.positions.push({ symbol, quantity: -quantity, avg_price: costBasisPrice });
    }

    newState.equity = newState.cash + this.positionsValue(newState.positions, fillPrice, symbol);
    newState.hwm = Math.max(baseHwm, newState.equity);
    return { quantity, realized_pnl: null, newState };
  }

  // ── Combined evaluate + execute entry ────────────────────────────────────────

  /**
   * The single governed-execution entry point: runs the entry gate (for long/short only),
   * fetches a fresh quote (with optional slippage), and applies the fill.
   *
   * "exit"/"hold" NEVER run the entry gate (closeability invariant) — "exit" still needs a
   * fresh quote to compute a fill; "hold" needs neither quote nor gate.
   *
   * Slippage direction mirrors the historical pretest model: buy-side executions (long,
   * or an exit that covers an existing short) fill WORSE at a higher price; sell-side
   * executions (short, or an exit that closes an existing long) fill WORSE at a lower price.
   * slippagePct defaults to 0 (no-op) — the live paper account never passes it, preserving
   * its exact historical (unslipped) fills.
   */
  async evaluateAndExecuteEntry(
    action: TradeAction,
    symbol: string,
    state: GovernedAccountState,
    riskPolicy: RiskPolicy,
    fillPolicy: FillPolicy,
  ): Promise<EvaluateAndExecuteResult> {
    if (action === 'hold') {
      const newState: GovernedAccountState = {
        ...state,
        positions: state.positions.map((p) => ({ ...p })),
      };
      newState.hwm = Math.max(state.hwm ?? state.equity, newState.equity);
      return { pass: true, quantity: 0, realized_pnl: null, newState, baselineChanged: false };
    }

    let gateState = state;
    let baselineChanged = false;
    if (action === 'long' || action === 'short') {
      const gate = await this.evaluateEntryGate(state, riskPolicy);
      gateState = gate.state;
      baselineChanged = gate.baselineChanged;
      if (!gate.pass) {
        return {
          pass: false,
          reason: gate.reason,
          quantity: 0,
          realized_pnl: null,
          newState: gateState,
          baselineChanged,
        };
      }
    }

    let last: number;
    try {
      const quote = await this.gateway.getQuote(null, symbol);
      last = quote.last;
    } catch (err) {
      return {
        pass: false,
        reason: `quote unavailable: ${String(err)}`,
        quantity: 0,
        realized_pnl: null,
        newState: gateState,
        baselineChanged,
      };
    }
    if (!isFinite(last) || last <= 0) {
      return {
        pass: false,
        reason: `invalid fill price: ${last}`,
        quantity: 0,
        realized_pnl: null,
        newState: gateState,
        baselineChanged,
      };
    }

    const slippagePct = fillPolicy.slippagePct ?? 0;
    const isBuySide =
      action === 'long' ||
      (action === 'exit' &&
        (gateState.positions.find((p) => p.symbol === symbol)?.quantity ?? 0) < 0);
    const fillPrice = isBuySide ? last * (1 + slippagePct) : last * (1 - slippagePct);

    const { quantity, realized_pnl, newState } = this.executeFill(
      action,
      symbol,
      fillPrice,
      gateState,
      fillPolicy.sizingPct,
      fillPolicy.maxPositionPct,
      fillPolicy.maxShortNotionalPct,
      fillPolicy.commissionPct ?? 0,
    );

    return { pass: true, quantity, realized_pnl, newState, baselineChanged };
  }

  // ── Narrow rebalance exception ────────────────────────────────────────────────

  /**
   * Vol-target rebalance of an EXISTING position — an intentional, NARROW exception that
   * skips the entry risk gate. Rebalancing toward a lower exposure_scalar is risk-REDUCING
   * (never risk-increasing), so it must remain reachable even during an active halt/circuit
   * breaker — mirroring the closeability invariant "exit always bypasses gates", extended to
   * "shrinking exposure toward the risk-manager's target always bypasses gates". This is NOT
   * a general-purpose gate backdoor: it only ever adjusts a position the account ALREADY
   * holds, by a caller-computed partial quantity — it never opens a new position.
   *
   * direction 'buy' increases the position (or opens a new one — used for scaling UP an
   * existing long); 'sell' decreases it, capped at the held long quantity (never flips to
   * short). Commission-aware, mirrors the historical PretestService._applyBuy/_applySell
   * cost-basis math for partial quantities.
   */
  applyRebalanceTrade(
    direction: 'buy' | 'sell',
    symbol: string,
    quantity: number,
    price: number,
    state: GovernedAccountState,
    commissionPct = 0,
  ): { newState: GovernedAccountState; realized_pnl: number | null } {
    const newState: GovernedAccountState = {
      ...state,
      positions: state.positions.map((p) => ({ ...p })),
    };
    if (quantity <= 0 || price <= 0) return { newState, realized_pnl: null };

    if (direction === 'buy') {
      const notional = price * quantity;
      const commission = notional * commissionPct;
      const totalCost = notional + commission;
      if (totalCost > newState.cash) return { newState, realized_pnl: null };
      newState.cash -= totalCost;
      const costBasisPrice = totalCost / quantity;
      const existing = newState.positions.find((p) => p.symbol === symbol);
      if (existing) {
        const totalQty = existing.quantity + quantity;
        existing.avg_price =
          (existing.avg_price * existing.quantity + costBasisPrice * quantity) / totalQty;
        existing.quantity = totalQty;
      } else {
        newState.positions.push({ symbol, quantity, avg_price: costBasisPrice });
      }
      newState.equity = newState.cash + this.positionsValue(newState.positions, price, symbol);
      newState.hwm = Math.max(state.hwm ?? state.equity, newState.equity);
      return { newState, realized_pnl: null };
    }

    // 'sell': capped at held long quantity — never flips into a short.
    const posIdx = newState.positions.findIndex((p) => p.symbol === symbol);
    if (posIdx < 0 || newState.positions[posIdx].quantity <= 0) {
      return { newState, realized_pnl: null };
    }
    const pos = newState.positions[posIdx];
    const qty = Math.min(quantity, pos.quantity);
    const proceeds = price * qty;
    const commission = proceeds * commissionPct;
    const realized_pnl = (price - pos.avg_price) * qty - commission;
    newState.cash += proceeds - commission;
    pos.quantity -= qty;
    if (pos.quantity <= 0) newState.positions.splice(posIdx, 1);
    newState.equity = newState.cash + this.positionsValue(newState.positions, price, symbol);
    newState.hwm = Math.max(state.hwm ?? state.equity, newState.equity);
    return { newState, realized_pnl };
  }
}
