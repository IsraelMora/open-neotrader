import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { LlmService } from '../llm/llm.service';
import { SandboxGateway } from '../sandbox/sandbox.gateway';
import { PluginsService, HydratedPlugin } from '../plugins/plugins.service';
import { ContextMemoryService } from '../context-memory/context-memory.service';
import { AuditService } from '../audit/audit.service';
import { AlertsService, CreateAlertDto } from '../alerts/alerts.service';

import type { LlmResponse } from '../llm/llm.service';

export interface AgentCycleResult {
  cycle_id: string;
  llm_text: string;
  decisions: Decision[];
  sandbox_results: SandboxResult[];
  llm_response: LlmResponse;
  context_injected: boolean;
  veto_summary: VetoSummary;
}

export interface Decision {
  plugin_id: string;
  function: string;
  args: Record<string, unknown>;
  allowed: boolean;
  reason?: string;
}

export interface SandboxResult {
  plugin_id: string;
  function: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface VetoSummary {
  signals_proposed: number;
  signals_approved: number;
  signals_vetoed: number;
  veto_reasons: string[];
  discipline_plugins: string[];
}

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

    // ── 4. LLM: proponer acciones con señales aprobadas en contexto ───────────
    const approvedSignals: unknown[] = Array.isArray(vetoCtx['pending_signals'])
      ? (vetoCtx['pending_signals'] as unknown[])
      : [];

    const signalSummary =
      approvedSignals.length > 0
        ? `\n\n[SEÑALES APROBADAS POR LAS DISCIPLINAS]\n${JSON.stringify(approvedSignals, null, 2)}\n`
        : '\n\n[NO HAY SEÑALES APROBADAS EN ESTE CICLO]\n';

    const llmResponse = await this.llm.complete({
      context: enrichedContext + signalSummary,
      system_prompt: systemPrompt,
    });

    const skills_read = llmResponse.skills_read ?? [];

    await this.audit.log({
      cycle_id,
      event_type: 'cycle_complete',
      llm_text: llmResponse.text?.slice(0, 2000),
      skills_read,
      signals_count: llmResponse.tool_calls.length,
      meta: {
        stage: 'llm_response',
        tools_called: llmResponse.tool_calls.map((t) => `${t.plugin_id}.${t.function}`),
      },
    });

    // ── 5. Ejecutar tool calls aprobadas ──────────────────────────────────────
    const { decisions, sandbox_results, signalsEmitted } = await this._executeToolCalls(
      cycle_id,
      llmResponse.tool_calls,
    );

    // ── 6. Persistir en memoria inter-ciclos ──────────────────────────────────
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
