import { Injectable, Logger, Optional, Inject, forwardRef } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { LlmService } from '../llm/llm.service';
import { SandboxGateway } from '../sandbox/sandbox.gateway';
import { PluginsService, HydratedPlugin } from '../plugins/plugins.service';
import { ContextMemoryService } from '../context-memory/context-memory.service';
import { AuditService } from '../audit/audit.service';
import { AlertsService, CreateAlertDto } from '../alerts/alerts.service';
import { SnapshotService } from '../snapshot/snapshot.service';
import { NotifierBridge } from '../notifier/notifier-bridge';
import { ConfigService } from '@nestjs/config';
import { PretestService } from '../pretest/pretest.service';

import type { LlmResponse } from '../llm/llm.service';
import { parseToolCalls } from '../llm/kernel-parser';

/**
 * Input for a single governed LLM turn. Used by runGovernedTurn for both
 * interactive chat (source='chat') and scheduled cycle delegation (source='cycle').
 */
export interface GovernedTurnInput {
  /**
   * Discriminator for the caller:
   * - 'chat' emits a chat_turn audit event (interactive turns).
   * - 'cycle' skips the audit (cycle owns its own cycle_start/cycle_complete events).
   * - 'pretest' emits a pretest_turn audit event (virtual portfolio evaluation).
   * - 'reflection' enables kernel__write_skill injection and skips the turn-level audit
   *   (runReflectionTurn owns the reflection_turn audit). Added in s2.
   */
  source: 'chat' | 'cycle' | 'pretest' | 'reflection';
  /** User/cycle prompt (already enriched by the caller if needed). */
  context: string;
  /** Optional caller base system prompt; decision prompt + tool schema will be prepended by the kernel. */
  system_prompt?: string;
  /** Reuse the caller's cycle_id; if absent, a new UUID is generated. */
  cycle_id?: string;
  /**
   * Pre-fetched active plugins from _executeCycle. When provided, _validateToolCalls
   * skips its own findActive() call (single DB round-trip per cycle).
   * Only used when source === 'cycle'.
   */
  _activePlugins?: import('../plugins/plugins.service').HydratedPlugin[];
  /**
   * When true, instructs _validateToolCalls to drop any tool call targeting a plugin
   * with type === 'provider' BEFORE sandbox dispatch. Used by pretest to guarantee
   * no real broker orders are placed even if a provider tool-call slips through.
   */
  virtual_only?: boolean;
}

/** Result of a single governed LLM turn (validate + dispatch + audit). */
export interface GovernedTurnResult {
  cycle_id: string;
  text: string;
  tool_calls: import('../llm/llm.service').ToolCallRequest[];
  decisions: Decision[];
  sandbox_results: SandboxResult[];
  backend: 'api' | 'subscription';
  skills_read: string[];
  skills_written: string[];
  llm_response: LlmResponse;
  /** Authoritative signals emitted by _executeToolCalls (symbol+action pairs). */
  signalsEmitted: { symbol: string; action: string }[];
}

/** Resultado completo de un ciclo del agente, incluyendo decisiones, ejecuciones en sandbox y resumen de vetos. */
export interface AgentCycleResult {
  cycle_id: string;
  llm_text: string;
  decisions: Decision[];
  sandbox_results: SandboxResult[];
  llm_response: LlmResponse;
  context_injected: boolean;
  veto_summary: VetoSummary;
  /** True when a PRE-stage extra plugin aborted the cycle before the LLM turn. */
  aborted?: boolean;
}

/** Decisión de tool call del LLM: qué función invocar y si fue aprobada (o vetada con razón). */
export interface Decision {
  plugin_id: string;
  function: string;
  args: Record<string, unknown>;
  allowed: boolean;
  reason?: string;
}

/** Resultado de ejecutar una función de plugin en el sandbox Python. */
export interface SandboxResult {
  plugin_id: string;
  function: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** Resumen de la capa de veto: cuántas señales pasaron y cuántas fueron rechazadas por plugins discipline. */
export interface VetoSummary {
  signals_proposed: number;
  signals_approved: number;
  signals_vetoed: number;
  veto_reasons: string[];
  discipline_plugins: string[];
}

/**
 * Result of a runReflectionTurn call.
 * skipped:true means reflection was skipped (no plugin, cycle in progress, etc.).
 * skipped:false means the governed turn ran.
 */
export interface ReflectionTurnResult {
  skipped: boolean;
  reason?: string;
  cycle_id?: string;
  skills_written?: number;
}

// ── Kernel tool constants (Phase 3.6) ─────────────────────────────────────────

/**
 * Schema definition for the kernel__write_skill tool.
 * Injected into the LLM tool schema ONLY when source === 'reflection'.
 * In s1 the union does not include 'reflection', so this is never injected in production.
 */
const KERNEL_WRITE_SKILL_TOOL: import('../plugins/plugins.service').ProviderTool = {
  plugin_id: 'kernel',
  name: 'kernel__write_skill',
  description: 'Reescribe el cuerpo de un SKILL.md opt-in (llm_writable) durante una reflexión.',
  input_schema: {
    type: 'object',
    properties: {
      skill: { type: 'string' },
      new_body: { type: 'string' },
    },
    required: ['skill', 'new_body'],
  },
};

/**
 * Schema definition for the kernel__create_pretest_variant tool.
 * Injected into the LLM tool schema ONLY when source === 'reflection'.
 */
const KERNEL_CREATE_PRETEST_VARIANT_TOOL: import('../plugins/plugins.service').ProviderTool = {
  plugin_id: 'kernel',
  name: 'kernel__create_pretest_variant',
  description:
    'Creates a strategy variant in pretest (virtual portfolio) during a reflection turn.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      plugin_ids: { type: 'array', items: { type: 'string' } },
      plugin_configs: { type: 'object' },
      rationale: { type: 'string' },
    },
    required: ['name', 'plugin_ids'],
  },
};

/**
 * Schema definition for the kernel__run_pretest_compare tool.
 * Injected into the LLM tool schema ONLY when source === 'reflection'.
 * No arguments: compare() reads the current stored portfolio states.
 */
