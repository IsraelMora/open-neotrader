/**
 * VetoAnalyzerService — read-side "veto value analyzer".
 *
 * Design decisions:
 * - Leaf-ish service: depends on PrismaService + ProviderGatewayService (direct Prisma
 *   access, NO repository layer), mirroring MlSignalRecordService / BacktestService.
 * - NULL-at-write, backfilled-later, fail-soft, no-lookahead pattern: veto_decisions rows
 *   are written with cf_pnl/cf_method = NULL by the veto ledger (agents.service.ts); this
 *   service backfills them later from OHLCV data that did not exist at write time.
 * - backfill() is fail-soft PER ROW: a provider error for one symbol must not abort
 *   processing of the other rows in the same batch (mirrors _persistVetoDecisions'
 *   per-row try/catch style).
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderGatewayService, type OhlcvBar } from '../providers/provider-gateway.service';
import { KvService } from '../common/kv.service';
import { kvNum } from '../common/kv.util';

// ── Types ─────────────────────────────────────────────────────────────────────

export type SupportedAction = 'long' | 'short';

export interface VetoDecisionRow {
  id: string;
  ts: Date;
  symbol: string;
  source_plugin: string;
  verdict: string;
  proposed_action: string;
  proposed_qty: number;
  approved_qty: number | null;
  ref_price: number | null;
  discipline: string | null;
  cf_pnl: number | null;
  cf_method: string | null;
  cf_evaluated_at: Date | null;
}

export interface BackfillOptions {
  /** Number of bars after the decision ts used to mark-to-market. Default 5. */
  horizonBars?: number;
  /** OHLCV timeframe used for the mark-to-market lookup. Default '1d'. */
  timeframe?: string;
  /** Round-trip trading cost in basis points (10 bps = 0.001 decimal). Default 10. */
  costBps?: number;
  /**
   * When true, ALSO re-selects rows previously marked terminal `insufficient_data` (in
   * addition to the normal unevaluated rows). One-shot re-processing policy: this is meant
   * to be run manually/occasionally after widening the provider's history depth, NOT on
   * every routine backfill — insufficient_data rows are otherwise left alone once written,
   * same as unsupported_action/invalid_ref_price. Default false. Never re-selects
   * unsupported_action or invalid_ref_price — those are legitimately terminal regardless of
   * OHLCV availability.
   */
  reprocessInsufficient?: boolean;
}

export interface BackfillSummary {
  evaluated: number;
  insufficientData: number;
  unsupportedAction: number;
  /** ref_price was 0, negative, or non-finite — excluded from totals, terminal (never re-selected). */
  invalidRefPrice: number;
  /**
   * The horizon bar cannot exist yet (decision hasn't matured) — NOT written to the ledger
   * (cf_pnl AND cf_method both stay null) so the row is retried on the next backfill().
   */
  pending: number;
  errors: number;
}

export interface MetricsWindow {
  from?: Date;
  to?: Date;
}

export interface VetoMetricsReport {
  net_value: number;
  counts_by_verdict: { approved: number; blocked: number; modified: number };
  evaluated_count: number;
  unsupported_action_count: number;
  insufficient_data_count: number;
  /** Sum of positive per-decision contributions — value protected by the veto shield. */
  losses_avoided: number;
  /**
   * Sum of NEGATIVE per-decision contributions. Kept as a non-positive number (sign
   * convention: negative = value forgone by blocking/reducing a trade that would have
   * profited). Callers that want a "magnitude" should negate this value.
   */
  profits_forgone: number;
  /** Net value contribution summed per discipline (only decisions with a discipline set). */
  by_discipline: Record<string, number>;
}

export interface PluginValueEntry {
  source_plugin: string;
  evaluated_count: number;
  /** Sum of cf_pnl across this plugin's evaluated rows — see PluginValueReport doc re: counterfactual semantics. */
  net_value: number;
  wins: number;
  win_rate: number;
  avg_cf_pnl: number;
}

/**
 * Per-plugin raw signal value attribution: "did THIS PLUGIN's proposed signal make money net
 * of cost", using cf_pnl for ALL evaluated rows regardless of verdict (approved/blocked/modified
 * all count equally here). This is DELIBERATELY different from VetoMetricsReport, which measures
 * whether the veto LAYER's intervention (blocking/modifying) added value — this report instead
 * measures the plugin's raw signal quality, independent of what the veto layer decided to do
 * with it.
 *
 * IMPORTANT: cf_pnl is a COUNTERFACTUAL value computed from OHLCV mark-to-market (see backfill()
 * doc), NOT actual executed fills — this report is honest about that, it is not claiming real P&L.
 */
