import { ConflictException, Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { AgentsService, ReflectionTurnResult } from '../agents/agents.service';
import { SandboxGateway } from '../sandbox/sandbox.gateway';
import { PluginsService } from '../plugins/plugins.service';
import { PluginEventsService } from '../plugins/plugin-events.service';
import { AuditService } from '../audit/audit.service';
import { PanelService } from '../panel/panel.service';
import { SnapshotService } from '../snapshot/snapshot.service';

/** Estado en memoria del último ciclo ejecutado: si está corriendo ahora y el resultado previo. */
export interface RunState {
  running: boolean;
  last: { ok: boolean; dry_run: boolean; started_at: string; error?: string } | null;
}

/**
 * Owns the cycle-execution concern extracted from PanelService (F5 Slice 2).
 * Holds the in-memory running lock and all cycle/reflect methods verbatim.
 * PanelService retains appendLog; this service injects PanelService via forwardRef.
 */
@Injectable()
export class CycleExecutorService {
  private readonly log = new Logger(CycleExecutorService.name);
  private runState: RunState = { running: false, last: null };

  constructor(
    private readonly agents: AgentsService,
    private readonly sandbox: SandboxGateway,
    private readonly plugins: PluginsService,
    private readonly pluginEvents: PluginEventsService,
    private readonly audit: AuditService,
    @Inject(forwardRef(() => PanelService))
    private readonly panel: PanelService,
    private readonly snapshot: SnapshotService,
  ) {}

  /** Devuelve el estado en memoria del ciclo actual (sincrono, sin I/O). */
  getRunStatus() {
    return this.runState;
  }

  // ── Cycle ─────────────────────────────────────────────────────────────────

  /**
   * Lanza un ciclo del agente de forma asíncrona.
   * Devuelve inmediatamente con {accepted: true} si no hay otro ciclo en curso.
   * Si `dryRun` es true, solo ejecuta plugins sin llamar al LLM.
   */
  runCycle(dryRun: boolean, prompt?: string): { accepted: boolean; message: string } {
    if (this.runState.running) return { accepted: false, message: 'Ya hay un ciclo en curso' };
    this.runState.running = true;
    const startedAt = new Date().toISOString();
    const cycleId = crypto.randomUUID();
    this.pluginEvents.emit('cycle.started', { started_at: startedAt, dry_run: dryRun });
    void this.audit.log({
      cycle_id: cycleId,
      event_type: 'cycle_start',
      meta: { dry_run: dryRun, prompt },
    });
    this.executeCycle(dryRun, startedAt, cycleId, prompt).catch((err) =>
      this.log.error('Error en ciclo', err),
    );
    return { accepted: true, message: dryRun ? 'Ciclo dry-run iniciado' : 'Ciclo iniciado' };
  }

  private async executeCycle(dryRun: boolean, startedAt: string, cycleId: string, prompt?: string) {
    try {
      let decisions = 0;
      let skillsRead: string[] = [];
      let skillsWritten: string[] = [];
      let llmText: string | undefined;

      if (dryRun) {
        const active = await this.plugins.findActive();
        const res = await this.sandbox.runCycle(
          active.map((p) => p.id),
          { dry_run: true, started_at: startedAt },
        );
        this.runState.last = { ok: res.ok, dry_run: true, started_at: startedAt, error: res.error };
      } else {
        const context = prompt ?? startedAt;
        const result = await this.agents.runCycle(context, undefined, cycleId);
        decisions = result.decisions.length;
        skillsRead = result.llm_response?.skills_read ?? [];
        skillsWritten = result.llm_response?.skills_written ?? [];
        llmText = result.llm_text;
        this.runState.last = { ok: true, dry_run: false, started_at: startedAt };
        this.log.log(`Ciclo completado: ${decisions} decisiones`);
      }

      this.pluginEvents.emit('cycle.completed', {
        started_at: startedAt,
        dry_run: dryRun,
        decisions,
        skills_read: skillsRead,
        skills_written: skillsWritten,
      });

      // nav-data-collection F1: take a NAV snapshot at the end of every completed cycle.
      // Fail-soft: any error is caught here and NEVER breaks the cycle.
      try {
        await this.snapshot.takeSnapshot(cycleId);
      } catch (e) {
        this.log.warn(`[NAV] takeSnapshot failed for cycle ${cycleId} — snapshot not taken: ${e}`);
      }

      await this.panel.appendLog('agent_cycles', {
        ok: this.runState.last?.ok,
        dry_run: dryRun,
        started_at: startedAt,
        decisions,
      });
      void this.audit.log({
        cycle_id: cycleId,
        event_type: 'cycle_complete',
        llm_text: llmText,
        signals_count: decisions,
        skills_read: skillsRead,
        skills_written: skillsWritten,
        sandbox_ok: true,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.runState.last = { ok: false, dry_run: dryRun, started_at: startedAt, error: msg };
      this.pluginEvents.emit('cycle.failed', { started_at: startedAt, error: msg });
      await this.panel.appendLog('agent_cycles', {
        ok: false,
        dry_run: dryRun,
        started_at: startedAt,
        error: msg,
      });
      void this.audit.log({ cycle_id: cycleId, event_type: 'cycle_fail', error: msg });
    } finally {
      this.runState.running = false;
    }
  }

  // ── F4-S2: Manual reflection trigger ──────────────────────────────────────

  /**
   * Triggers a reflection turn immediately, bypassing the cadence check.
   * Guards against concurrent execution: throws 409 ConflictException if a cycle
   * (or another reflection) is currently running.
   *
   * F4-s2 lock preserved exactly: sync check → set running=true → try/await → finally clear.
   */
  async reflectNow(): Promise<ReflectionTurnResult> {
    if (this.runState.running) {
      throw new ConflictException(
        'A cycle is currently running — reflection cannot start concurrently',
      );
    }
    this.runState.running = true;
    try {
      return await this.agents.runReflectionTurn();
    } finally {
      this.runState.running = false;
    }
  }
}