const KERNEL_RUN_PRETEST_COMPARE_TOOL: import('../plugins/plugins.service').ProviderTool = {
  plugin_id: 'kernel',
  name: 'kernel__run_pretest_compare',
  description: 'Compares all pretest portfolios (gate-aware) and returns winners.',
  input_schema: { type: 'object', properties: {}, required: [] },
};

/**
 * Maximum number of active pretest portfolios allowed. Enforced at dispatch time by
 * counting all portfolios via PretestService.findAll() before calling create().
 * Bounds parallel simulation cost and prevents LLM-driven portfolio explosion.
 */
const MAX_PRETEST_VARIANTS = 20;

/**
 * Registry of kernel-side tool functions. Any tool_call with plugin_id === 'kernel'
 * is validated against this set instead of the plugin allowlist. Unknown kernel
 * functions are dropped with reason 'unknown_kernel_tool'.
 */
const KERNEL_TOOL_REGISTRY: Set<string> = new Set([
  'write_skill',
  'create_pretest_variant',
  'run_pretest_compare',
]);

/** Orquesta el ciclo completo del agente: memoria, hooks de plugins, capa de veto, LLM y ejecución de tool calls. */
@Injectable()
export class AgentsService {
  private readonly log = new Logger(AgentsService.name);

  constructor(
    private readonly llm: LlmService,
    private readonly sandbox: SandboxGateway,
    private readonly plugins: PluginsService,
    private readonly memory: ContextMemoryService,
    private readonly audit: AuditService,
    private readonly alerts: AlertsService,
    private readonly snapshot?: SnapshotService,
    _cfg?: ConfigService,
    private readonly notifierBridge?: NotifierBridge,
    // PretestService injected optionally so existing unit-tests that don't provide
    // it continue compiling; _assembleReflectionContext degrades gracefully.
    // @Optional() preserves backward compat for tests that omit pretest.
    // @Inject(forwardRef(...)) breaks the AgentsModule ↔ PretestModule circular dep.
    @Optional()
    @Inject(forwardRef(() => PretestService))
    private readonly pretest?: PretestService,
  ) {}

  /**
   * Ejecuta un ciclo completo del agente: enriquece el contexto con memoria, corre los hooks de plugins,
   * aplica el veto de discipline plugins, consulta el LLM y ejecuta las tool calls aprobadas.
   * `context` es el prompt/contexto inicial del ciclo; `systemPrompt` sobreescribe el system prompt del LLM.
   */
  async runCycle(context: string, systemPrompt?: string): Promise<AgentCycleResult> {
    const cycle_id = randomUUID();

    await this.audit.log({ cycle_id, event_type: 'cycle_start' });

    try {
      const result = await this._executeCycle(cycle_id, context, systemPrompt);
      await this.audit.log({
        cycle_id,
        event_type: 'cycle_complete',
        signals_count: result.decisions.filter((d) => d.allowed).length,
        llm_text: result.llm_text,
      });
      return result;
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      await this.audit.log({ cycle_id, event_type: 'cycle_fail', error });
      throw err;
    }
  }

  /**
   * Executes a single governed LLM turn: build system prompt (decision prompt + tool schema
   * from a single hoisted getProviderTools call) → llm.complete → parseToolCalls (with
   * parse_miss audit) → _validateToolCalls → _executeToolCalls → audit the turn.
   *
   * When source === 'chat', emits a 'chat_turn' audit entry so interactive turns are
   * distinguishable from scheduled cycles. When source === 'cycle', skips the chat_turn
   * audit (the caller owns cycle_start/cycle_complete).
   */
  async runGovernedTurn(input: GovernedTurnInput): Promise<GovernedTurnResult> {
    const cycle_id = input.cycle_id ?? randomUUID();

    // ── Hoist getProviderTools ONCE — shared between schema injection and validation ──
    const providerTools = await this.plugins.getProviderTools();

    // ── Kernel tool injection gating (reflection-gated; inert in s1) ─────────────
    // GovernedTurnInput.source union is 'chat'|'cycle'|'pretest' in s1 — 'reflection' is not
    // reachable. The condition is written now so s2 (adding 'reflection' to the union +
    // runReflectionTurn) requires zero changes here.
    const kernelTools =
      (input.source as string) === 'reflection'
        ? [
            KERNEL_WRITE_SKILL_TOOL,
            KERNEL_CREATE_PRETEST_VARIANT_TOOL,
            KERNEL_RUN_PRETEST_COMPARE_TOOL,
          ]
        : [];
    const effectiveTools = [...providerTools, ...kernelTools];

    const decisionPrompt = await this.plugins.getActiveDecisionPrompt();

    let builtSystemPrompt = input.system_prompt ?? '';
    if (decisionPrompt !== null) {
      const toolSchemaJson = JSON.stringify(effectiveTools);
      if (toolSchemaJson.length > 8000) {
        this.log.warn(
          `token-budget guard: injected tool schema is ${toolSchemaJson.length} chars — consider reducing active tools`,
        );
      }
      const parts: string[] = [`[DECISION]\n${decisionPrompt}`, `[TOOL SCHEMA]\n${toolSchemaJson}`];
      if (builtSystemPrompt) parts.push(builtSystemPrompt);
      builtSystemPrompt = parts.join('\n\n');
    }

    // ── LLM call ─────────────────────────────────────────────────────────────
    const llmResponse = await this.llm.complete({
      context: input.context,
      system_prompt: builtSystemPrompt || undefined,
    });

    // ── Parse tool_calls with parse_miss audit ────────────────────────────────
    const auditFn = (raw: string): void => {
      void this.audit.log({
        cycle_id,
        event_type: 'parse_miss',
        meta: { raw_block: raw.slice(0, 500) },
      });
    };
    llmResponse.tool_calls = parseToolCalls(llmResponse.text, auditFn);

    const skills_read = llmResponse.skills_read ?? [];
    const skills_written = llmResponse.skills_written ?? [];

    // ── Validate and dispatch ─────────────────────────────────────────────────
    // Pass effectiveTools (providerTools + kernelTools) so _validateToolCalls can find kernel tools.
    // Pass source so the kernel tool source gate is enforced (only 'reflection' allows kernel tools).
    const validatedCalls = await this._validateToolCalls(
      cycle_id,
      llmResponse.tool_calls,
      effectiveTools,
      input._activePlugins,
      input.virtual_only,
      input.source,
    );
    const { decisions, sandbox_results, signalsEmitted } = await this._executeToolCalls(
      cycle_id,
      validatedCalls,
    );

    // ── Audit the turn ────────────────────────────────────────────────────────
    if (input.source === 'chat') {
      await this.audit.log({
        cycle_id,
        event_type: 'chat_turn',
        llm_text: llmResponse.text?.slice(0, 2000),
        skills_read,
        skills_written,
        signals_count: validatedCalls.length,
        meta: {
          tools_called: validatedCalls.map((t) => `${t.plugin_id}.${t.function}`),
        },
      });
    } else if (input.source === 'pretest') {
      // Pretest virtual evaluation — mirrors chat_turn with pretest_turn event type.
      await this.audit.log({
        cycle_id,
        event_type: 'pretest_turn',
        llm_text: llmResponse.text?.slice(0, 2000),
        skills_read,
        skills_written,
        signals_count: validatedCalls.length,
        meta: {
          tools_called: validatedCalls.map((t) => `${t.plugin_id}.${t.function}`),
          virtual_only: input.virtual_only ?? false,
        },
      });
    } else if (input.source === 'cycle') {
      // Cycle owns its own audit — nothing to emit here.
    } else if (input.source === 'reflection') {
      // Reflection turn audit is owned by runReflectionTurn (emits 'reflection_turn' event).
      // runGovernedTurn intentionally emits nothing for reflection turns.
    } else {
      this.log.warn(
        `runGovernedTurn: unknown source discriminator '${String(input.source)}' — skipping audit`,
      );
    }

    return {
      cycle_id,
      text: llmResponse.text,
      tool_calls: validatedCalls,
      decisions,
      sandbox_results,
      backend: llmResponse.backend ?? 'api',
      skills_read,
      skills_written,
      llm_response: llmResponse,
      signalsEmitted,
    };
  }