export interface PluginValueReport {
  /** Sorted by net_value descending (best-performing plugin first). */
  plugins: PluginValueEntry[];
  totals: Omit<PluginValueEntry, 'source_plugin'>;
}

const DEFAULT_HORIZON_BARS = 5;
const DEFAULT_TIMEFRAME = '1d';
const DEFAULT_COST_BPS = 10;

/**
 * KV key controlling the automatic backfill sweep cadence (ms). A missing/invalid value
 * falls back to DEFAULT_BACKFILL_INTERVAL_MS; a value <= 0 explicitly DISABLES the
 * scheduler (no timer is started at all) so an operator can turn the sweep off from KV
 * without a redeploy. Mirrors the guarded kvNum read used by RealBrokerReconciliationService.
 */
const BACKFILL_INTERVAL_KEY = 'veto.backfill_interval_ms';
/** Default cadence for the automatic backfill sweep — 6 hours. cf_pnl is not time-sensitive. */
const DEFAULT_BACKFILL_INTERVAL_MS = 6 * 60 * 60_000;
/** Extra bars fetched beyond the strict decision-to-now need, to absorb non-trading gaps. */
const FETCH_LIMIT_BUFFER = 20;
/** Hard cap on a single fetch's bar count — protects providers from unbounded requests for old decisions. */
const MAX_FETCH_LIMIT = 1500;

/**
 * Approximate bar duration, used ONLY to bound fetch windows and maturity checks (never for
 * the counterfactual math itself, which stays exact/bar-index based). Unknown timeframes
 * default to '1d'.
 */
const BAR_DURATION_MS: Record<string, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '1w': 7 * 24 * 60 * 60_000,
};

function barDurationMs(timeframe: string): number {
  return BAR_DURATION_MS[timeframe] ?? BAR_DURATION_MS['1d'];
}

interface ResolvedBackfillOptions {
  horizonBars: number;
  timeframe: string;
  costBps: number;
  reprocessInsufficient: boolean;
}

function resolveOptions(opts?: BackfillOptions): ResolvedBackfillOptions {
  return {
    horizonBars: opts?.horizonBars ?? DEFAULT_HORIZON_BARS,
    timeframe: opts?.timeframe ?? DEFAULT_TIMEFRAME,
    costBps: opts?.costBps ?? DEFAULT_COST_BPS,
    reprocessInsufficient: opts?.reprocessInsufficient ?? false,
  };
}

function isSupportedAction(action: string): action is SupportedAction {
  return action === 'long' || action === 'short';
}

/**
 * True once the horizonBars-th bar after decisionTs could plausibly have printed, approximated
 * as `decisionTs + horizonBars * barDurationMs(timeframe) <= now`. Before that point the row is
 * PENDING (not insufficient — the data simply doesn't exist yet), and must be left unevaluated
 * for a later backfill() to retry.
 */
function isMature(decisionTs: Date, horizonBars: number, timeframe: string, now: Date): boolean {
  const maturityTime = decisionTs.getTime() + horizonBars * barDurationMs(timeframe);
  return now.getTime() >= maturityTime;
}

/**
 * Dynamic fetch limit anchored at the decision: enough bars to reach back from `now` to
 * decisionTs, plus horizonBars, plus a small buffer for non-trading gaps — capped at
 * MAX_FETCH_LIMIT so a very old decision can't trigger an unbounded provider request.
 */
function computeNeededFetchLimit(
  decisionTs: Date,
  horizonBars: number,
  timeframe: string,
  now: Date,
): number {
  const barMs = barDurationMs(timeframe);
  const barsSinceDecision = Math.max(Math.ceil((now.getTime() - decisionTs.getTime()) / barMs), 0);
  const needed = barsSinceDecision + horizonBars + FETCH_LIMIT_BUFFER;
  return Math.min(needed, MAX_FETCH_LIMIT);
}

