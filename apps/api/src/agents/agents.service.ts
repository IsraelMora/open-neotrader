import {
  Injectable,
  Logger,
  Optional,
  Inject,
  forwardRef,
  NotFoundException,
} from '@nestjs/common';
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
import { KvService } from '../common/kv.service';
import { LongTermMemoryService } from '../long-term-memory/long-term-memory.service';
import { DebateService } from './debate.service';
import { ProviderGatewayService } from '../providers/provider-gateway.service';
import {
  MlSignalRecordService,
  SkillContribution,
} from '../ml-signal-record/ml-signal-record.service';
import { TradeIntentService } from '../trade-intent/trade-intent.service';

import type { LlmResponse } from '../llm/llm.service';
import type { DebateConsensus } from './debate.types';
import type { ConfigFieldSpec } from '../plugins/manifest';
import { parseToolCalls } from '../llm/kernel-parser';
import { sanitizeText } from './sanitize.util';

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
  /** Number of ReAct loop iterations executed (always >= 1). */
  turns_used: number;
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

// ── ReAct loop constants (F6-S1) ──────────────────────────────────────────────

/**
 * Default maximum number of ReAct loop iterations per runGovernedTurn call.
 * Overridable via KV key 'react.max_turns'. Clamped 1..10 at parse time.
 */
const REACT_MAX_TURNS_DEFAULT = 4;

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
 * Schema definition for the kernel__promote_pretest tool.
 * Injected into the LLM tool schema ONLY when source === 'reflection'.
 * Calls PretestService.promote() WITHOUT confirm, so with require_human_confirm=true (default)
 * the LLM always lands in needs_confirmation and CANNOT auto-apply to live.
 * Only a TOTP-authenticated REST call with confirm:true can actually apply.
 */
const KERNEL_PROMOTE_PRETEST_TOOL: import('../plugins/plugins.service').ProviderTool = {
  plugin_id: 'kernel',
  name: 'kernel__promote_pretest',
  description:
    'Requests promotion of a gate-ready pretest to live. Requires human confirmation by default; the LLM can only request, never auto-deploy.',
  input_schema: {
    type: 'object',
    properties: {
      pretest_id: { type: 'string' },
      rationale: { type: 'string' },
    },
    required: ['pretest_id'],
  },
};

/**
 * Schema definition for the kernel__record_lesson tool.
 * Injected into the LLM tool schema ONLY when source === 'reflection'.
 * Stores a curated lesson into the lesson_memory store.
 */
const KERNEL_RECORD_LESSON_TOOL: import('../plugins/plugins.service').ProviderTool = {
  plugin_id: 'kernel',
  name: 'kernel__record_lesson',
  description:
    'Records a curated lesson (≤600 chars) into long-term lesson_memory. Only available during reflection turns.',
  input_schema: {
    type: 'object',
    properties: {
      text: { type: 'string' },
      episode_id: { type: 'string' },
      rationale: { type: 'string' },
    },
    required: ['text'],
  },
};

/**
 * Schema definition for the kernel__train_ml_model tool.
 * Injected into the LLM tool schema ONLY when source === 'reflection'.
 * Trains the on-device sklearn model from captured signal history and persists
 * the base64 blob in KV key 'ml:model:current'. Inert to live cycle decisions (s2).
 */
const KERNEL_TRAIN_ML_MODEL_TOOL: import('../plugins/plugins.service').ProviderTool = {
  plugin_id: 'kernel',
  name: 'kernel__train_ml_model',
  description:
    'Trains the on-device ML model from captured signal history and persists it. Reflection turns only.',
  input_schema: { type: 'object', properties: {}, required: [] },
};

/**
 * Schema definition for the kernel__tune_plugin_param tool.
 * Injected into the LLM tool schema ONLY when source === 'reflection'.
 * Mutates a live skill plugin's config via plugins.mergeConfig, governed by
 * param-discipline check_lock + journal_entry. Fail-closed: any gate fails → no mutation.
 * Only skill plugins are tunable (not disciplines, providers, universes, or param-discipline itself).
 */
const KERNEL_TUNE_PLUGIN_PARAM_TOOL: import('../plugins/plugins.service').ProviderTool = {
  plugin_id: 'kernel',
  name: 'kernel__tune_plugin_param',
  description:
    'Tunes a live skill plugin config parameter via param-discipline governance. Reflection turns only. Fail-closed: any gate (type, schema, lock, budget, hypothesis) fails → no mutation.',
  input_schema: {
    type: 'object',
    properties: {
      plugin_id: { type: 'string' },
      param: { type: 'string' },
      value: {},
      hypothesis: { type: 'string' },
    },
    required: ['plugin_id', 'param', 'value', 'hypothesis'],
  },
};

/**
 * Cold-start threshold: minimum number of labeled rows required to attempt training.
 * Mirrors manifest [config].min_samples = 50 in plugins/ml-feature-extractor/manifest.toml.
 * Below this, the handler audits cold_start and returns without writing KV.
 */
const MIN_ML_SAMPLES = 50;

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
  'promote_pretest',
  'record_lesson',
  'train_ml_model',
  'tune_plugin_param',
]);