  private async _executeCycle(
    cycle_id: string,
    context: string,
    systemPrompt?: string,
  ): Promise<AgentCycleResult> {
    // ── 1. Inyectar memoria inter-ciclos ──────────────────────────────────────
    const memContext = await this.memory.toContextString();
    const enrichedContext = memContext
      ? `${memContext}\n\n[CONTEXTO DEL CICLO ACTUAL]\n${context}`
      : context;

    // ── 2. Ejecutar hooks on_cycle de plugins activos ─────────────────────────
    const activePlugins = await this.plugins.findActive();
    const activeIds = activePlugins.map((p: HydratedPlugin) => p.id);

    const cycleCtx: Record<string, unknown> = { cycle_id };
    const hookResult = await this.sandbox.runCycle(activeIds, cycleCtx);
    const hookCtx = (hookResult.result ?? cycleCtx) as Record<string, unknown>;
    const pendingSignals: unknown[] = Array.isArray(hookCtx['pending_signals'])
      ? (hookCtx['pending_signals'] as unknown[])
      : [];

    await this._persistPluginAlerts(hookCtx, cycle_id);

    if (pendingSignals.length > 0) {
      await this.audit.log({
        cycle_id,
        event_type: 'signal',
        signals_count: pendingSignals.length,
        meta: { stage: 'pre_veto', signals: pendingSignals },
      });
    }

    // ── 3. Capa de veto: discipline plugins ───────────────────────────────────
    const disciplinePlugins = activePlugins.filter((p: HydratedPlugin) => p.type === 'discipline');
    const { vetoCtx, vetoSummary } = await this._runVetoLayer(
      cycle_id,
      disciplinePlugins,
      hookCtx,
      pendingSignals,
    );

    // ── 3b. PRE-stage extra plugins (before LLM turn) ─────────────────────────
    const extraPlugins = activePlugins.filter((p: HydratedPlugin) => p.type === 'extra');
    const preExtras = extraPlugins.filter(
      (p: HydratedPlugin) => this.sandbox.getPluginStage(p.id) === 'pre',
    );
    const postExtras = extraPlugins.filter(
      (p: HydratedPlugin) => this.sandbox.getPluginStage(p.id) !== 'pre',
    );

    const initialCtx: Record<string, unknown> = { ...vetoCtx, active_plugin_ids: activeIds };
    const preResult = await this._runPreExtras(preExtras, initialCtx, cycle_id);
    if (preResult.aborted) {
      // Dispatch any notify_intents collected before abort (safe: intents are already in abortResult ctx)
      await this._persistNotificationIntents(initialCtx, cycle_id);
      return {
        ...preResult.abortResult,
        context_injected: !!memContext,
        veto_summary: vetoSummary,
      };
    }
    const runningCtx = preResult.ctx;

    // ── 4+5+6. Governed LLM turn (decision prompt + schema injection, llm.complete,
    //            parseToolCalls, _validateToolCalls, _executeToolCalls) ─────────
    // Build signal summary from approved signals after veto, prepend to context.
    const approvedSignals: unknown[] = Array.isArray(runningCtx['pending_signals'])
      ? (runningCtx['pending_signals'] as unknown[])
      : [];

    const signalSummary =
      approvedSignals.length > 0
        ? `\n\n[SEÑALES APROBADAS POR LAS DISCIPLINAS]\n${JSON.stringify(approvedSignals, null, 2)}\n`
        : '\n\n[NO HAY SEÑALES APROBADAS EN ESTE CICLO]\n';

    const turnResult = await this.runGovernedTurn({
      source: 'cycle',
      context: enrichedContext + signalSummary,
      system_prompt: systemPrompt,
      cycle_id,
      _activePlugins: activePlugins,
    });

    const {
      decisions,
      sandbox_results,
      llm_response: llmResponse,
      skills_read,
      signalsEmitted,
    } = turnResult;

    // ── 3c. POST-stage extra plugins (after LLM turn) ─────────────────────────
    const postFinalCtx = await this._runPostExtras(postExtras, runningCtx, cycle_id);

    // ── 3d. Dispatch accumulated notify_intents (PR B) ───────────────────────
    await this._persistNotificationIntents(postFinalCtx, cycle_id);

    // ── Persistir en memoria inter-ciclos ─────────────────────────────────────

    await this.memory.appendObservation({
      cycle_id,
      text: llmResponse.text?.slice(0, 500) ?? '',
      signals_count: signalsEmitted.length,
      skills_read,
    });

    for (const sig of signalsEmitted) {
      await this.memory.trackSignal(sig.symbol, sig.action);
    }

    return {
      cycle_id,
      llm_text: llmResponse.text,
      decisions,
      sandbox_results,
      llm_response: llmResponse,
      context_injected: !!memContext,
      veto_summary: vetoSummary,
    };
  }