/** Parses a provider bar timestamp to epoch ms; returns null when unparseable. */
function parseTsMs(ts: string): number | null {
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Locates the mark-to-market bar: the horizonBars-th bar strictly after decisionTs,
 * in chronological order. Compares parsed epoch ms (not raw string ordering) because some
 * providers emit intraday bars with inconsistent sub-second precision, which lexicographic
 * string comparison can misorder. Unparseable bar timestamps are skipped (never "after").
 * Returns null when fewer than horizonBars such bars exist (insufficient historical depth —
 * a real, reportable outcome, not an error).
 */
function locateMarkBar(bars: OhlcvBar[], decisionTs: string, horizonBars: number): OhlcvBar | null {
  const decisionMs = parseTsMs(decisionTs);
  if (decisionMs === null) return null;

  const after = bars
    .map((b) => ({ bar: b, ms: parseTsMs(b.ts) }))
    .filter((x): x is { bar: OhlcvBar; ms: number } => x.ms !== null && x.ms > decisionMs)
    .sort((a, b) => a.ms - b.ms);
  if (after.length < horizonBars) return null;
  return after[horizonBars - 1].bar;
}

/** Direction-aware gross unit return, net of the round-trip cost model (costBps as decimal). */
function computeNetUnitReturn(
  action: SupportedAction,
  refPrice: number,
  markPrice: number,
  costBps: number,
): number {
  const gross =
    action === 'long' ? (markPrice - refPrice) / refPrice : (refPrice - markPrice) / refPrice;
  return gross - costBps / 10_000;
}

function buildCfMethod(opts: ResolvedBackfillOptions): string {
  return `fixed_horizon:${opts.horizonBars}:${opts.timeframe}:costbps${opts.costBps}:v1`;
}

/** Terminal cf_method values that mean "not a real evaluation" — never counted as evaluated. */
const TERMINAL_NON_EVALUATED_METHODS = new Set([
  'unsupported_action',
  'insufficient_data',
  'invalid_ref_price',
]);

/** Bucket key used for rows with a missing/blank source_plugin — see getPluginValue doc. */
const UNKNOWN_PLUGIN_KEY = 'unknown';

function emptyPluginValueEntry(source_plugin: string): PluginValueEntry {
  return { source_plugin, evaluated_count: 0, net_value: 0, wins: 0, win_rate: 0, avg_cf_pnl: 0 };
}

/** Finalizes win_rate/avg_cf_pnl from accumulated sums, guarding divide-by-zero (never NaN). */
function finalizePluginValueEntry(entry: PluginValueEntry): void {
  entry.win_rate = entry.evaluated_count > 0 ? entry.wins / entry.evaluated_count : 0;
  entry.avg_cf_pnl = entry.evaluated_count > 0 ? entry.net_value / entry.evaluated_count : 0;
}

@Injectable()
export class VetoAnalyzerService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(VetoAnalyzerService.name);

  /** Steady-state backfill ticker; null when the scheduler is disabled or shut down. */
  private backfillTicker: ReturnType<typeof setInterval> | null = null;
  /** Overlap guard — true while a scheduled backfill() sweep is still in flight. */
  private backfillRunning = false;

  constructor(
    private readonly db: PrismaService,
    private readonly providerGateway: ProviderGatewayService,
    private readonly kv: KvService,
  ) {}

  /**
   * Starts the automatic backfill scheduler: a KV-configured setInterval loop that
   * periodically calls backfill() so cf_pnl is populated without an operator manually
   * hitting POST /veto-metrics/backfill. Mirrors RealBrokerReconciliationService's
   * steady-state loop pattern (guarded kvNum read, OnModuleInit/OnModuleDestroy timer,
   * overlap guard, fail-soft tick). Deliberately does NOT run a sweep at startup — the
   * first sweep happens one interval later, so app boot stays fast and does not fan out
   * a provider OHLCV burst. A KV interval <= 0 disables the loop entirely (no timer).
   */
  async onModuleInit(): Promise<void> {
    const intervalMs = await this._readBackfillIntervalMs();
    if (intervalMs <= 0) {
      this.log.log(`[veto-analyzer] backfill scheduler disabled (${BACKFILL_INTERVAL_KEY} <= 0)`);
      return;
    }
    this.backfillTicker = setInterval(() => void this._backfillTick(), intervalMs);
    this.log.log(`[veto-analyzer] backfill scheduler started (interval=${intervalMs}ms)`);
  }

  onModuleDestroy(): void {
    if (this.backfillTicker) {
      clearInterval(this.backfillTicker);
      this.backfillTicker = null;
    }
  }

  /** Reads the backfill interval from KV, defaulting to 6h (see BACKFILL_INTERVAL_KEY doc). */
  private async _readBackfillIntervalMs(): Promise<number> {
    let raw: string | null;
    try {
      raw = await this.kv.get(BACKFILL_INTERVAL_KEY);
    } catch {
      raw = null;
    }
    return kvNum(raw, DEFAULT_BACKFILL_INTERVAL_MS);
  }

  /**
   * One scheduled sweep: overlap guard (skip if the previous sweep is still running) +
   * fail-soft (a throwing backfill() is caught and logged, NEVER escapes the timer
   * callback — the loop must keep ticking regardless of a transient provider/DB error).
   */
  private async _backfillTick(): Promise<void> {
    if (this.backfillRunning) return;
    this.backfillRunning = true;
    try {
      const summary = await this.backfill();
      this.log.log(
        `[veto-analyzer] scheduled backfill: evaluated=${summary.evaluated} ` +
          `pending=${summary.pending} errors=${summary.errors}`,
      );
    } catch (e) {
      this.log.warn(`[veto-analyzer] scheduled backfill tick failed (loop continues): ${e}`);
    } finally {
      this.backfillRunning = false;
    }
  }

  /**
   * Backfills cf_pnl / cf_method / cf_evaluated_at for all unevaluated veto_decisions
   * rows (cf_pnl IS NULL AND cf_method IS NULL). Fail-soft PER ROW: a provider error for
   * one symbol leaves that row unevaluated (retried on the next call) without aborting
   * the rest of the batch.
   */
  async backfill(opts?: BackfillOptions): Promise<BackfillSummary> {
    const resolved = resolveOptions(opts);
    const summary: BackfillSummary = {
      evaluated: 0,
      insufficientData: 0,
      unsupportedAction: 0,
      invalidRefPrice: 0,
      pending: 0,
      errors: 0,
    };

    // One-shot re-processing: reprocessInsufficient ALSO re-selects terminal insufficient_data
    // rows, but never unsupported_action or invalid_ref_price — those are legitimately terminal
    // regardless of OHLCV availability (see BackfillOptions.reprocessInsufficient doc).
    const where = resolved.reprocessInsufficient
      ? { OR: [{ cf_pnl: null, cf_method: null }, { cf_method: 'insufficient_data' }] }
      : { cf_pnl: null, cf_method: null };

    const rows = (await this.db.vetoDecision.findMany({ where })) as VetoDecisionRow[];

    for (const row of rows) {
      try {
        await this._evaluateRow(row, resolved, summary);
      } catch (e) {
        summary.errors += 1;
        this.log.warn(
          `[veto-analyzer] backfill failed for decision ${row.id} (${row.symbol}) — left unevaluated: ${e}`,
        );
      }
    }

    return summary;
  }

  /** Marks a row as unresolvable (terminal cf_method, no numeric cf_pnl) — cf_pnl stays NULL. */
  private async _markUnresolvable(
    row: VetoDecisionRow,
    method: 'unsupported_action' | 'insufficient_data' | 'invalid_ref_price',
  ): Promise<void> {
    await this.db.vetoDecision.update({
      where: { id: row.id },
      data: { cf_pnl: null, cf_method: method, cf_evaluated_at: new Date() },
    });
  }

  private async _evaluateRow(
    row: VetoDecisionRow,
    opts: ResolvedBackfillOptions,
    summary: BackfillSummary,
  ): Promise<void> {
    if (!isSupportedAction(row.proposed_action)) {
      await this._markUnresolvable(row, 'unsupported_action');
      summary.unsupportedAction += 1;
      return;
    }

    // Guards 0, negative, NaN and null in one shot: any of those makes `> 0` false, and a
    // division by refPrice in computeNetUnitReturn would otherwise write NaN/Infinity into
    // cf_pnl, permanently poisoning net_value downstream.
    if (!(row.ref_price !== null && row.ref_price > 0 && Number.isFinite(row.ref_price))) {
      await this._markUnresolvable(row, 'invalid_ref_price');
      summary.invalidRefPrice += 1;
      return;
    }

    const now = new Date();
    if (!isMature(row.ts, opts.horizonBars, opts.timeframe, now)) {
      // The horizonBars-th bar after ts cannot exist yet — this is PENDING, not insufficient.
      // Leave cf_pnl AND cf_method both null so the row is retried on a later backfill().
      summary.pending += 1;
      return;
    }

    // Anchor the fetch window at the decision itself (not a trailing window ending "now"), so
    // bars printed right after an OLD decision are actually included. A provider error here
    // propagates to the caller's try/catch — the row is left unevaluated (both cf_pnl/cf_method
    // NULL) so it is retried on the next backfill().
    const neededLimit = computeNeededFetchLimit(row.ts, opts.horizonBars, opts.timeframe, now);
    const bars = await this.providerGateway.getOhlcv(null, row.symbol, opts.timeframe, neededLimit);

    const markBar = locateMarkBar(bars, row.ts.toISOString(), opts.horizonBars);
    if (!markBar) {
      await this._markUnresolvable(row, 'insufficient_data');
      summary.insufficientData += 1;
      return;
    }

    const netUnitReturn = computeNetUnitReturn(
      row.proposed_action,
      row.ref_price,
      markBar.close,
      opts.costBps,
    );
    // cf_pnl is the counterfactual P&L of the PROPOSED trade at proposed_qty — "what if
    // the veto hadn't acted".
    const cfPnl = netUnitReturn * row.ref_price * row.proposed_qty;

    await this.db.vetoDecision.update({
      where: { id: row.id },
      data: { cf_pnl: cfPnl, cf_method: buildCfMethod(opts), cf_evaluated_at: new Date() },
    });
    summary.evaluated += 1;
  }

  /**
   * Aggregates already-evaluated veto_decisions (cf_method IS NOT NULL) into the net
   * veto value report. Net value contribution per decision:
   *   - blocked:   executed_pnl = 0            → contributes -cf_pnl
   *   - modified:  executed_pnl = pnl(approved) → contributes executed_pnl - cf_pnl
   *   - approved:  contributes 0
   * losses_avoided = sum of positive contributions; profits_forgone = sum of negative
   * contributions (kept negative — see VetoMetricsReport doc).
   */
  async getMetrics(window?: MetricsWindow): Promise<VetoMetricsReport> {
    const rows = (await this.db.vetoDecision.findMany({
      where: this._buildMetricsWhere(window),
    })) as VetoDecisionRow[];

    const report: VetoMetricsReport = {
      net_value: 0,
      counts_by_verdict: { approved: 0, blocked: 0, modified: 0 },
      evaluated_count: 0,
      unsupported_action_count: 0,
      insufficient_data_count: 0,
      losses_avoided: 0,
      profits_forgone: 0,
      by_discipline: {},
    };

    for (const row of rows) {
      this._accumulateRow(row, report);
    }

    return report;
  }

  private _buildMetricsWhere(window?: MetricsWindow): Record<string, unknown> {
    return {
      cf_method: { not: null },
      ...(window?.from || window?.to
        ? {
            ts: {
              ...(window?.from ? { gte: window.from } : {}),
              ...(window?.to ? { lte: window.to } : {}),
            },
          }
        : {}),
    };
  }

  /** Folds a single already-fetched (backfilled) row into the running report — mutates report. */
  private _accumulateRow(row: VetoDecisionRow, report: VetoMetricsReport): void {
    if (row.verdict === 'approved' || row.verdict === 'blocked' || row.verdict === 'modified') {
      report.counts_by_verdict[row.verdict] += 1;
    }

    if (row.cf_method === 'unsupported_action') {
      report.unsupported_action_count += 1;
      return;
    }
    if (row.cf_method === 'insufficient_data') {
      report.insufficient_data_count += 1;
      return;
    }
    if (row.cf_pnl === null) return; // defensive: unknown cf_method without a value

    report.evaluated_count += 1;
    const contribution = this._contributionFor(row);
    report.net_value += contribution;
    if (contribution > 0) report.losses_avoided += contribution;
    else if (contribution < 0) report.profits_forgone += contribution;

    if (row.discipline) {
      report.by_discipline[row.discipline] =
        (report.by_discipline[row.discipline] ?? 0) + contribution;
    }
  }

  /** Net veto value contribution of a single already-evaluated decision. */
  private _contributionFor(row: VetoDecisionRow): number {
    const cfPnl = row.cf_pnl as number;
    if (row.verdict === 'blocked') return -cfPnl;
    if (row.verdict === 'approved') return 0;
    if (row.verdict === 'modified') {
      const approvedQty = row.approved_qty ?? 0;
      const denominator = row.proposed_qty * (row.ref_price ?? 0);
      if (denominator === 0) return 0;
      // net_unit_return is implied by cf_pnl = net_unit_return * ref_price * proposed_qty.
      const netUnitReturn = cfPnl / denominator;
      const executedPnl = netUnitReturn * (row.ref_price ?? 0) * approvedQty;
      return executedPnl - cfPnl;
    }
    return 0;
  }

  /**
   * Per-plugin raw signal value attribution — see PluginValueReport doc for full semantics.
   * Unlike getMetrics/_contributionFor (which measure the veto LAYER's intervention value),
   * this accumulates cf_pnl itself for EVERY evaluated row regardless of verdict: an approved
   * signal's cf_pnl is exactly what happened, a blocked/modified signal's cf_pnl is what WOULD
   * have happened had the plugin's proposal been followed as-is — both answer "was the plugin's
   * raw signal profitable", not "did the veto layer add value".
   */
  async getPluginValue(window?: MetricsWindow): Promise<PluginValueReport> {
    const rows = (await this.db.vetoDecision.findMany({
      where: this._buildPluginValueWhere(window),
    })) as VetoDecisionRow[];

    const byPlugin = new Map<string, PluginValueEntry>();
    for (const row of rows) {
      this._accumulatePluginRow(row, byPlugin);
    }

    const plugins = [...byPlugin.values()];
    for (const entry of plugins) finalizePluginValueEntry(entry);
    plugins.sort((a, b) => b.net_value - a.net_value);

    const totals = emptyPluginValueEntry(UNKNOWN_PLUGIN_KEY);
    for (const entry of plugins) {
      totals.evaluated_count += entry.evaluated_count;
      totals.net_value += entry.net_value;
      totals.wins += entry.wins;
    }
    finalizePluginValueEntry(totals);

    const totalsReport: Omit<PluginValueEntry, 'source_plugin'> = {
      evaluated_count: totals.evaluated_count,
      net_value: totals.net_value,
      wins: totals.wins,
      win_rate: totals.win_rate,
      avg_cf_pnl: totals.avg_cf_pnl,
    };
    return { plugins, totals: totalsReport };
  }

  /**
   * Where-clause for getPluginValue: only rows with a REAL fixed_horizon evaluation count
   * (cf_method not null AND not one of the terminal non-evaluated markers). Distinct from
   * _buildMetricsWhere (which only checks `cf_method: { not: null }`) because getMetrics'
   * _accumulateRow already special-cases the terminal methods itself — this method instead
   * excludes them at the query level since getPluginValue has no separate counters for them.
   */
  private _buildPluginValueWhere(window?: MetricsWindow): Record<string, unknown> {
    return {
      cf_method: { not: null, notIn: [...TERMINAL_NON_EVALUATED_METHODS] },
      ...(window?.from || window?.to
        ? {
            ts: {
              ...(window?.from ? { gte: window.from } : {}),
              ...(window?.to ? { lte: window.to } : {}),
            },
          }
        : {}),
    };
  }

  /** Folds a single already-evaluated row into the running per-plugin map — mutates byPlugin. */
  private _accumulatePluginRow(
    row: VetoDecisionRow,
    byPlugin: Map<string, PluginValueEntry>,
  ): void {
    if (row.cf_pnl === null) return; // defensive: should already be excluded by the where clause

    // Rows with a missing/blank source_plugin are bucketed under "unknown" rather than dropped,
    // so their counterfactual P&L still shows up in the report instead of silently vanishing.
    const key =
      row.source_plugin && row.source_plugin.trim() !== '' ? row.source_plugin : UNKNOWN_PLUGIN_KEY;

    const entry = byPlugin.get(key) ?? emptyPluginValueEntry(key);
    entry.evaluated_count += 1;
    entry.net_value += row.cf_pnl;
    if (row.cf_pnl > 0) entry.wins += 1;
    byPlugin.set(key, entry);
  }
}