/** Plugin id of the ML discipline — used for opt-in injection and ML-first sort. */
const ML_PLUGIN_ID = 'ml-feature-extractor';

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
    // KvService injected @Optional() so existing tests that construct AgentsService
    // without KvService continue compiling; _resolveMaxTurns falls back to REACT_MAX_TURNS_DEFAULT.
    @Optional()
    private readonly kv?: KvService,
    // LongTermMemoryService injected @Optional() — cycles run normally when absent.
    // F6-s2 PR2: prefetch before runGovernedTurn + record after.
    @Optional()
    private readonly longTermMemory?: LongTermMemoryService,
    // DebateService injected @Optional() — absent until F6-s3 PR-B is enabled.
    // The debate gate is fully nested under `if (this.debate)` so existing tests
    // that do not provide it remain byte-identical to pre-change behaviour.
    @Optional()
    private readonly debate?: DebateService,
    // ProviderGatewayService injected @Optional() — needed only for _isHighImpact
    // notional calculation. Absent → _isHighImpact returns false (fail-soft).
    @Optional()
    private readonly providerGateway?: ProviderGatewayService,
    // MlSignalRecordService injected @Optional() — s1 data capture (INERT in s1).
    // Absent → _mlCaptureSignals short-circuits; cycle is byte-identical to pre-s1.
    @Optional()
    private readonly mlSignalRecord?: MlSignalRecordService,
    // TradeIntentService injected @Optional() — when present, an LLM decision is
    // persisted as a pending TradeIntent for HITL approval (paper-only). Absent →
    // cycle behaves exactly as before (decisions only recorded in audit/memory).
    @Optional()
    private readonly tradeIntent?: TradeIntentService,
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
   * Resolves the per-call ReAct iteration ceiling from KV.
   * Reads 'react.max_turns', parses with Number(), applies fail-safe and clamp 1..10.
   * Absent/invalid/kv-unavailable → REACT_MAX_TURNS_DEFAULT (4).
   */
  private async _resolveMaxTurns(): Promise<number> {
    const raw = this.kv ? await this.kv.get('react.max_turns') : null;
    const n = raw === null ? REACT_MAX_TURNS_DEFAULT : Number(raw);
    const v = Number.isFinite(n) ? Math.trunc(n) : REACT_MAX_TURNS_DEFAULT;
    return Math.min(10, Math.max(1, v));
  }

  /**
   * Composes the LLM context for a given iteration.
   * On iteration 1 (obs empty) → returns base unchanged (byte-identical path).
   * On subsequent iterations → appends a [OBSERVACIONES DE ITERACIONES PREVIAS] block.
   *
   * Caps (defense in depth, mirrors _assembleReflectionContext budget pattern):
   * - Per-observation render hard-capped at ITER_OBS_CAP chars
   * - Keep last ITER_OBS_MAX observations
   * - Global transcript budget ITER_TRANSCRIPT_BUDGET — sliced at the end
   */
  private _composeIterationContext(base: string, obs: { render: string }[]): string {
    if (obs.length === 0) return base;

    const ITER_OBS_CAP = 800;
    const ITER_OBS_MAX = 3;
    const ITER_TRANSCRIPT_BUDGET = 3000;

    const recent = obs.slice(-ITER_OBS_MAX);
    const block = recent
      .map((o) => o.render.slice(0, ITER_OBS_CAP))
      .join('\n\n')
      .slice(0, ITER_TRANSCRIPT_BUDGET);

    return `${base}\n\n[OBSERVACIONES DE ITERACIONES PREVIAS]\n${block}`;
  }

  /**
   * Renders a completed iteration's result as an observation string for context feedback.
   * Includes the LLM text (sliced ~400), executed/dropped tool calls, and sandbox results.
   */
  private _toObservation(
    iterN: number,
    iter: {
      text: string;
      tool_calls: import('../llm/llm.service').ToolCallRequest[];
      decisions: Decision[];
      sandbox_results: SandboxResult[];
    },
  ): { render: string } {
    const textSlice = (iter.text ?? '').slice(0, 400);
    const toolLines = iter.decisions.map((d) => {
      if (!d.allowed) {
        return `  ${d.plugin_id}.${d.function}(…) -> dropped:${d.reason ?? 'unknown'}`;
      }
      const sr = iter.sandbox_results.find(
        (r) => r.plugin_id === d.plugin_id && r.function === d.function,
      );
      const resultStr = sr ? JSON.stringify(sr.result).slice(0, 200) : 'null';
      return `  ${d.plugin_id}.${d.function}(…) -> ok=${String(sr?.ok ?? false)} result=${resultStr}`;
    });
    const toolBlock = toolLines.length > 0 ? `\ntools=[\n${toolLines.join('\n')}\n]` : '';
    return {
      render: `ITER ${String(iterN)}: assistant_text=${textSlice}${toolBlock}`,
    };
  }

  /**
   * Executes a SINGLE ReAct iteration: build system prompt → llm.complete → parseToolCalls
   * → _validateToolCalls → _executeToolCalls → per-source audit.
   *
   * This is the extracted body of the former single-shot runGovernedTurn.
   * The ordering is preserved VERBATIM to maintain the proven validate→dispatch→audit sequence.
   *
   * hadToolCalls = validatedCalls.length > 0 (post-validation).
   * An iteration whose calls were ALL dropped has hadToolCalls=false → natural exit (safe direction).
   */
  private async _runSingleIteration(args: {
    cycle_id: string;
    source: GovernedTurnInput['source'];
    context: string;
    system_prompt?: string;
    effectiveTools: import('../plugins/plugins.service').ProviderTool[];
    /** F6-s4: filtered subset for [TOOL SCHEMA] injection only. _validateToolCalls still uses effectiveTools. */
    visibleTools: import('../plugins/plugins.service').ProviderTool[];
    _activePlugins?: import('../plugins/plugins.service').HydratedPlugin[];
    virtual_only?: boolean;
    /** Pre-resolved decision prompt (hoisted once per governed turn — avoids N DB round-trips). */
    decisionPrompt: string | null;
  }): Promise<{
    text: string;
    tool_calls: import('../llm/llm.service').ToolCallRequest[];
    decisions: Decision[];
    sandbox_results: SandboxResult[];
    signalsEmitted: { symbol: string; action: string }[];
    llm_response: LlmResponse;
    skills_read: string[];
    skills_written: string[];
    hadToolCalls: boolean;
  }> {
    const { cycle_id, source, effectiveTools, visibleTools, decisionPrompt } = args;

    // ── Build system prompt with decision prompt + tool schema ────────────────
    // decisionPrompt is resolved ONCE per governed turn in runGovernedTurn and passed
    // here to avoid N DB round-trips (one per iteration) for a value constant per turn.
    // F6-s4: [TOOL SCHEMA] uses visibleTools (pre-inference gate); _validateToolCalls uses effectiveTools.
    let builtSystemPrompt = args.system_prompt ?? '';
    if (decisionPrompt !== null) {
      const toolSchemaJson = JSON.stringify(visibleTools);
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
      context: args.context,
      system_prompt: builtSystemPrompt || undefined,
      tools: effectiveTools,
    });

    // ── Parse tool_calls: native wins, text-fallback for non-tool backends ────
    // When the LLM backend supports native tool_calls (OpenAI/OpenRouter), it
    // returns them directly in llmResponse.tool_calls.  We only fall back to
    // text parsing when the response carries no native calls — this keeps
    // backwards compat with Anthropic/Gemini/subscription backends.
    const auditFn = (raw: string): void => {
      void this.audit.log({
        cycle_id,
        event_type: 'parse_miss',
        meta: { raw_block: raw.slice(0, 500) },
      });
    };
    if (!llmResponse.tool_calls || llmResponse.tool_calls.length === 0) {
      llmResponse.tool_calls = parseToolCalls(llmResponse.text, auditFn);
    }

    const skills_read = llmResponse.skills_read ?? [];
    const skills_written = llmResponse.skills_written ?? [];

    // ── Validate and dispatch ─────────────────────────────────────────────────
    // Controls re-applied on EVERY iteration with the SAME (effectiveTools, _activePlugins,
    // virtual_only, source) — nothing is cached from a prior iteration.
    const validatedCalls = await this._validateToolCalls(
      cycle_id,
      llmResponse.tool_calls,
      effectiveTools,
      args._activePlugins,
      args.virtual_only,
      source,
    );
    const { decisions, sandbox_results, signalsEmitted } = await this._executeToolCalls(
      cycle_id,
      validatedCalls,
    );

    // hadToolCalls is measured on post-validation calls (not raw parsed calls).
    // An all-dropped iteration counts as no valid intent → natural exit (safe direction).
    const hadToolCalls = validatedCalls.length > 0;

    // ── Audit the turn ────────────────────────────────────────────────────────
    if (source === 'chat') {
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
    } else if (source === 'pretest') {
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
          virtual_only: args.virtual_only ?? false,
        },
      });
    } else if (source === 'cycle') {
      // Cycle owns its own audit — nothing to emit here.
    } else if (source === 'reflection') {
      // Reflection turn audit is owned by runReflectionTurn (emits 'reflection_turn' event).
      // runGovernedTurn intentionally emits nothing for reflection turns.
    } else {
      this.log.warn(
        `runGovernedTurn: unknown source discriminator '${String(source)}' — skipping audit`,
      );
    }

    return {
      text: llmResponse.text,
      tool_calls: validatedCalls,
      decisions,
      sandbox_results,
      signalsEmitted,
      llm_response: llmResponse,
      skills_read,
      skills_written,
      hadToolCalls,
    };
  }

  /**
   * Executes the bounded ReAct loop: runs _runSingleIteration up to maxTurns times,
   * accumulating decisions/sandbox_results/signalsEmitted across iterations.
   *
   * Loop exits when:
   *   (a) Natural exit: iteration had no validated tool_calls (LLM signaled completion).
   *   (b) Budget exhausted: turn count reached maxTurns while LLM was still emitting calls.
   *       → audit react_budget_exhausted, NO grace call.
   *
   * maxTurns=1 is byte-identical to the pre-F6-s1 single-shot path:
   *   - _composeIterationContext returns base unchanged (obs empty on iter 1)
   *   - No react_iteration/react_budget_exhausted audit on natural exit
   *   - Only additive field is turns_used:1
   *
   * effectiveTools and _activePlugins are hoisted ONCE before the loop
   * (tool SCHEMA is fixed per governed turn; only context changes between iterations).
   * Controls (_validateToolCalls with source/virtual_only) re-applied EVERY iteration.
   */
  async runGovernedTurn(input: GovernedTurnInput): Promise<GovernedTurnResult> {
    const cycle_id = input.cycle_id ?? randomUUID();

    // ── Hoist ONCE — tool schema, decision prompt, and active plugins fixed per governed turn ──
    const providerTools = await this.plugins.getProviderTools();
    const kernelTools =
      (input.source as string) === 'reflection'
        ? [
            KERNEL_WRITE_SKILL_TOOL,
            KERNEL_CREATE_PRETEST_VARIANT_TOOL,
            KERNEL_RUN_PRETEST_COMPARE_TOOL,
            KERNEL_PROMOTE_PRETEST_TOOL,
            KERNEL_RECORD_LESSON_TOOL,
            KERNEL_TRAIN_ML_MODEL_TOOL,
            KERNEL_TUNE_PLUGIN_PARAM_TOOL,
          ]
        : [];
    const effectiveTools = [...providerTools, ...kernelTools];
    // F6-s4: compute visibleTools ONCE per governed turn (pre-inference gate).
    // visibleTools is used for [TOOL SCHEMA] only; _validateToolCalls keeps effectiveTools (defense in depth).
    // When nothing is hidden, _computeVisibleTools returns the same array reference → byte-identical schema.
    const visibleTools = await this._computeVisibleTools(effectiveTools, input.virtual_only);
    // Hoisted ONCE per governed turn — avoids N DB round-trips for a value that is
    // constant for the lifetime of this turn (decision prompt does not change mid-loop).
    const decisionPrompt = await this.plugins.getActiveDecisionPrompt();
    const maxTurns = await this._resolveMaxTurns();

    // ── Accumulators ─────────────────────────────────────────────────────────
    const allDecisions: Decision[] = [];
    const allSandbox: SandboxResult[] = [];
    const allSignals: { symbol: string; action: string }[] = [];
    const observations: { render: string }[] = [];

    let turn = 0;
    let last: Awaited<ReturnType<typeof this._runSingleIteration>> | undefined;

    // ── ReAct loop ───────────────────────────────────────────────────────────
    while (turn < maxTurns) {
      turn++;
      const iterContext = this._composeIterationContext(input.context, observations);
      last = await this._runSingleIteration({
        cycle_id,
        source: input.source,
        context: iterContext,
        system_prompt: input.system_prompt,
        effectiveTools,
        visibleTools,
        _activePlugins: input._activePlugins,
        virtual_only: input.virtual_only,
        decisionPrompt,
      });

      // Accumulate results
      allDecisions.push(...last.decisions);
      allSandbox.push(...last.sandbox_results);
      allSignals.push(...last.signalsEmitted);

      if (!last.hadToolCalls) {
        // NATURAL EXIT — LLM signaled completion (no validated tool calls)
        break;
      }

      // Feed results forward as observation for the next iteration
      observations.push(this._toObservation(turn, last));

      // Audit the completed iteration (lightweight trace event).
      // Suppressed when maxTurns=1: single-shot path never emits react_* events,
      // keeping it byte-identical to the pre-F6-S1 behavior.
      if (maxTurns > 1) {
        await this.audit.log({
          cycle_id,
          event_type: 'react_iteration',
          meta: {
            turn,
            hadToolCalls: true,
            tools_called: last.tool_calls.map((t) => `${t.plugin_id}.${t.function}`),
          },
        });
      }

      // BUDGET EXHAUSTION — LLM still has intent but ceiling reached.
      // Suppressed when maxTurns=1 (same rationale as react_iteration above).
      if (turn >= maxTurns) {
        if (maxTurns > 1) {
          await this.audit.log({
            cycle_id,
            event_type: 'react_budget_exhausted',
            meta: {
              turns_used: turn,
              max_turns: maxTurns,
              last_tool_calls: last.tool_calls.map((t) => `${t.plugin_id}.${t.function}`),
            },
          });
        }
        break; // SAFE DEFAULT — stop, no grace call
      }
    }

    // last is always defined: loop runs at least once (maxTurns >= 1)
    const finalIter = last!;

    return {
      cycle_id,
      text: finalIter.text,
      tool_calls: finalIter.tool_calls,
      decisions: allDecisions,
      sandbox_results: allSandbox,
      backend: finalIter.llm_response.backend ?? 'api',
      skills_read: finalIter.skills_read,
      skills_written: finalIter.skills_written,
      llm_response: finalIter.llm_response,
      signalsEmitted: allSignals,
      turns_used: turn,
    };
  }

  /** Fallback capital when KV `cycle.capital` is unset (override via PATCH /cycle/config). */
  private static readonly DEFAULT_CAPITAL = 10_000;

  /** Fallback universe when KV `cycle.universe` is unset (override via PATCH /cycle/config). */
  private static readonly DEFAULT_UNIVERSE = [
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

  /**
   * Resolves the trading universe and fetches normalized OHLCV for the cycle.
   * Runs on the NestJS side (which has network); the data is injected into the
   * sandbox cycle ctx so the strategy on_cycle hooks read it via
   * provider_tools.get_ohlcv WITHOUT the sandbox ever touching the network.
   * Fail-soft: missing gateway → empty; per-symbol fetch errors are skipped.
   */
  private async _buildMarketContext(): Promise<{
    universe: string[];
    ohlcv: Record<string, unknown[]>;
  }> {
    if (!this.providerGateway) return { universe: [], ohlcv: {} };

    let universe = AgentsService.DEFAULT_UNIVERSE;
    try {
      const raw = this.kv ? await this.kv.get('cycle.universe') : null;
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

    const timeframe = (this.kv ? await this.kv.get('cycle.timeframe') : null) || '1d';
    // Default 300: cubre el lookback de estrategias de momentum (12-1 ≈ 252+skip) para que
    // operen desde el PRIMER ciclo (la historia se baja del provider, no se espera a acumular).
    const bars = Number((this.kv ? await this.kv.get('cycle.bars') : null) || 0) || 300;
    // DATA provider for OHLCV is decoupled from the EXECUTION broker: Alpaca's free
    // IEX feed returns no historical bars, so default market data comes from Yahoo
    // (free, full history). Override via KV `cycle.data_provider`.
    const dataProvider =
      (this.kv ? await this.kv.get('cycle.data_provider') : null) || 'yahoo-finance-provider';

    const ohlcv: Record<string, unknown[]> = {};
    await Promise.all(
      universe.map(async (symbol) => {
        try {
          const raw = await this.providerGateway!.getOhlcv(dataProvider, symbol, timeframe, bars);
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
            `OHLCV fetch falló para ${symbol}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }),
    );
    return { universe, ohlcv };
  }

  private async _executeCycle(
    cycle_id: string,
    context: string,
    systemPrompt?: string,
  ): Promise<AgentCycleResult> {
    // ── 1. Inyectar memoria inter-ciclos ──────────────────────────────────────
    const memContext = await this.memory.toContextString();
    let enrichedContext = memContext
      ? `${memContext}\n\n[CONTEXTO DEL CICLO ACTUAL]\n${context}`
      : context;

    // ── 2. Ejecutar hooks on_cycle de plugins activos ─────────────────────────
    const activePlugins = await this.plugins.findActive();
    const activeIds = activePlugins.map((p: HydratedPlugin) => p.id);

    // Market data for the strategy hooks: NestJS (which has network) resolves the
    // universe and fetches OHLCV, then injects it so the sandbox on_cycle hooks can
    // read it via provider_tools.get_ohlcv WITHOUT the sandbox ever touching the net.
    const market = await this._buildMarketContext();
    // Capital fed to risk/sizing disciplines (so they can APPROVE + size signals).
    // Configurable via KV `cycle.capital`; falls back to a sane default.
    const capital =
      Number((this.kv ? await this.kv.get('cycle.capital') : null) || 0) ||
      AgentsService.DEFAULT_CAPITAL;
    const cycleCtx: Record<string, unknown> = {
      cycle_id,
      universe: market.universe,
      ohlcv: market.ohlcv,
      config: {},
      portfolio: {},
      portfolio_value: capital,
      positions: [],
      trade_history: [],
    };
    const hookResult = await this.sandbox.runCycle(activeIds, cycleCtx);
    const baseCtx = (hookResult.result ?? cycleCtx) as Record<string, unknown>;
    // Ensure the capital context survives into the veto layer (the runner result
    // does not echo the input context).
    const hookCtx: Record<string, unknown> = {
      ...baseCtx,
      portfolio_value: capital,
      positions: baseCtx['positions'] ?? [],
      portfolio: baseCtx['portfolio'] ?? {},
      trade_history: baseCtx['trade_history'] ?? [],
    };
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
    //
    // VETO THREAT MODEL — _runVetoLayer is SIGNAL-ADVISORY, not a hard tool-call firewall.
    //
    // What it does: filters which pending_signals are surfaced to the LLM (cycle-level,
    // once, before the ReAct loop). Signals that discipline plugins reject are removed
    // from pending_signals before being injected into the LLM context.
    //
    // What it does NOT do: it does NOT inspect or block individual tool_calls the LLM
    // emits during the ReAct loop. That hard perimeter is enforced by:
    //   • _validateToolCalls — plugin allowlist + kernel source-gating + virtual_only check,
    //     re-applied on EVERY ReAct iteration with the same (effectiveTools, _activePlugins,
    //     virtual_only, source) — nothing loosens between iterations.
    //   • Broker-side order validation — final safety net at execution time.
    //
    // This is INTENTIONAL per the neutral-kernel principle: the kernel does not hard-block
    // LLM trades at the signal-advisory layer; risk policy lives in plugins, the validation
    // gate (_validateToolCalls), and HITL review. Treating the veto as a tool-call firewall
    // would be incorrect and would contradict the design.
    const disciplinePlugins = activePlugins.filter((p: HydratedPlugin) => p.type === 'discipline');

    // ml-feature-extractor-s3: resolve model injection (opt-in, hash-validated, fail-soft).
    // Returns {} when ML plugin is inactive — no KV read, cycle byte-identical (AC-S3-1/12).
    const mlInjection: { model_blob?: string; feature_names?: string[] } =
      await this._mlResolveModelInjection(activePlugins).catch(() => ({}));

    const { vetoCtx, vetoSummary } = await this._runVetoLayer(
      cycle_id,
      disciplinePlugins,
      hookCtx,
      pendingSignals,
      mlInjection,
    );

    // ml-feature-extractor-s3 D6: audit when a model was actually applied (blob injected).
    // Fix4: n_signals = what the ML hook operated on (pendingSignals before the aggregator
    // runs), NOT post-veto count. pendingSignals is the array passed into _runVetoLayer;
    // since ML runs first (mlFirst sort), it sees the full pre-aggregator signal set.
    if (mlInjection.model_blob) {
      await this.audit.log({
        cycle_id,
        event_type: 'ml_signals_adjusted',
        meta: { n_signals: pendingSignals.length, hash_match: true },
      });
    }

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

    // ── F6-s2 PR2: prefetch relevant episodes (retrieve-on-demand) ─────────────
    enrichedContext = await this._ltmPrefetchInject(
      enrichedContext,
      approvedSignals,
      pendingSignals,
    );

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

    // ── F6-s2 PR2: record episode after governed turn ─────────────────────────
    await this._ltmRecordEpisode(cycle_id, signalsEmitted, llmResponse.text ?? '');

    // ── ml-feature-extractor-s1: capture per-skill signal vector (INERT) ──────
    // Runs after _ltmRecordEpisode so all decision data is finalized.
    // NEVER throws into the cycle — fail-soft wrapper inside the helper.
    try {
      await this._mlCaptureSignals(cycle_id, approvedSignals, signalsEmitted, activePlugins);
    } catch (e) {
      this.log.warn(`[ML] _mlCaptureSignals outer catch — signals not recorded: ${e}`);
    }

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
  // ── F6-s2 PR2 LTM helpers ─────────────────────────────────────────────────

  /**
   * Prefetch relevant past episodes and inject [EPISODIOS RELEVANTES] block into
   * the enriched context ONLY when prefetch returns at least one hit.
   * Failure NEVER breaks the cycle (swallows exceptions, returns ctx unchanged).
   */
  private async _ltmPrefetchInject(
    enrichedContext: string,
    approvedSignals: unknown[],
    pendingSignals: unknown[],
  ): Promise<string> {
    if (!this.longTermMemory) return enrichedContext;
    try {
      const extract = (sigs: unknown[]): string[] =>
        sigs
          .map((s) => (s as Record<string, unknown>)['symbol'])
          .filter((sym): sym is string => typeof sym === 'string');
      const uniqueSymbols = [...new Set([...extract(approvedSignals), ...extract(pendingSignals)])];
      if (uniqueSymbols.length === 0) return enrichedContext;
      const hits = await this.longTermMemory.prefetch(uniqueSymbols.join(' '), 5);
      if (hits.length === 0) return enrichedContext;
      const text = hits
        .map(
          (ep) =>
            `[${ep.cycle_id}] ${ep.action_summary} | P&L: ${ep.outcome_pnl ?? 'pending'} | ${ep.llm_rationale}`,
        )
        .join('\n');
      const block = `[EPISODIOS RELEVANTES]\n${text}`.slice(0, 800);
      return `${enrichedContext}\n\n${block}`;
    } catch (e) {
      this.log.warn(`[LTM] prefetch failed — continuing without episode context: ${e}`);
      return enrichedContext;
    }
  }

  /**
   * Record the cycle episode to long-term memory after a governed turn.
   * outcome_pnl is null here; SnapshotService backfills it via updateOutcome().
   * Failure NEVER breaks the cycle (swallows exceptions).
   */
  private async _ltmRecordEpisode(
    cycle_id: string,
    signalsEmitted: { symbol: string; action: string }[],
    llmText: string,
  ): Promise<void> {
    if (!this.longTermMemory) return;
    try {
      const symbols = signalsEmitted.map((s) => s.symbol);
      const actionSummary = signalsEmitted
        .map((s) => `${s.action.toUpperCase()} ${s.symbol}`)
        .join(', ')
        .slice(0, 200);
      const llmRationale = sanitizeText(llmText).slice(0, 500);
      // symbol-only regime tags for PR2; richer tags deferred to later PRs
      const regimeTags = symbols;
      const narrative = sanitizeText(
        `${symbols.join(' ')} ${regimeTags.join(' ')} ${actionSummary} ${llmRationale}`.slice(
          0,
          1400,
        ),
      );
      await this.longTermMemory.record({
        cycle_id,
        symbols,
        regime_tags: regimeTags,
        action_summary: actionSummary,
        llm_rationale: llmRationale,
        narrative,
      });
    } catch (e) {
      this.log.warn(`[LTM] record failed — episode not persisted: ${e}`);
    }
  }

  /**
   * ml-feature-extractor-s1: capture per-skill signal vector for each symbol.
   * INERT in s1 — records data only, NEVER reads back into the decision path.
   * Fail-soft: any exception is caught here AND by the outer try/catch at the call site.
   */
  private async _mlCaptureSignals(
    cycleId: string,
    approvedSignals: unknown[],
    signalsEmitted: { symbol: string; action: string }[],
    activePlugins: HydratedPlugin[],
  ): Promise<void> {
    if (!this.mlSignalRecord) return; // INERT when absent (@Optional)
    try {
      // Skill plugin ids only — used for the active_skill_hash
      const skillIds = activePlugins
        .filter((p: HydratedPlugin) => p.type === 'skill')
        .map((p: HydratedPlugin) => p.id);
      const activeSkillHash = this.mlSignalRecord.computeActiveSkillHash(skillIds);

      // Group approved per-skill signals by symbol
      const bySymbol = new Map<string, SkillContribution[]>();
      for (const s of approvedSignals as Record<string, unknown>[]) {
        const symbol = typeof s['symbol'] === 'string' ? s['symbol'] : null;
        if (!symbol) continue;
        const contributions = bySymbol.get(symbol) ?? [];
        const rawPluginId = s['plugin_id'];
        const rawSource = s['source'];
        const rawAction = s['action'];
        let resolvedPluginId = '';
        if (typeof rawPluginId === 'string') resolvedPluginId = rawPluginId;
        else if (typeof rawSource === 'string') resolvedPluginId = rawSource;
        contributions.push({
          plugin_id: resolvedPluginId,
          action: typeof rawAction === 'string' ? rawAction : '',
          confidence: typeof s['confidence'] === 'number' ? s['confidence'] : 0,
        });
        bySymbol.set(symbol, contributions);
      }

      // Resolved action per symbol from signalsEmitted (the cycle's decision)
      const actionBySymbol = new Map(signalsEmitted.map((s) => [s.symbol, s.action]));

      // Only symbols that have a resolved action (no action → no label can attach)
      const records = [...bySymbol.entries()]
        .filter(([sym]) => actionBySymbol.has(sym))
        .map(([symbol, skill_vector]) => ({
          symbol,
          skill_vector,
          action: actionBySymbol.get(symbol)!,
        }));

      if (records.length > 0) {
        await this.mlSignalRecord.recordSignals(cycleId, records, activeSkillHash);
      }
    } catch (e) {
      this.log.warn(`[ML] _mlCaptureSignals failed — signals not recorded: ${e}`);
    }
  }

  /**
   * ml-feature-extractor-s3: resolve the model injection payload for the current cycle.
   *
   * Opt-in: if ml-feature-extractor is NOT active → returns {} immediately without any KV read
   * (AC-S3-1/12 — byte-identical to pre-s3 when the plugin is inactive).
   *
   * Hash-validated: compares the stored active_skill_hash against the current active skill set.
   * Mismatch (stale model) → returns {} (identity). Hash match → returns {model_blob, feature_names}.
   *
   * Fail-soft: any error (KV unavailable, JSON parse, hash computation) → warn + return {}.
   * The cycle is NEVER broken by this method.
   */
  private async _mlResolveModelInjection(
    activePlugins: HydratedPlugin[],
  ): Promise<{ model_blob?: string; feature_names?: string[] }> {
    // Opt-in gate: no KV read unless the ML plugin is active (AC-S3-1/12)
    if (!activePlugins.some((p) => p.id === ML_PLUGIN_ID)) {
      return {};
    }
    try {
      const raw = await this.kv?.get('ml:model:current');
      if (!raw) return {};
      const parsed = JSON.parse(raw) as {
        blob_b64: string;
        active_skill_hash: string;
        feature_names: string[];
      };
      // Fix3: explicit guard before non-null assertion — mlSignalRecord is an
      // optional constructor dep; if absent, identity (no model injection) is correct.
      if (!this.mlSignalRecord) return {};
      const skillIds = activePlugins.filter((p) => p.type === 'skill').map((p) => p.id);
      const currentHash = this.mlSignalRecord.computeActiveSkillHash(skillIds);
      if (parsed.active_skill_hash !== currentHash) {
        this.log.warn('[ML] stale model — active_skill_hash mismatch; using identity');
        return {};
      }
      return { model_blob: parsed.blob_b64, feature_names: parsed.feature_names };
    } catch (e) {
      this.log.warn(`[ML] _mlResolveModelInjection failed — using identity: ${String(e)}`);
      return {};
    }
  }

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
    mlInjection: { model_blob?: string; feature_names?: string[] } = {},
  ): Promise<{ vetoCtx: Record<string, unknown>; vetoSummary: VetoSummary }> {
    let vetoCtx: Record<string, unknown> = { ...hookCtx, pending_signals: pendingSignals };
    const vetoReasons: string[] = [];

    // D1: Stable sort — ML plugin always runs first, others keep relative order.
    // This is structural and DB-order-independent (AC-S3-6/7).
    const mlFirst = (a: HydratedPlugin, b: HydratedPlugin): number => {
      if (a.id === ML_PLUGIN_ID) return -1;
      if (b.id === ML_PLUGIN_ID) return 1;
      return 0;
    };
    const sorted = [...disciplinePlugins].sort(mlFirst);

    for (const disc of sorted) {
      // D2: inject model_blob ONLY into the ML plugin's hook context (no leakage)
      const hookCtxForDisc: Record<string, unknown> =
        disc.id === ML_PLUGIN_ID ? { ...vetoCtx, ...mlInjection } : vetoCtx;

      const discResult = await this.sandbox.call({
        cmd: 'run_hook',
        plugin_id: disc.id,
        hook: 'on_cycle',
        context: hookCtxForDisc,
      });

      if (discResult.ok && discResult.result) {
        const updated = discResult.result as Record<string, unknown>;
        // D2/Fix2: strip model_blob + feature_names from the ML plugin's echoed ctx
        // before propagating to vetoCtx. The real Python hook returns the full ctx
        // (including injected fields), so we must remove them here to prevent leakage
        // to downstream plugins (aggregator etc.).
        if (disc.id === ML_PLUGIN_ID) {
          const stripped = { ...updated };
          delete stripped['model_blob'];
          delete stripped['feature_names'];
          vetoCtx = stripped;
        } else {
          vetoCtx = updated;
        }
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
    } else if (tc.function === 'promote_pretest') {
      await this._kernelPromotePretest(cycle_id, tc, decisions, sandbox_results);
    } else if (tc.function === 'record_lesson') {
      await this._kernelRecordLesson(cycle_id, tc, decisions, sandbox_results);
    } else if (tc.function === 'train_ml_model') {
      await this._kernelTrainMlModel(cycle_id, tc, decisions, sandbox_results);
    } else if (tc.function === 'tune_plugin_param') {
      await this._kernelTunePluginParam(cycle_id, tc, decisions, sandbox_results);
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

  /**
   * Handles kernel__promote_pretest dispatch.
   * Calls PretestService.promote(pretest_id) WITHOUT confirm — so with default
   * require_human_confirm=true the LLM always gets needs_confirmation and CANNOT auto-apply.
   * NEVER calls sandbox (kernel bypass). Catches NotFoundException → ok:false error:'not_found'.
   */
  private async _kernelPromotePretest(
    cycle_id: string,
    tc: import('../llm/llm.service').ToolCallRequest,
    decisions: Decision[],
    sandbox_results: SandboxResult[],
  ): Promise<void> {
    // 1. Pretest-unavailable guard (same shape as s3 helpers).
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

    // 2. Coerce and validate pretest_id.
    const rawId = tc.args['pretest_id'];
    const pretest_id = typeof rawId === 'string' ? rawId : '';
    if (!pretest_id) {
      decisions.push({ ...tc, allowed: false, reason: 'invalid_promote_args' });
      sandbox_results.push({
        plugin_id: 'kernel',
        function: tc.function,
        ok: false,
        error: 'invalid_promote_args',
      });
      return;
    }

    // 3. Audit the LLM's intent BEFORE calling promote (intent is always recorded).
    const rationale = typeof tc.args['rationale'] === 'string' ? tc.args['rationale'] : undefined;
    await this.audit.log({
      cycle_id,
      event_type: 'pretest_promote_requested',
      meta: { pretest_id, rationale },
    });

    // 4. Call promote() WITHOUT confirm — safety: LLM cannot auto-apply with default config.
    let result: import('../pretest/pretest.service').PromoteResult;
    try {
      result = await this.pretest.promote(pretest_id);
    } catch (err: unknown) {
      const isNotFound = err instanceof NotFoundException;
      decisions.push({ ...tc, allowed: false, reason: isNotFound ? 'not_found' : String(err) });
      sandbox_results.push({
        plugin_id: 'kernel',
        function: tc.function,
        ok: false,
        error: isNotFound ? 'not_found' : String(err),
      });
      return;
    }

    // 5. Push result to decisions and sandbox_results. NEVER calls sandbox.
    decisions.push({ ...tc, allowed: result.ok });
    sandbox_results.push({
      plugin_id: 'kernel',
      function: tc.function,
      ok: result.ok,
      result,
    });
  }

  /**
   * Handles kernel__record_lesson dispatch.
   * Validates text is non-empty, calls longTermMemory.promote(), audits 'lesson_recorded'.
   * NEVER calls sandbox. Fail-soft: errors are caught, decision marked allowed:false.
   */
  private async _kernelRecordLesson(
    cycle_id: string,
    tc: import('../llm/llm.service').ToolCallRequest,
    decisions: Decision[],
    sandbox_results: SandboxResult[],
  ): Promise<void> {
    // Guard: LTM service must be available
    if (!this.longTermMemory) {
      decisions.push({ ...tc, allowed: false, reason: 'memory_unavailable' });
      sandbox_results.push({
        plugin_id: 'kernel',
        function: tc.function,
        ok: false,
        error: 'memory_unavailable',
      });
      return;
    }

    // Coerce and validate text
    const rawText = tc.args['text'];
    const text = typeof rawText === 'string' ? rawText.trim() : '';
    if (!text) {
      decisions.push({ ...tc, allowed: false, reason: 'invalid_lesson_args' });
      sandbox_results.push({
        plugin_id: 'kernel',
        function: tc.function,
        ok: false,
        error: 'invalid_lesson_args',
      });
      return;
    }

    // Optional fields
    const rawEpisodeId = tc.args['episode_id'];
    const episode_id = typeof rawEpisodeId === 'string' ? rawEpisodeId : undefined;
    const rawRationale = tc.args['rationale'];
    const rationale = typeof rawRationale === 'string' ? rawRationale : undefined;

    // Sanitize at storage time — strip LLM control tokens so recalled lessons
    // cannot reconstruct a prompt-injection vector in a future reflection turn.
    const sanitizedText = sanitizeText(text);
    const sanitizedRationale = rationale !== undefined ? sanitizeText(rationale) : undefined;

    // Promote the lesson (fail-soft — promote() never throws, but we guard anyway)
    await this.longTermMemory.promote({
      text: sanitizedText,
      episode_id,
      rationale: sanitizedRationale,
    });

    // Audit the lesson recording
    await this.audit.log({
      cycle_id,
      event_type: 'lesson_recorded',
      meta: {
        text: sanitizedText.slice(0, 200),
        episode_id,
        rationale: sanitizedRationale?.slice(0, 200),
      },
    });

    decisions.push({ ...tc, allowed: true });
    sandbox_results.push({
      plugin_id: 'kernel',
      function: tc.function,
      ok: true,
      result: { text, episode_id, rationale },
    });
  }

  /**
   * Handles kernel__train_ml_model dispatch.
   * Reflection-gated (injection side guarantees source==='reflection'; this handler
   * trusts the gate). Reads labeled signal history from MlSignalRecordService,
   * trains via sandbox.callPlugin('ml-feature-extractor','train',...), and stores
   * the resulting base64 blob in KV key 'ml:model:current'.
   *
   * Fail-soft: NEVER throws into the reflection turn. Any error → audit + allowed:false.
   * No-clobber: cold_start / error paths do NOT write KV (existing blob preserved).
   * Inert: does NOT modify _executeCycle or pending_signals (s3 wires predict).
   */
  private async _kernelTrainMlModel(
    cycle_id: string,
    tc: import('../llm/llm.service').ToolCallRequest,
    decisions: Decision[],
    sandbox_results: SandboxResult[],
  ): Promise<void> {
    // Guard: MlSignalRecordService must be injected (@Optional — may be absent in tests).
    // sandbox is always present; guard only mlSignalRecord.
    if (!this.mlSignalRecord) {
      decisions.push({ ...tc, allowed: false, reason: 'ml_unavailable' });
      sandbox_results.push({
        plugin_id: 'kernel',
        function: tc.function,
        ok: false,
        error: 'ml_unavailable',
      });
      return;
    }

    try {
      // Fetch the most recent 1000 labeled rows (outcome_pnl IS NOT NULL).
      const rows = await this.mlSignalRecord.getTrainingData(1000);

      // Cold-start gate: below MIN_ML_SAMPLES we cannot fit a meaningful model.
      // Audit and return without calling the plugin or writing KV.
      if (rows.length < MIN_ML_SAMPLES) {
        await this.audit.log({
          cycle_id,
          event_type: 'ml_model_trained',
          meta: { status: 'cold_start', n_samples: rows.length },
        });
        decisions.push({ ...tc, allowed: true });
        sandbox_results.push({
          plugin_id: 'kernel',
          function: tc.function,
          ok: true,
          result: { status: 'cold_start', n_samples: rows.length },
        });
        return;
      }

      // Invoke the plugin's train() function via the sandbox (no ML in the kernel).
      const res = await this.sandbox.callPlugin('ml-feature-extractor', 'train', {
        training_data: rows,
      });
      const r = (res.result ?? {}) as Record<string, unknown>;

      if (res.ok && r['status'] === 'trained' && typeof r['model_blob'] === 'string') {
        // Store the serialized model in KV. s3 reads this key to inject into predict().
        await this.kv?.set(
          'ml:model:current',
          JSON.stringify({
            blob_b64: r['model_blob'],
            active_skill_hash: r['active_skill_hash'],
            feature_names: r['feature_names'],
            n_samples: r['n_samples'],
            trained_at: new Date().toISOString(),
          }),
        );
        await this.audit.log({
          cycle_id,
          event_type: 'ml_model_trained',
          meta: { status: 'trained', n_samples: r['n_samples'] },
        });
      } else {
        // Plugin returned cold_start (single-class, no data) or an unexpected status.
        // Do NOT overwrite an existing good model blob.
        await this.audit.log({
          cycle_id,
          event_type: 'ml_model_trained',
          meta: {
            status: typeof r['status'] === 'string' ? r['status'] : 'cold_start',
            n_samples: rows.length,
          },
        });
      }

      decisions.push({ ...tc, allowed: true });
      sandbox_results.push({
        plugin_id: 'kernel',
        function: tc.function,
        ok: true,
        result: { status: typeof r['status'] === 'string' ? r['status'] : 'cold_start' },
      });
    } catch (e: unknown) {
      // FAIL-SOFT: any error must not break the reflection turn.
      this.log.warn(`[ML] train_ml_model failed: ${String(e)}`);
      await this.audit.log({
        cycle_id,
        event_type: 'ml_model_trained',
        meta: { status: 'error', error: String(e) },
      });
      decisions.push({ ...tc, allowed: false, reason: 'ml_train_failed' });
      sandbox_results.push({
        plugin_id: 'kernel',
        function: tc.function,
        ok: false,
        error: String(e),
      });
    }
  }

  /**
   * Handles kernel__tune_plugin_param dispatch.
   * Reflection-gated (injection side guarantees source==='reflection').
   * Fail-closed: any gate failure → Decision{allowed:false} + sandbox_result{ok:false} + continue.
   * Never rethrows — reflection turn always survives.
   * Journal KV round-trip: load before check_lock, persist ONLY on success (Step 10).
   * All lock/budget/hypothesis logic delegated to param-discipline via sandbox (no TS duplication).
   */
  private async _kernelTunePluginParam(
    cycle_id: string,
    tc: import('../llm/llm.service').ToolCallRequest,
    decisions: Decision[],
    sandbox_results: SandboxResult[],
  ): Promise<void> {
    // Helper: push a rejection result without throwing
    const reject = (reason: string, detail?: string) => {
      decisions.push({ ...tc, allowed: false, reason, ...(detail ? { detail } : {}) });
      sandbox_results.push({
        plugin_id: 'kernel',
        function: tc.function,
        ok: false,
        error: reason,
      });
    };

    try {
      // Coerce args
      const plugin_id = typeof tc.args['plugin_id'] === 'string' ? tc.args['plugin_id'] : '';
      const param = typeof tc.args['param'] === 'string' ? tc.args['param'] : '';
      const value = tc.args['value'];
      const hypothesis = typeof tc.args['hypothesis'] === 'string' ? tc.args['hypothesis'] : '';

      // Step 1 — Plugin resolution (null sentinel avoids nested try/catch)
      const plugin = await this.plugins.findById(plugin_id).catch(() => null);
      if (!plugin) {
        reject('plugin_not_found');
        return;
      }

      // Step 2 — Skill-only guard
      if (plugin.type !== 'skill') {
        reject('not_a_skill');
        return;
      }

      // Step 3 — Schema lookup
      const schema = await this.plugins.getConfigSchema(plugin_id);
      if (!schema || !(param in schema)) {
        reject('param_not_in_schema');
        return;
      }

      // Step 4 — Value validation (delegates to validateSingleField → validateField)
      const validationErrors = await this.plugins.validateSingleField(plugin_id, param, value);
      if (validationErrors.length > 0) {
        reject('invalid_value', validationErrors.join('; '));
        return;
      }

      // Step 5 — Discipline activation check
      const activePlugins = await this.plugins.findActive();
      const disciplinePlugin = activePlugins.find((p) => p.id === 'param-discipline');
      if (!disciplinePlugin) {
        reject('discipline_inactive');
        return;
      }
      const disciplineConfig: Record<string, unknown> = disciplinePlugin.config ?? {};

      // Steps 6–10: delegate to _runTuneChain (extracted to manage cognitive complexity)
      const chainResult = await this._runTuneChain({
        cycle_id,
        plugin_id,
        param,
        value,
        hypothesis,
        pluginConfig: plugin.config ?? {},
        disciplineConfig,
      });

      if (chainResult.gateReason) {
        reject(chainResult.gateReason);
        return;
      }

      // Step 10b — Audit + return success
      await this.audit.log({
        cycle_id,
        plugin_id,
        event_type: 'param_tuned',
        meta: {
          plugin_id,
          param,
          before: chainResult.before,
          after: value,
          hypothesis,
          entry_id: chainResult.entry_id,
        },
      });

      decisions.push({ ...tc, allowed: true });
      sandbox_results.push({
        plugin_id: 'kernel',
        function: tc.function,
        ok: true,
        result: { ok: true, entry_id: chainResult.entry_id },
      });
    } catch (e: unknown) {
      // FAIL-SOFT: catch-all — any unexpected error must not break the reflection turn
      this.log.warn(`[tune_plugin_param] unexpected error: ${String(e)}`);
      await this.audit.log({
        cycle_id,
        event_type: 'param_tuned',
        meta: { status: 'error', error: String(e) },
      });
      reject('tune_error');
    }
  }

  /**
   * Internal helper for _kernelTunePluginParam steps 6–10 (journal/lock chain).
   * Extracted to keep _kernelTunePluginParam within sonarjs cognitive-complexity limit.
   * Returns { gateReason } on any reject gate, or { before, entry_id, updatedJournal } on success.
   */
  private async _runTuneChain(args: {
    cycle_id: string;
    plugin_id: string;
    param: string;
    value: unknown;
    hypothesis: string;
    pluginConfig: Record<string, unknown>;
    disciplineConfig: Record<string, unknown>;
  }): Promise<
    | { gateReason: string; before?: undefined; entry_id?: undefined }
    | { gateReason: undefined; before: unknown; entry_id: string }
  > {
    const { cycle_id, plugin_id, param, value, hypothesis, pluginConfig, disciplineConfig } = args;

    // Guard — KV is required for journal persistence; without it governance cannot be enforced
    if (!this.kv) return { gateReason: 'kv_unavailable' };

    // Step 6 — Load journal from KV + check lock
    const rawJournal = await this.kv.get('param:journal');
    const journal: unknown[] = rawJournal ? (JSON.parse(rawJournal) as unknown[]) : [];

    const lockRes = await this.sandbox.callPlugin('param-discipline', 'check_lock', {
      plugin_id,
      journal,
      config: disciplineConfig,
    });
    if (!lockRes.ok) return { gateReason: 'lock_check_failed' };
    const lockResult = (lockRes.result ?? {}) as Record<string, unknown>;
    if (lockResult['locked']) return { gateReason: 'param_locked' };

    // Step 7 — Read current value (params_before)
    const before = pluginConfig[param];

    // Step 8 — Journal entry (covers budget + hypothesis checks)
    const jeRes = await this.sandbox.callPlugin('param-discipline', 'journal_entry', {
      plugin_id,
      params_before: { [param]: before },
      params_after: { [param]: value },
      reason: hypothesis,
      hypothesis,
      cycle_id,
      journal,
      config: disciplineConfig,
    });
    const jeResult = (jeRes.result ?? {}) as Record<string, unknown>;
    if (!jeRes.ok || !jeResult['ok']) return { gateReason: 'journal_rejected' };

    // Step 9 — Persist journal BEFORE applying config (conservative: phantom lock > silent bypass)
    // If KV write fails, return a distinct gate reason (fail-closed; config NOT applied)
    const updatedJournal = jeResult['journal'] as unknown[];
    try {
      await this.kv.set('param:journal', JSON.stringify(updatedJournal));
    } catch {
      return { gateReason: 'journal_persist_failed' };
    }

    // Step 10 — Config apply (mergeConfig re-validates = defense in depth)
    // If this fails, the journal entry already persists (phantom lock, acceptable over silent bypass)
    const applyOk = await this.plugins
      .mergeConfig(plugin_id, { [param]: value })
      .then(() => true)
      .catch(() => false);
    if (!applyOk) return { gateReason: 'apply_failed' };

    return {
      gateReason: undefined,
      before,
      entry_id: typeof jeResult['entry_id'] === 'string' ? jeResult['entry_id'] : '',
    };
  }

  /**
   * F6-s4: Reads gating configuration from KV.
   * Fail-safe: absent KV service, absent key, or any read error → default ON (hide providers when CB open).
   * Only the literal string 'false' disables hiding. All other values (including null, 'true', thrown) → true.
   * Mirrors _readDebateConfig pattern.
   */
  private async _readGatingConfig(): Promise<{ hideTradesWhenCbOpen: boolean }> {
    const DEFAULTS = { hideTradesWhenCbOpen: true };
    if (!this.kv) return DEFAULTS;
    try {
      const raw = await this.kv.get('gating.hide_trades_when_cb_open');
      return { hideTradesWhenCbOpen: raw !== 'false' }; // strict: only literal 'false' disables
    } catch {
      return DEFAULTS;
    }
  }

  /**
   * F6-s4: Computes the visible tool subset for the LLM [TOOL SCHEMA].
   * NEVER throws — any error returns effectiveTools unchanged (fail-safe: show all; validate guards).
   *
   * Short-circuit: if no tool has plugin_type === 'provider', skip BOTH KV reads and return effectiveTools.
   * Otherwise:
   *   - Read 'scheduler:circuit_breaker' KV → JSON.parse → state === 'open' (try/catch → false).
   *   - Read gating config.
   *   - hide = (cfg.hideTradesWhenCbOpen && cbOpen) || virtual_only === true
   *   - If hide → filter(plugin_type !== 'provider'), else → return same ref (byte-identical).
   */
  private async _computeVisibleTools(
    effectiveTools: import('../plugins/plugins.service').ProviderTool[],
    virtual_only?: boolean,
  ): Promise<import('../plugins/plugins.service').ProviderTool[]> {
    try {
      // Short-circuit: no provider-type tools → skip all KV reads, return identity
      const hasProvider = effectiveTools.some((t) => t.plugin_type === 'provider');
      if (!hasProvider) return effectiveTools;

      let cbOpen = false;
      if (this.kv) {
        try {
          const raw = await this.kv.get('scheduler:circuit_breaker');
          if (raw) {
            const cb = JSON.parse(raw) as { state?: string };
            cbOpen = cb.state === 'open'; // strictly 'open'; half_open/closed/absent → false
          }
        } catch {
          cbOpen = false; // malformed or read error → treat as not-open (fail-safe)
        }
      }

      const gating = await this._readGatingConfig();
      const hide = (gating.hideTradesWhenCbOpen && cbOpen) || virtual_only === true;

      if (!hide) return effectiveTools; // identity → byte-identical schema
      return effectiveTools.filter((t) => t.plugin_type !== 'provider');
    } catch {
      return effectiveTools; // any unexpected error → safe (show all; validation guards)
    }
  }

  /**
   * Reads debate feature configuration from KV with full fail-safe parsing.
   * Mirrors _resolveMaxTurns pattern: any missing key or parse error returns the safe default.
   * The overall default is enabled=false so the feature is inert until explicitly enabled.
   */
  private async _readDebateConfig(): Promise<{
    enabled: boolean;
    minPct: number;
    maxRoles: number;
    failMode: 'allow' | 'block';
  }> {
    const DEFAULTS = { enabled: false, minPct: 0.1, maxRoles: 3, failMode: 'allow' as const };
    if (!this.kv) return DEFAULTS;
    try {
      const [rawEnabled, rawMinPct, rawMaxRoles, rawFailMode] = await Promise.all([
        this.kv.get('debate.enabled'),
        this.kv.get('debate.min_notional_pct'),
        this.kv.get('debate.max_roles'),
        this.kv.get('debate.fail_mode'),
      ]);

      const enabled = rawEnabled === 'true';

      const parsedPct = rawMinPct !== null ? Number(rawMinPct) : NaN;
      const minPct = Number.isFinite(parsedPct) && parsedPct > 0 ? parsedPct : DEFAULTS.minPct;

      const parsedRoles = rawMaxRoles !== null ? Number(rawMaxRoles) : NaN;
      const maxRoles = Number.isFinite(parsedRoles)
        ? Math.min(5, Math.max(1, Math.trunc(parsedRoles)))
        : DEFAULTS.maxRoles;

      const failMode: 'allow' | 'block' = rawFailMode === 'block' ? 'block' : 'allow';

      return { enabled, minPct, maxRoles, failMode };
    } catch {
      return DEFAULTS;
    }
  }

  /**
   * Returns true when the tool call qualifies as high-impact for debate gating.
   *
   * Fast path: promote_pretest is always high-impact (zero I/O).
   * Slow path: provider trade — notional (qty × quote.last) >= equityPctThreshold × equity.
   *
   * FAIL-SOFT: any error (missing qty/symbol, gateway absent, quote/portfolio throws,
   * equity/last ≤ 0) returns false. This method NEVER blocks a normal trade.
   */
  private async _isHighImpact(
    tc: import('../llm/llm.service').ToolCallRequest,
    equityPctThreshold: number,
  ): Promise<boolean> {
    // Fast path — promote_pretest is always high-impact; zero I/O cost.
    if (tc.plugin_id === 'kernel' && tc.function === 'promote_pretest') return true;

    // Provider trade notional check — fail-soft, ANY failure returns false.
    try {
      if (!this.providerGateway) return false;

      const rawQty = tc.args['qty'] ?? tc.args['quantity'];
      const qty = Number(rawQty);
      if (!Number.isFinite(qty) || qty <= 0) return false;

      const symbol = tc.args['symbol'];
      if (typeof symbol !== 'string' || symbol.length === 0) return false;

      const [quote, portfolio] = await Promise.all([
        this.providerGateway.getQuote(null, symbol),
        this.providerGateway.getPortfolio(null),
      ]);

      if (portfolio.equity <= 0) return false;
      if (quote.last <= 0) return false;

      return qty * quote.last >= equityPctThreshold * portfolio.equity;
    } catch {
      return false; // NEVER block a normal trade on data failure
    }
  }

  /**
   * Builds a compressed summary of a tool call for the debate panel prompt.
   * Bounded to ~300 chars so it fits neatly in each role's prompt context.
   */
  private _buildDebateSummary(tc: import('../llm/llm.service').ToolCallRequest): string {
    const symbol = typeof tc.args['symbol'] === 'string' ? tc.args['symbol'] : '';
    const action = typeof tc.args['action'] === 'string' ? tc.args['action'] : '';
    const rawQty = tc.args['qty'] ?? tc.args['quantity'];
    const qty = typeof rawQty === 'string' || typeof rawQty === 'number' ? String(rawQty) : '';
    return `tool:${tc.plugin_id}.${tc.function} symbol:${symbol} action:${action} qty:${qty}`.slice(
      0,
      300,
    );
  }

  /**
   * Runs the debate gate for a single tool call.
   * Returns a `DebateGateResult` indicating whether to skip dispatch (drop=true)
   * or proceed to the existing dispatch chain (drop=false).
   *
   * Extracted from _executeToolCalls to keep cognitive complexity within the sonarjs limit.
   * Only called when `this.debate` is defined — the outer guard ensures that.
   */
  private async _runDebateGate(
    cycle_id: string,
    tc: import('../llm/llm.service').ToolCallRequest,
    decisions: Decision[],
  ): Promise<boolean /* drop */> {
    const cfg = await this._readDebateConfig();
    if (!cfg.enabled) return false;

    const roles = await this.plugins.getActiveDebateRoles();
    if (!roles || roles.length === 0) return false;
    if (!(await this._isHighImpact(tc, cfg.minPct))) return false;

    const clamped = roles.slice(0, cfg.maxRoles);
    await this.audit.log({
      cycle_id,
      event_type: 'debate_started',
      plugin_id: tc.plugin_id,
      meta: { function: tc.function },
    });

    let consensus: DebateConsensus | null = null;
    try {
      // this.debate is guaranteed non-null by the caller
      consensus = await this.debate!.runPanel(this._buildDebateSummary(tc), clamped, cycle_id);
    } catch (e: unknown) {
      await this.audit.log({ cycle_id, event_type: 'debate_skipped', meta: { reason: String(e) } });
      if (cfg.failMode === 'block') {
        decisions.push({ ...tc, allowed: false, reason: 'debate_failed' });
        return true; // drop
      }
      return false; // allow → fall through to normal dispatch
    }

    if (!consensus) return false;

    for (const s of consensus.stances) {
      await this.audit.log({ cycle_id, event_type: 'debate_stance', meta: { ...s } });
    }
    await this.audit.log({ cycle_id, event_type: 'debate_consensus', meta: { ...consensus } });

    if (consensus.recommendation === 'reject') {
      decisions.push({ ...tc, allowed: false, reason: 'debate_rejected' });
      return true; // drop — promote_pretest: _kernelPromotePretest NEVER called
    }

    return false; // approved → fall through to normal dispatch
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
        // ── DEBATE GATE — additive; short-circuits to byte-identical legacy path when off.
        // Fully nested under `if (this.debate)` — when @Optional resolves to undefined
        // (every existing test + production with feature off) this is a single falsy check:
        // zero awaits, zero audits, zero allocations. The existing dispatch runs unchanged.
        if (this.debate && (await this._runDebateGate(cycle_id, tc, decisions))) {
          continue;
        }
        // ↓↓↓ EXISTING dispatch — UNCHANGED ↓↓↓

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

          // HITL: a successful `decision.emit_trade_intent` becomes a persisted
          // pending TradeIntent (paper-only) awaiting human approval. Fail-soft —
          // recording must NEVER break the cycle, and is a no-op when the service
          // is not injected.
          if (
            this.tradeIntent &&
            res.ok &&
            tc.plugin_id === 'decision' &&
            tc.function === 'emit_trade_intent'
          ) {
            try {
              await this.tradeIntent.recordIntent({
                cycle_id,
                symbol,
                action,
                confidence: Number(args['confidence']) || 0,
                rationale: typeof args['rationale'] === 'string' ? args['rationale'] : '',
                timeframe: typeof args['timeframe'] === 'string' ? args['timeframe'] : undefined,
              });
            } catch (e: unknown) {
              this.log.warn(
                `recordIntent falló (no bloquea el ciclo): ${e instanceof Error ? e.message : String(e)}`,
              );
            }
          }
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

  /**
   * Renders the PRETEST COMPARE section string from a compare result.
   * Returns '(no pretest portfolios)' when the result has zero portfolios,
   * avoiding a confusing empty `winner_return: winner_risk_adj:` line.
   */
  private _renderPretestCompare(
    cmp: import('../pretest/pretest.service').PretestCompare,
    cap: number,
  ): string {
    if (cmp.portfolios.length === 0) {
      return '(no pretest portfolios)';
    }
    const top5 = cmp.portfolios.slice(0, 5);
    const portfolioLines = top5
      .map((p) => {
        const ret =
          typeof p.return_pct === 'number' ? p.return_pct.toFixed(2) : String(p.return_pct);
        return `${p.name}: return=${ret}% gate=${String(p.gate_status)}`;
      })
      .join('\n');
    const header = `winner_return:${cmp.winner_by_return} winner_risk_adj:${cmp.winner_by_risk_adj}`;
    return (header + '\n' + portfolioLines).slice(0, cap);
  }

  /** Build the [LESSONS] section string, or null if no lessons or LTM absent. Fail-soft. */
  private async _buildLessonsSection(cap: number): Promise<string | null> {
    if (!this.longTermMemory) return null;
    try {
      const lessons = await this.longTermMemory.listLessons(3);
      if (lessons.length === 0) return null;
      return lessons
        .map((l, i) => `${String(i + 1)}. ${l.text}`)
        .join('\n')
        .slice(0, cap);
    } catch {
      return null;
    }
  }

  /** Build the [PAST EPISODES] section string, or null if no hits or LTM absent. Fail-soft. */
  private async _buildPastEpisodesSection(
    auditEntries: Array<{ event_type: string; symbol?: string | null }>,
    cap: number,
  ): Promise<string | null> {
    if (!this.longTermMemory) return null;
    try {
      const recentSymbols = auditEntries
        .filter((e) => e.event_type === 'signal' || e.event_type === 'cycle_complete')
        .map((e) => e.symbol)
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .slice(0, 5);
      const query = recentSymbols.join(' ') || 'market';
      const episodes = await this.longTermMemory.prefetch(query, 2);
      if (episodes.length === 0) return null;
      return episodes
        .map(
          (ep) =>
            `[${ep.cycle_id}] ${ep.action_summary} | P&L:${ep.outcome_pnl ?? 'pending'} | ${ep.llm_rationale}`,
        )
        .join('\n')
        .slice(0, cap);
    } catch {
      return null;
    }
  }

  /** Render a single param entry: 'pluginId.param(type,constraints)=currentVal'. */
  private _renderParamLine(
    pluginId: string,
    paramName: string,
    spec: ConfigFieldSpec,
    currentConfig: Record<string, unknown>,
  ): string {
    const constraints: string[] = [spec.type];
    if (spec.min !== undefined && spec.max !== undefined) {
      constraints.push(`${spec.min}..${spec.max}`);
    } else if (spec.enum) {
      constraints.push(spec.enum.join('|'));
    }
    const rawVal = currentConfig[paramName] ?? spec.default ?? '';
    const currentVal =
      typeof rawVal === 'object'
        ? JSON.stringify(rawVal)
        : `${rawVal as string | number | boolean}`;
    return `${pluginId}.${paramName}(${constraints.join(',')})=${currentVal}`;
  }

  /**
   * Build the [TUNABLE PARAMS] section string, or null if no active skill has a config schema.
   * Enumerates each param as 'plugin_id.param(type,min..max)=current_value'.
   * Fail-soft: per-plugin errors silently skip that plugin; section omitted when nothing renders.
   */
  private async _buildTunableParamsSection(cap: number): Promise<string | null> {
    try {
      const allActive = await this.plugins.findActive();
      const skillPlugins = allActive.filter((p) => p.type === 'skill');
      const paramLines: string[] = [];
      for (const plugin of skillPlugins) {
        try {
          const schema = await this.plugins.getConfigSchema(plugin.id);
          if (!schema) continue;
          const currentConfig = plugin.config ?? {};
          for (const [paramName, spec] of Object.entries(schema)) {
            paramLines.push(this._renderParamLine(plugin.id, paramName, spec, currentConfig));
          }
        } catch {
          // Per-plugin error: skip this plugin silently
        }
      }
      if (paramLines.length === 0) return null;
      return paramLines.join('\n').slice(0, cap);
    } catch {
      return null;
    }
  }

  /**
   * Build the [PARAM LOCK STATUS] section string, or null if param-discipline is inactive.
   * Calls sandbox check_lock per tunable skill plugin. Read-only — never mutates state.
   * Fail-soft: per-plugin check_lock errors silently skip that plugin.
   */
  private async _buildParamLockStatusSection(cap: number): Promise<string | null> {
    try {
      const allActive = await this.plugins.findActive();
      const disciplinePlugin = allActive.find((p) => p.id === 'param-discipline');
      if (!disciplinePlugin) return null;
      const disciplineConfig = disciplinePlugin.config ?? {};
      const rawJournal = this.kv ? await this.kv.get('param:journal') : null;
      const journal: unknown[] = rawJournal ? (JSON.parse(rawJournal) as unknown[]) : [];
      const tunableSkills = allActive.filter((p) => p.type === 'skill');
      const lockLines: string[] = [];
      for (const plugin of tunableSkills) {
        try {
          const lockRes = await this.sandbox.callPlugin('param-discipline', 'check_lock', {
            plugin_id: plugin.id,
            journal,
            config: disciplineConfig,
          });
          const result = lockRes.result as { locked?: boolean; cycles_remaining?: number };
          if (result?.locked) {
            lockLines.push(`${plugin.id}: locked(${result.cycles_remaining ?? '?'} cycles left)`);
          } else {
            lockLines.push(`${plugin.id}: unlocked`);
          }
        } catch {
          // Per-plugin check_lock error: skip this plugin silently
        }
      }
      if (lockLines.length === 0) return null;
      return lockLines.join('\n').slice(0, cap);
    } catch {
      return null;
    }
  }

  /**
   * Build the [CURRENT REGIME] section string, or null if no regime signal in audit entries.
   * Scans already-fetched auditEntries for the most recent signal with volatility_regime meta.
   * Fail-soft: JSON parse errors or missing fields are silently ignored.
   * The cap applies to the rendered content only; caller must account for the section header.
   */
  private _buildCurrentRegimeSection(
    auditEntries: Array<{ event_type: string; meta?: string | null }>,
    contentCap: number,
  ): string | null {
    try {
      const regimeEntry = [...auditEntries].reverse().find((e) => {
        if (e.event_type !== 'signal' || !e.meta) return false;
        try {
          const parsed = JSON.parse(e.meta) as Record<string, unknown>;
          return Boolean(parsed.volatility_regime);
        } catch {
          return false;
        }
      });
      if (!regimeEntry?.meta) return null;
      const parsed = JSON.parse(regimeEntry.meta) as Record<string, unknown>;
      const toStr = (v: unknown): string =>
        v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v);
      const regime = typeof parsed.regime !== 'undefined' ? toStr(parsed.regime) : '';
      const vix = typeof parsed.vix !== 'undefined' ? toStr(parsed.vix) : '';
      const description =
        typeof parsed.description !== 'undefined' ? toStr(parsed.description) : '';
      const regimeLine = [
        regime ? `regime: ${regime}` : '',
        vix ? `vix: ${vix}` : '',
        description ? `description: ${description}` : '',
      ]
        .filter(Boolean)
        .join(', ');
      return regimeLine.slice(0, contentCap) || null;
    } catch {
      return null;
    }
  }

  /** Build the [AUDIT RECENT] section string from already-fetched audit entries. Fail-soft. */
  private _buildAuditSection(
    auditEntries: Array<{ event_type: string; symbol?: string | null; action?: string | null }>,
    cap: number,
  ): string {
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
      return lines.join('\n').slice(0, cap);
    } catch {
      return '(unavailable)';
    }
  }

  private async _assembleReflectionContext(): Promise<string> {
    // PR2 (adaptive-parameters): raised from 4000 to 5000 to accommodate 3 new sections.
    // Cap arithmetic: AUDIT700+EQUITY250+VETO550+PRETEST700+LESSONS600+PAST800=3600
    //   + TUNABLE600+LOCK400+REGIME200 = 1200 → total cap 4800 ≤ 5000 (headroom 200).
    const BUDGET = 5000;
    // PR3: reduced proportionally to make room for [LESSONS] (600) + [PAST EPISODES] (800).
    // Old caps: AUDIT=1200, EQUITY=400, VETO=800, PRETEST=1200 → total 3600.
    // New caps: AUDIT=700, EQUITY=250, VETO=550, PRETEST=700 → total 2200.
    // New sections: LESSONS=600, PAST_EPISODES=800 → 1400.
    // Grand total cap budget: 2200 + 1400 = 3600 + section labels/separators fits within 4000.
    const AUDIT_CAP = 700;
    const EQUITY_CAP = 250;
    const VETO_CAP = 550;
    const PRETEST_CAP = 700;
    const LESSONS_CAP = 600;
    const PAST_EPISODES_CAP = 800;
    // PR2 new section caps
    const TUNABLE_PARAMS_CAP = 600;
    const PARAM_LOCK_STATUS_CAP = 400;
    const REGIME_CAP = 200;

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
    const auditSection = auditQueryFailed
      ? '(unavailable)'
      : this._buildAuditSection(auditEntries, AUDIT_CAP);

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
        pretestSection = this._renderPretestCompare(cmp, PRETEST_CAP);
      }
    } catch {
      pretestSection = '(unavailable)';
    }

    // Section: LESSONS — top-3 curated lessons from lesson_memory
    const lessonsSection = await this._buildLessonsSection(LESSONS_CAP);

    // Section: PAST EPISODES — top-2 prefetch hits (using recent symbol query from audit)
    const pastEpisodesSection = await this._buildPastEpisodesSection(
      auditEntries,
      PAST_EPISODES_CAP,
    );

    // Section: TUNABLE PARAMS (cap 600) — LLM action space: active skill params with type/constraints/current.
    const tunableParamsSection = await this._buildTunableParamsSection(TUNABLE_PARAMS_CAP);

    // Section: PARAM LOCK STATUS (cap 400) — per-plugin lock state via param-discipline check_lock.
    const paramLockStatusSection = await this._buildParamLockStatusSection(PARAM_LOCK_STATUS_CAP);

    // Section: CURRENT REGIME (cap 200) — most recent volatility_regime signal from audit.
    // Cap accounts for '[CURRENT REGIME]\n' header (17 chars) so total section ≤ REGIME_CAP.
    const REGIME_HEADER_LEN = '[CURRENT REGIME]\n'.length;
    const regimeAuditEntries = auditQueryFailed ? [] : auditEntries;
    const currentRegimeSection = this._buildCurrentRegimeSection(
      regimeAuditEntries,
      REGIME_CAP - REGIME_HEADER_LEN,
    );

    // Assemble: fixed sections first, then optional sections filtered from null.
    const parts: string[] = [
      `[AUDIT RECENT]\n${auditSection}`,
      `[EQUITY CURVE]\n${equitySection}`,
      `[VETO SUMMARY]\n${vetoSection}`,
      `[PRETEST COMPARE]\n${pretestSection}`,
    ];
    const optionalSections: Array<[string, string | null]> = [
      ['[LESSONS]', lessonsSection],
      ['[PAST EPISODES]', pastEpisodesSection],
      ['[TUNABLE PARAMS]', tunableParamsSection],
      ['[PARAM LOCK STATUS]', paramLockStatusSection],
      ['[CURRENT REGIME]', currentRegimeSection],
    ];
    for (const [header, content] of optionalSections) {
      if (content !== null) parts.push(`${header}\n${content}`);
    }

    const assembled = parts.join('\n\n');

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