  /**
   * Merges extra hook output additively into the running cycle context.
   *
   * PROTECTED_KEYS: never overwritten — extras must not influence the veto-approved
   * trade-decision state or inject credentials/decisions into subsequent extras.
   *   - pending_signals  : veto-approved signals; extras must not tamper
   *   - credentials      : kernel-injected secrets; must not bleed across extras
   *   - tool_calls       : LLM-decided calls; extras must not inject fake calls
   *   - decisions        : validated decisions; extras must not override
   *   - veto_reasons     : discipline layer output; extras must not alter
   *
   * SKIP_KEYS: handled specially outside this merge.
   *   - notify_intents   : accumulated into _collected_notify_intents, not shallow-merged
   *   - cycle_abort      : handled before merge is called
   *   - cycle_abort_reason
   */
  private _mergeExtraCtx(
    base: Record<string, unknown>,
    extra: Record<string, unknown>,
  ): Record<string, unknown> {
    const PROTECTED_KEYS = new Set([
      'pending_signals',
      'credentials',
      'tool_calls',
      'decisions',
      'veto_reasons',
    ]);
    const SKIP_KEYS = new Set(['notify_intents', 'cycle_abort', 'cycle_abort_reason']);
    const merged: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(extra)) {
      if (PROTECTED_KEYS.has(k)) continue;
      if (SKIP_KEYS.has(k)) continue;
      if (k === 'log' && Array.isArray(base['log']) && Array.isArray(v)) {
        merged['log'] = [...(base['log'] as unknown[]), ...(v as unknown[])];
      } else {
        merged[k] = v;
      }
    }
    return merged;
  }

  /**
   * Runs all PRE-stage extra plugins sequentially.
   * Returns the merged context and an abort indicator.
   * If any PRE extra returns cycle_abort=true, emits the audit event and returns aborted:true.
   */
  private async _runPreExtras(
    preExtras: HydratedPlugin[],
    initialCtx: Record<string, unknown>,
    cycle_id: string,
  ): Promise<
    | { aborted: false; ctx: Record<string, unknown> }
    | {
        aborted: true;
        abortResult: Omit<AgentCycleResult, 'context_injected' | 'veto_summary'>;
      }
  > {
    let ctx: Record<string, unknown> = initialCtx;
    for (const extra of preExtras) {
      const res = await this.sandbox.runExtraCycleHook(extra.id, ctx);
      const extraCtx = res.ok && res.result ? (res.result as Record<string, unknown>) : {};
      await this._persistPluginAlerts(extraCtx, cycle_id);
      ctx = this._mergeExtraCtx(ctx, extraCtx);
      this._logNotifyIntents(extra.id, extraCtx, ctx);
      if (extraCtx['cycle_abort'] === true) {
        await this.audit.log({
          cycle_id,
          event_type: 'cycle_aborted',
          plugin_id: extra.id,
          meta: { plugin_id: extra.id, reason: extraCtx['cycle_abort_reason'] ?? 'cycle_abort' },
        });
        return {
          aborted: true,
          abortResult: {
            cycle_id,
            llm_text: '',
            decisions: [],
            sandbox_results: [],
            llm_response: {
              text: '',
              tool_calls: [],
              backend: 'api',
              skills_read: [],
              skills_written: [],
            },
            aborted: true,
          },
        };
      }
    }
    return { aborted: false, ctx };
  }

  /**
   * Runs all POST-stage extra plugins sequentially.
   * Enriches context with equity_curve from SnapshotService (degrades gracefully if absent).
   * cycle_abort from POST extras is ignored (warn only).
   * Returns the final merged context (includes _collected_notify_intents for PR B consumption).
   */
  private async _runPostExtras(
    postExtras: HydratedPlugin[],
    baseCtx: Record<string, unknown>,
    cycle_id: string,
  ): Promise<Record<string, unknown>> {
    let postCtx: Record<string, unknown> = { ...baseCtx };
    // Inject cycle signals so POST policy plugins (e.g. telegram-notifier) can filter them.
    // Source: post-veto pending_signals (approved signals that carry confidence).
    postCtx['signals'] = Array.isArray(baseCtx['pending_signals'])
      ? baseCtx['pending_signals']
      : [];
    try {
      if (this.snapshot) {
        const equityCurveRaw = await this.snapshot.getEquityCurve(50);
        postCtx['equity_curve'] = equityCurveRaw.map((e) => e.equity);
      }
    } catch (err: unknown) {
      this.log.warn(`POST enrichment: getEquityCurve failed — ${String(err)}`);
    }
    for (const extra of postExtras) {
      const res = await this.sandbox.runExtraCycleHook(extra.id, postCtx);
      const extraCtx = res.ok && res.result ? (res.result as Record<string, unknown>) : {};
      if (extraCtx['cycle_abort'] === true) {
        this.log.warn(
          `POST-stage extra '${extra.id}' returned cycle_abort=true — ignored (only PRE-stage can abort)`,
        );
      }
      await this._persistPluginAlerts(extraCtx, cycle_id);
      postCtx = this._mergeExtraCtx(postCtx, extraCtx);
      this._logNotifyIntents(extra.id, extraCtx, postCtx);
    }
    return postCtx;
  }

  /**
   * Logs received notify_intents and accumulates them into runningCtx._collected_notify_intents
   * so PR B has a single consumption point.
   */
  private _logNotifyIntents(
    pluginId: string,
    extraCtx: Record<string, unknown>,
    runningCtx: Record<string, unknown>,
  ): void {
    const intents = extraCtx['notify_intents'];
    if (Array.isArray(intents) && intents.length > 0) {
      this.log.debug(
        `[extra:${pluginId}] ${String(intents.length)} notify_intent(s) received — dispatch pending PR B`,
      );
      const existing = runningCtx['_collected_notify_intents'];
      const existingArr = Array.isArray(existing) ? (existing as unknown[]) : [];
      runningCtx['_collected_notify_intents'] = [...existingArr, ...(intents as unknown[])];
    }
  }

  private async _runVetoLayer(
    cycle_id: string,
    disciplinePlugins: HydratedPlugin[],
    hookCtx: Record<string, unknown>,
    pendingSignals: unknown[],
  ): Promise<{ vetoCtx: Record<string, unknown>; vetoSummary: VetoSummary }> {
    let vetoCtx: Record<string, unknown> = { ...hookCtx, pending_signals: pendingSignals };
    const vetoReasons: string[] = [];

    for (const disc of disciplinePlugins) {
      const discResult = await this.sandbox.call({
        cmd: 'run_hook',
        plugin_id: disc.id,
        hook: 'on_cycle',
        context: vetoCtx,
      });

      if (discResult.ok && discResult.result) {
        const updated = discResult.result as Record<string, unknown>;
        vetoCtx = updated;
        const reasons = (updated['veto_reasons'] as string[] | undefined) ?? [];
        vetoReasons.push(...reasons.map((r) => `[${disc.name}] ${r}`));
        await this._persistPluginAlerts(updated, cycle_id);
      } else if (!discResult.ok) {
        this.log.warn(`Discipline ${disc.id} hook falló: ${discResult.error}`);
        await this.audit.log({
          cycle_id,
          event_type: 'cycle_fail',
          plugin_id: disc.id,
          error: discResult.error,
          meta: { stage: 'veto_hook' },
        });
      }
    }

    const approvedSignals: unknown[] = Array.isArray(vetoCtx['pending_signals'])
      ? (vetoCtx['pending_signals'] as unknown[])
      : [];

    const vetoSummary: VetoSummary = {
      signals_proposed: pendingSignals.length,
      signals_approved: approvedSignals.length,
      signals_vetoed: pendingSignals.length - approvedSignals.length,
      veto_reasons: vetoReasons,
      discipline_plugins: disciplinePlugins.map((p: HydratedPlugin) => p.id),
    };

    if (vetoSummary.signals_vetoed > 0) {
      await this.audit.log({
        cycle_id,
        event_type: 'decision',
        signals_count: vetoSummary.signals_vetoed,
        meta: { stage: 'veto', veto_summary: vetoSummary },
      });
    }

    return { vetoCtx, vetoSummary };
  }

  /**
   * Resolves the drop reason for a single tool call given validation context.
   * Returns null when the call is valid (should proceed to dispatch).
   * Pure/sync — extracted to keep _validateToolCalls within complexity budget.
   */
  private _resolveDropReason(
    call: import('../llm/llm.service').ToolCallRequest,
    activePlugins: HydratedPlugin[],
    activeIds: Set<string>,
    validToolNames: Set<string>,
    providerTools: import('../plugins/plugins.service').ProviderTool[],
    virtual_only: boolean,
    allowKernelTools: boolean,
  ): string | null {
    // FIRST: kernel namespace — validate against kernel registry, then enforce source gate.
    // This check must come BEFORE virtual_only and plugin-active checks.
    if (call.plugin_id === 'kernel') {
      if (!KERNEL_TOOL_REGISTRY.has(call.function)) return 'unknown_kernel_tool';
      // Source gate: kernel tools are only executable in reflection turns.
      // In s1, 'reflection' is not in GovernedTurnInput.source union — so kernel tools
      // are NEVER reachable in production turns. allowKernelTools=false drops any
      // LLM-emitted kernel call with a distinct, auditable reason.
      if (!allowKernelTools) return 'kernel_source_not_allowed';
      return null;
    }

    // SECOND: virtual_only guard — drop provider tool-calls before any other check.
    if (virtual_only) {
      const plugin = activePlugins.find((p) => p.id === call.plugin_id);
      if (plugin?.type === 'provider') return 'virtual_mode_provider_blocked';
    }
    // Active/declared checks.
    if (!activeIds.has(call.plugin_id)) {
      const isKnown = providerTools.some((t) => t.plugin_id === call.plugin_id);
      return isKnown ? 'plugin_inactive' : 'plugin_not_found';
    }
    if (!validToolNames.has(`${call.plugin_id}__${call.function}`)) {
      return 'function_not_declared';
    }
    return null;
  }

  /**
   * Validates parsed tool_calls against active plugin manifests.
   * Drops calls whose plugin is not active or whose function is not declared in tools.json.
   * Each dropped call is audited with event_type 'tool_call_dropped' and a specific reason.
   * Returns only valid calls. Never throws.
   *
   * @param preloadedActivePlugins - When provided (cycle path), skips the findActive() DB call.
   * @param virtual_only - When true, drops provider-type plugin calls before dispatch (pretest).
   */
  private async _validateToolCalls(
    cycle_id: string,
    calls: import('../llm/llm.service').ToolCallRequest[],
    hoistedTools?: import('../plugins/plugins.service').ProviderTool[],
    preloadedActivePlugins?: import('../plugins/plugins.service').HydratedPlugin[],
    virtual_only?: boolean,
    source?: string,
  ): Promise<import('../llm/llm.service').ToolCallRequest[]> {
    if (calls.length === 0) return [];

    // Kernel tools are only permitted in reflection turns.
    const allowKernelTools = source === 'reflection';

    try {
      // Use pre-fetched plugins when available (cycle path) to avoid a second DB round-trip.
      const activePlugins = preloadedActivePlugins ?? (await this.plugins.findActive());
      const activeIds = new Set(activePlugins.map((p: HydratedPlugin) => p.id));
      // Use hoisted tools when provided (from _executeCycle) to avoid a second DB round-trip.
      const providerTools = hoistedTools ?? (await this.plugins.getProviderTools());
      const validToolNames = new Set(providerTools.map((t) => t.name)); // "pluginId__fn"

      const valid: import('../llm/llm.service').ToolCallRequest[] = [];

      for (const call of calls) {
        const reason = this._resolveDropReason(
          call,
          activePlugins,
          activeIds,
          validToolNames,
          providerTools,
          virtual_only ?? false,
          allowKernelTools,
        );

        if (reason) {
          await this.audit.log({
            cycle_id,
            event_type: 'tool_call_dropped',
            plugin_id: call.plugin_id,
            meta: { function: call.function, reason, args: call.args },
          });
        } else {
          valid.push(call);
        }
      }

      return valid;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`_validateToolCalls error — dropping all calls: ${msg}`);
      await this.audit.log({
        cycle_id,
        event_type: 'cycle_fail',
        error: msg,
        meta: { stage: '_validateToolCalls' },
      });
      return [];
    }
  }

  /**
   * Dispatches a kernel-namespace tool call (plugin_id === 'kernel').
   * Routes to the appropriate PluginsService/PretestService method without entering the sandbox.
   */
  private async _dispatchKernelTool(
    cycle_id: string,
    tc: import('../llm/llm.service').ToolCallRequest,
    decisions: Decision[],
    sandbox_results: SandboxResult[],
  ): Promise<void> {
    if (tc.function === 'write_skill') {
      await this._kernelWriteSkill(cycle_id, tc, decisions, sandbox_results);
    } else if (tc.function === 'create_pretest_variant') {
      await this._kernelCreatePretestVariant(cycle_id, tc, decisions, sandbox_results);
    } else if (tc.function === 'run_pretest_compare') {
      await this._kernelRunPretestCompare(cycle_id, tc, decisions, sandbox_results);
    } else {
      this.log.warn(`_dispatchKernelTool: unknown kernel function '${tc.function}' — dropped`);
      decisions.push({ ...tc, allowed: false, reason: 'unknown_kernel_tool' });
    }
  }

  /** Handles kernel__write_skill dispatch. */
  private async _kernelWriteSkill(
    _cycle_id: string,
    tc: import('../llm/llm.service').ToolCallRequest,
    decisions: Decision[],
    sandbox_results: SandboxResult[],
  ): Promise<void> {
    const skill = typeof tc.args['skill'] === 'string' ? tc.args['skill'] : '';
    const newBody = typeof tc.args['new_body'] === 'string' ? tc.args['new_body'] : '';
    const result = await this.plugins.writeSkillGuarded(skill, newBody);
    decisions.push({
      ...tc,
      allowed: result.ok,
      reason: result.ok ? undefined : result.reason,
    });
    sandbox_results.push({
      plugin_id: 'kernel',
      function: 'write_skill',
      ok: result.ok,
      result,
    });
  }

  /** Handles kernel__create_pretest_variant dispatch. */
  private async _kernelCreatePretestVariant(
    cycle_id: string,
    tc: import('../llm/llm.service').ToolCallRequest,
    decisions: Decision[],
    sandbox_results: SandboxResult[],
  ): Promise<void> {
    if (!this.pretest) {
      decisions.push({ ...tc, allowed: false, reason: 'pretest_unavailable' });
      sandbox_results.push({
        plugin_id: 'kernel',
        function: tc.function,
        ok: false,
        error: 'pretest_unavailable',
      });
      return;
    }

    // Coerce args
    const name = typeof tc.args['name'] === 'string' ? tc.args['name'] : '';
    const rawIds = tc.args['plugin_ids'];
    const plugin_ids = Array.isArray(rawIds)
      ? (rawIds as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    const rawConfigs = tc.args['plugin_configs'];
    const plugin_configs =
      rawConfigs !== null && typeof rawConfigs === 'object' && !Array.isArray(rawConfigs)
        ? (rawConfigs as Record<string, Record<string, unknown>>)
        : undefined;

    // Validate minimally: name non-empty AND plugin_ids has at least one entry
    if (!name || plugin_ids.length === 0) {
      decisions.push({ ...tc, allowed: false, reason: 'invalid_variant_args' });
      sandbox_results.push({
        plugin_id: 'kernel',
        function: tc.function,
        ok: false,
        error: 'invalid_variant_args',
      });
      return;
    }

    // Cap check
    const existing = await this.pretest.findAll();
    if (existing.length >= MAX_PRETEST_VARIANTS) {
      await this.audit.log({
        cycle_id,
        event_type: 'pretest_cap_reached',
        meta: { count: existing.length, cap: MAX_PRETEST_VARIANTS },
      });
      decisions.push({ ...tc, allowed: false, reason: 'pretest_cap_reached' });
      sandbox_results.push({
        plugin_id: 'kernel',
        function: tc.function,
        ok: false,
        error: 'pretest_cap_reached',
      });
      return;
    }

    // Create
    const pf = await this.pretest.create({ name, plugin_ids, plugin_configs });
    await this.audit.log({
      cycle_id,
      event_type: 'pretest_variant_created',
      meta: { pretest_id: pf.id, name, plugin_ids },
    });
    decisions.push({ ...tc, allowed: true });
    sandbox_results.push({
      plugin_id: 'kernel',
      function: tc.function,
      ok: true,
      result: { id: pf.id, name: pf.name },
    });
  }

  /** Handles kernel__run_pretest_compare dispatch. Compare-only (ADR-3): never calls runAllActive. */
  private async _kernelRunPretestCompare(
    cycle_id: string,
    tc: import('../llm/llm.service').ToolCallRequest,
    decisions: Decision[],
    sandbox_results: SandboxResult[],
  ): Promise<void> {
    if (!this.pretest) {
      decisions.push({ ...tc, allowed: false, reason: 'pretest_unavailable' });
      sandbox_results.push({
        plugin_id: 'kernel',
        function: tc.function,
        ok: false,
        error: 'pretest_unavailable',
      });
      return;
    }

    // Compare-only: reads current stored portfolio states.
    // ADR-3: no runAllActive() — avoids N recursive LLM pretest turns mid-reflection.
    const cmp = await this.pretest.compare();
    await this.audit.log({
      cycle_id,
      event_type: 'pretest_compared',
      meta: {
        winner_by_return: cmp.winner_by_return,
        winner_by_risk_adj: cmp.winner_by_risk_adj,
        n: cmp.portfolios.length,
      },
    });
    decisions.push({ ...tc, allowed: true });
    sandbox_results.push({
      plugin_id: 'kernel',
      function: tc.function,
      ok: true,
      result: {
        winner_by_return: cmp.winner_by_return,
        winner_by_risk_adj: cmp.winner_by_risk_adj,
        portfolios: cmp.portfolios.map((p) => ({
          name: p.name,
          return_pct: p.return_pct,
          gate_status: p.gate_status,
        })),
      },
    });
  }

  private async _executeToolCalls(
    cycle_id: string,
    toolCalls: import('../llm/llm.service').ToolCallRequest[],
  ): Promise<{
    decisions: Decision[];
    sandbox_results: SandboxResult[];
    signalsEmitted: { symbol: string; action: string }[];
  }> {
    const decisions: Decision[] = [];
    const sandbox_results: SandboxResult[] = [];
    const signalsEmitted: { symbol: string; action: string }[] = [];

    for (const tc of toolCalls) {
      try {
        // Pre-step: kernel tools bypass the sandbox entirely.
        if (tc.plugin_id === 'kernel') {
          await this._dispatchKernelTool(cycle_id, tc, decisions, sandbox_results);
          continue;
        }

        decisions.push({ ...tc, allowed: true });
        const res = await this.sandbox.callPlugin(tc.plugin_id, tc.function, tc.args);
        sandbox_results.push({ plugin_id: tc.plugin_id, function: tc.function, ...res });

        const args = tc.args;
        if (typeof args['symbol'] === 'string' && typeof args['action'] === 'string') {
          const symbol = args['symbol'];
          const action = args['action'];
          signalsEmitted.push({ symbol, action });
          await this.audit.log({
            cycle_id,
            event_type: 'signal',
            plugin_id: tc.plugin_id,
            symbol,
            action,
            sandbox_ok: res.ok,
          });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        decisions.push({ ...tc, allowed: false, reason: msg });
        this.log.warn(`Tool call falló: ${tc.plugin_id}.${tc.function} — ${msg}`);
        await this.audit.log({
          cycle_id,
          event_type: 'cycle_fail',
          plugin_id: tc.plugin_id,
          error: msg,
          meta: { function: tc.function },
        });
      }
    }

    return { decisions, sandbox_results, signalsEmitted };
  }

  /**
   * Dispatches all accumulated notify_intents via NotifierBridge.
   *
   * Reads ctx['_collected_notify_intents'] (array of {channel, text, parse_mode?})
   * and calls bridge.send once per intent. Emits a 'notification_sent' audit event
   * per dispatch. Never throws — any bridge error is caught and audited.
   *
   * Mirrors _persistPluginAlerts pattern: collect-then-act, no inline side effects.
   */
  private async _persistNotificationIntents(
    ctx: Record<string, unknown>,
    cycle_id: string,
  ): Promise<void> {
    if (!this.notifierBridge) return;
    const raw = ctx['_collected_notify_intents'];
    if (!Array.isArray(raw) || raw.length === 0) return;

    for (const item of raw) {
      const intent = item as Record<string, unknown>;
      const channel = (intent['channel'] as string | undefined) ?? 'telegram';
      const text = (intent['text'] as string | undefined) ?? '';
      const parseMode = intent['parse_mode'] as 'Markdown' | 'HTML' | undefined;

      let ok = false;
      try {
        const result = await this.notifierBridge.send(channel, text, { parse_mode: parseMode });
        ok = result.ok;
      } catch (err: unknown) {
        this.log.warn(`_persistNotificationIntents: bridge.send threw — ${String(err)}`);
      }

      try {
        await this.audit.log({
          cycle_id,
          event_type: 'notification_sent',
          meta: { channel, ok },
        });
      } catch (err: unknown) {
        this.log.warn(`_persistNotificationIntents: audit.log threw — ${String(err)}`);
      }
    }
  }

  // ── F4-S2: Reflection Turn ────────────────────────────────────────────────────

  /**
   * Assembles a bounded outcome context string for the reflection turn.
   * Hard budget: 4,000 chars total. Four labeled sections, each try/catch → '(unavailable)'.
   * Per-section caps + global slice are BOTH enforced (defense in depth).
   *
   * Sections:
   *   AUDIT  — recent cycle/signal/skill audit one-liners    (~1200 chars cap)
   *   EQUITY — last-20 equity data points, comma-joined      (~400 chars cap)
   *   VETO   — recent veto summary from audit decision meta  (~800 chars cap)
   *   PRETEST— compare() top-5 portfolios + winners         (~1200 chars cap)
   */
  /** Parses a single audit decision entry's meta JSON to extract a veto summary line. */
  private _parseVetoLine(metaJson: string): string | null {
    try {
      const meta = JSON.parse(metaJson) as Record<string, unknown>;
      const vs = meta['veto_summary'] as Record<string, unknown> | undefined;
      if (!vs) return null;
      const proposed = String((vs['signals_proposed'] as number | undefined) ?? 0);
      const approved = String((vs['signals_approved'] as number | undefined) ?? 0);
      const vetoed = String((vs['signals_vetoed'] as number | undefined) ?? 0);
      const reasons = Array.isArray(vs['veto_reasons'])
        ? (vs['veto_reasons'] as string[]).slice(0, 3).join('; ')
        : '';
      const reasonsPart = reasons ? ' reasons:' + reasons : '';
      return `proposed:${proposed} approved:${approved} vetoed:${vetoed}${reasonsPart}`;
    } catch {
      return null;
    }
  }

  private async _assembleReflectionContext(): Promise<string> {
    const BUDGET = 4000;
    const AUDIT_CAP = 1200;
    const EQUITY_CAP = 400;
    const VETO_CAP = 800;
    const PRETEST_CAP = 1200;

    // Single audit query (limit 20) shared by AUDIT and VETO sections — avoids two DB calls.
    type AuditEntry = {
      event_type: string;
      symbol?: string | null;
      action?: string | null;
      meta?: string | null;
    };
    let auditEntries: AuditEntry[] = [];
    let auditQueryFailed = false;
    try {
      auditEntries = await this.audit.query({ limit: 20 });
    } catch {
      auditQueryFailed = true;
    }

    // Section: AUDIT
    let auditSection = '(unavailable)';
    if (!auditQueryFailed) {
      try {
        const relevantTypes = new Set([
          'signal',
          'decision',
          'cycle_complete',
          'skill_written',
          'reflection_turn',
        ]);
        const lines = auditEntries
          .filter((e) => relevantTypes.has(e.event_type))
          .map((e) => `${e.event_type} ${e.symbol ?? ''} ${e.action ?? ''}`.trim());
        auditSection = lines.join('\n').slice(0, AUDIT_CAP);
      } catch {
        auditSection = '(unavailable)';
      }
    }

    // Section: EQUITY
    let equitySection = '(unavailable)';
    try {
      if (this.snapshot) {
        const curve = await this.snapshot.getEquityCurve(20);
        equitySection = curve
          .map((e) => String(e.equity))
          .join(',')
          .slice(0, EQUITY_CAP);
      }
    } catch {
      equitySection = '(unavailable)';
    }

    // Section: VETO — derived from the same auditEntries fetched above (no second query).
    let vetoSection = '(unavailable)';
    if (!auditQueryFailed) {
      try {
        const vetoEntries = auditEntries.filter((e) => e.event_type === 'decision');
        const vetoLines = vetoEntries
          .map((e) => (e.meta ? this._parseVetoLine(e.meta) : null))
          .filter((l): l is string => l !== null);
        vetoSection = (vetoLines.length > 0 ? vetoLines.join('\n') : '(none)').slice(0, VETO_CAP);
      } catch {
        vetoSection = '(unavailable)';
      }
    }

    // Section: PRETEST
    let pretestSection = '(unavailable)';
    try {
      if (this.pretest) {
        const cmp = await this.pretest.compare();
        const top5 = cmp.portfolios.slice(0, 5);
        const portfolioLines = top5
          .map((p) => {
            const ret =
              typeof p.return_pct === 'number' ? p.return_pct.toFixed(2) : String(p.return_pct);
            return `${p.name}: return=${ret}% gate=${String(p.gate_status)}`;
          })
          .join('\n');
        const header = `winner_return:${cmp.winner_by_return} winner_risk_adj:${cmp.winner_by_risk_adj}`;
        pretestSection = (header + '\n' + portfolioLines).slice(0, PRETEST_CAP);
      }
    } catch {
      pretestSection = '(unavailable)';
    }

    const assembled = [
      `[AUDIT RECENT]\n${auditSection}`,
      `[EQUITY CURVE]\n${equitySection}`,
      `[VETO SUMMARY]\n${vetoSection}`,
      `[PRETEST COMPARE]\n${pretestSection}`,
    ].join('\n\n');

    // Hard global budget slice (defense in depth after per-section caps)
    return assembled.slice(0, BUDGET);
  }

  /**
   * Executes a reflection turn:
   * 1. Check cycle-in-progress guard.
   * 2. Resolve active reflection-policy plugin prompt.
   * 3. Assemble bounded context.
   * 4. runGovernedTurn({source:'reflection'}).
   * 5. Emit reflection_turn audit.
   * 6. Return ReflectionTurnResult.
   */
  async runReflectionTurn(cycleId?: string): Promise<ReflectionTurnResult> {
    // Policy plugin check: reflection is a no-op without an active reflection plugin.
    // Concurrency guard is held by PanelService.reflectNow (all callers go through it).
    const reflectionPrompt = await this.plugins.getActiveReflectionPrompt();
    if (!reflectionPrompt) {
      return { skipped: true, reason: 'no_reflection_plugin' };
    }

    // Assemble bounded context.
    const ctx = await this._assembleReflectionContext();

    // Run the governed turn with source:'reflection' (kernel__write_skill is now injectable).
    const turnResult = await this.runGovernedTurn({
      source: 'reflection',
      context: ctx,
      system_prompt: reflectionPrompt,
      cycle_id: cycleId,
    });

    // Audit the reflection turn (runGovernedTurn intentionally emits nothing for 'reflection').
    const toolCallsExecuted = turnResult.tool_calls.length;
    await this.audit.log({
      cycle_id: turnResult.cycle_id,
      event_type: 'reflection_turn',
      llm_text: turnResult.text?.slice(0, 2000),
      skills_written: turnResult.skills_written,
      meta: {
        ctx_len: ctx.length,
        toolCallsExecuted,
        tools_called: turnResult.tool_calls.map((t) => `${t.plugin_id}.${t.function}`),
      },
    });

    return {
      skipped: false,
      cycle_id: turnResult.cycle_id,
      skills_written: turnResult.skills_written.length,
    };
  }

  /**
   * Persiste las alertas emitidas por un plugin en el contexto del ciclo.
   * El plugin debe incluir `emit_alerts: [{type, severity, message, symbol?, meta?}]`.
   */
  private async _persistPluginAlerts(
    ctx: Record<string, unknown>,
    cycle_id: string,
  ): Promise<void> {
    const raw = ctx['emit_alerts'];
    if (!Array.isArray(raw) || raw.length === 0) return;

    const dtos: CreateAlertDto[] = raw
      .filter((a) => a && typeof a === 'object')
      .map((a) => {
        const alert = a as Record<string, unknown>;
        return {
          type: (alert['type'] as CreateAlertDto['type']) ?? 'CUSTOM',
          severity: (alert['severity'] as CreateAlertDto['severity']) ?? 'MEDIUM',
          symbol: (alert['symbol'] as string | undefined) ?? null,
          message: typeof alert['message'] === 'string' ? alert['message'] : 'Alerta sin mensaje',
          meta: { ...(alert['meta'] as Record<string, unknown> | undefined), cycle_id },
        };
      });

    if (dtos.length > 0) {
      await this.alerts.createBulk(dtos);
      this.log.log(`${dtos.length} alerta(s) emitida(s) por plugin en ciclo ${cycle_id}`);
    }
  }
}
