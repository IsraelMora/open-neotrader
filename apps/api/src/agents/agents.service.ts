import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { LlmService } from '../llm/llm.service';
import { SandboxGateway } from '../sandbox/sandbox.gateway';
import { PluginsService, HydratedPlugin } from '../plugins/plugins.service';
import { ContextMemoryService } from '../context-memory/context-memory.service';
import { AuditService } from '../audit/audit.service';
import { AlertsService, CreateAlertDto } from '../alerts/alerts.service';

import type { LlmResponse } from '../llm/llm.service';
import { parseToolCalls } from '../llm/kernel-parser';

/**
 * Input for a single governed LLM turn. Used by runGovernedTurn for both
 * interactive chat (source='chat') and scheduled cycle delegation (source='cycle').
 */
export interface GovernedTurnInput {
  /** Discriminator: 'chat' emits a chat_turn audit event; 'cycle' skips it (cycle owns its own audit). */
  source: 'chat' | 'cycle';
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
    const decisionPrompt = await this.plugins.getActiveDecisionPrompt();

    let builtSystemPrompt = input.system_prompt ?? '';
    if (decisionPrompt !== null) {
      const toolSchemaJson = JSON.stringify(providerTools);
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
    const validatedCalls = await this._validateToolCalls(
      cycle_id,
      llmResponse.tool_calls,
      providerTools,
      input._activePlugins,
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
    } else if (input.source === 'cycle') {
      // Cycle owns its own audit — nothing to emit here.
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

    // ── 4+5+6. Governed LLM turn (decision prompt + schema injection, llm.complete,
    //            parseToolCalls, _validateToolCalls, _executeToolCalls) ─────────
    // Build signal summary from approved signals after veto, prepend to context.
    const approvedSignals: unknown[] = Array.isArray(vetoCtx['pending_signals'])
      ? (vetoCtx['pending_signals'] as unknown[])
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
   * Validates parsed tool_calls against active plugin manifests.
   * Drops calls whose plugin is not active or whose function is not declared in tools.json.
   * Each dropped call is audited with event_type 'tool_call_dropped' and a specific reason.
   * Returns only valid calls. Never throws.
   *
   * @param preloadedActivePlugins - When provided (cycle path), skips the findActive() DB call.
   */
  private async _validateToolCalls(
    cycle_id: string,
    calls: import('../llm/llm.service').ToolCallRequest[],
    hoistedTools?: import('../plugins/plugins.service').ProviderTool[],
    preloadedActivePlugins?: import('../plugins/plugins.service').HydratedPlugin[],
  ): Promise<import('../llm/llm.service').ToolCallRequest[]> {
    if (calls.length === 0) return [];

    try {
      // Use pre-fetched plugins when available (cycle path) to avoid a second DB round-trip.
      const activePlugins = preloadedActivePlugins ?? (await this.plugins.findActive());
      const activeIds = new Set(activePlugins.map((p: HydratedPlugin) => p.id));
      // Use hoisted tools when provided (from _executeCycle) to avoid a second DB round-trip.
      const providerTools = hoistedTools ?? (await this.plugins.getProviderTools());
      const validToolNames = new Set(providerTools.map((t) => t.name)); // "pluginId__fn"

      const valid: import('../llm/llm.service').ToolCallRequest[] = [];

      for (const call of calls) {
        let reason: string | null = null;

        if (!activeIds.has(call.plugin_id)) {
          // Unknown plugin (never registered/installed) vs inactive (registered but disabled).
          // Both cases where the plugin is not found in active set.
          const isKnownPlugin = providerTools.some((t) => t.plugin_id === call.plugin_id);
          reason = isKnownPlugin ? 'plugin_inactive' : 'plugin_not_found';
        } else if (!validToolNames.has(`${call.plugin_id}__${call.function}`)) {
          reason = 'function_not_declared';
        }

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
      return [];
    }
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
