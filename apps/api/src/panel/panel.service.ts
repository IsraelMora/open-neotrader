import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AgentsService } from '../agents/agents.service';
import { LlmService } from '../llm/llm.service';
import { SandboxGateway } from '../sandbox/sandbox.gateway';
import { PluginsService } from '../plugins/plugins.service';
import { PluginEventsService } from '../plugins/plugin-events.service';
import { AuditService } from '../audit/audit.service';
import { UniverseEditDto } from './dto/universe-edit.dto';

export interface RunState {
  running: boolean;
  last: { ok: boolean; dry_run: boolean; started_at: string; error?: string } | null;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

// Log stream names: cualquier slug de letras minúsculas, números y guiones bajos
const VALID_LOG_STREAM = /^[a-z][a-z0-9_]{0,63}$/;

@Injectable()
export class PanelService {
  private readonly log = new Logger(PanelService.name);
  private runState: RunState = { running: false, last: null };

  constructor(
    private readonly db: PrismaService,
    private readonly agents: AgentsService,
    private readonly llm: LlmService,
    private readonly sandbox: SandboxGateway,
    private readonly plugins: PluginsService,
    private readonly pluginEvents: PluginEventsService,
    private readonly audit: AuditService,
  ) {}

  // ── Config ────────────────────────────────────────────────────────────────

  async getConfig(): Promise<Record<string, JsonValue>> {
    const entries = await this.db.configEntry.findMany();
    return Object.fromEntries(
      entries.map((e) => {
        try {
          return [e.key, JSON.parse(e.value) as JsonValue];
        } catch {
          return [e.key, e.value];
        }
      }),
    );
  }

  async saveConfig(cfg: Record<string, unknown>): Promise<Record<string, JsonValue>> {
    for (const [key, value] of Object.entries(cfg)) {
      await this.db.configEntry.upsert({
        where: { key },
        update: { value: JSON.stringify(value) },
        create: { key, value: JSON.stringify(value) },
      });
    }
    return this.getConfig();
  }

  async deleteConfigKey(key: string): Promise<void> {
    await this.db.configEntry.deleteMany({ where: { key } });
  }

  private async getCfgKey<T>(key: string, fallback: T): Promise<T> {
    const e = await this.db.configEntry.findUnique({ where: { key } });
    if (!e) return fallback;
    try {
      return JSON.parse(e.value) as T;
    } catch {
      return e.value as unknown as T;
    }
  }

  private async setCfgJson(key: string, value: unknown): Promise<void> {
    const v = JSON.stringify(value);
    await this.db.configEntry.upsert({
      where: { key },
      update: { value: v },
      create: { key, value: v },
    });
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  async getStatus() {
    const activePlugins = await this.plugins.findActive();
    const portfolios = await this.db.portfolio.findMany({ orderBy: { updatedAt: 'desc' } });
    return {
      active_plugins: activePlugins.map((p) => ({ id: p.id, name: p.name, type: p.type })),
      portfolios: Object.fromEntries(
        portfolios.map((p) => {
          try {
            return [p.name, JSON.parse(p.data) as unknown];
          } catch {
            return [p.name, {}];
          }
        }),
      ),
      last_run: this.runState.last,
    };
  }

  getRunStatus() {
    return this.runState;
  }

  // ── Cycle ─────────────────────────────────────────────────────────────────

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
        const result = await this.agents.runCycle(context);
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
      await this.appendLog('agent_cycles', {
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
      await this.appendLog('agent_cycles', {
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

  // ── Chat ──────────────────────────────────────────────────────────────────

  async chat(question: string, history?: unknown[]) {
    const context = history ? `${JSON.stringify(history)}\n\n${question}` : question;
    const res = await this.llm.complete({ context });
    return { response: res.text, tool_calls: res.tool_calls, backend: res.backend };
  }

  // ── Doctor ────────────────────────────────────────────────────────────────

  async doctor() {
    const [plugins, sandboxRes] = await Promise.all([
      this.plugins.findAll(),
      this.sandbox.call({ cmd: 'list_plugins', active_ids: [] }).catch(() => null),
    ]);
    return {
      ok: true,
      plugins_registered: plugins.length,
      plugins_active: plugins.filter((p) => p.active).length,
      sandbox_reachable: sandboxRes?.ok ?? false,
      timestamp: new Date().toISOString(),
    };
  }

  // ── Portfolios ────────────────────────────────────────────────────────────
  // Genérico: devuelve todos los portfolios que los plugins hayan escrito en la BD.

  async getPortfolios() {
    const portfolios = await this.db.portfolio.findMany({ orderBy: { updatedAt: 'desc' } });
    if (portfolios.length === 0) return {};
    return Object.fromEntries(
      portfolios.map((p) => {
        try {
          return [p.name, JSON.parse(p.data) as unknown];
        } catch {
          return [p.name, p.data];
        }
      }),
    );
  }

  // ── Notifications ─────────────────────────────────────────────────────────

  async getNotifications() {
    const doctorData = await this.doctor();
    const items: { level: string; title: string; source: string; body: string; ts: string }[] = [];

    if (!doctorData.sandbox_reachable) {
      items.push({
        level: 'warn',
        title: 'Sandbox no disponible',
        source: 'platform',
        body: 'El runner.py no respondió. Los plugins no funcionarán hasta resolver esto.',
        ts: new Date().toISOString(),
      });
    }

    // Los plugins pueden añadir notificaciones escribiendo en config key 'notifications'
    const pluginNotifs = await this.getCfgKey<typeof items>('notifications', []);
    items.push(...pluginNotifs);

    return {
      items,
      n_errors: items.filter((i) => i.level === 'error').length,
      n_warnings: items.filter((i) => i.level === 'warn').length,
    };
  }

  // ── Logs ──────────────────────────────────────────────────────────────────
  // Los plugins deciden qué streams existen escribiendo en 'logs_<stream>'.
  // La plataforma solo valida el formato del nombre para evitar inyección de claves.

  async getLogs(stream: string, limit: number) {
    if (!VALID_LOG_STREAM.test(stream)) {
      throw new BadRequestException(`nombre de stream inválido: ${JSON.stringify(stream)}`);
    }
    const raw = await this.getCfgKey<unknown[]>(`logs_${stream}`, []);
    return { stream, entries: raw.slice(-Math.max(1, Math.min(limit, 5000))) };
  }

  async appendLog(stream: string, entry: Record<string, unknown>) {
    if (!VALID_LOG_STREAM.test(stream)) {
      throw new BadRequestException(`nombre de stream inválido: ${JSON.stringify(stream)}`);
    }
    const key = `logs_${stream}`;
    const entries = await this.getCfgKey<unknown[]>(key, []);
    entries.push({ ...entry, ts: new Date().toISOString() });
    if (entries.length > 2000) entries.splice(0, entries.length - 2000);
    await this.setCfgJson(key, entries);
  }

  // ── Universe ──────────────────────────────────────────────────────────────
  // La plataforma solo almacena { symbol, kind?, description? }.
  // La validación de si el símbolo existe y qué kind tiene es responsabilidad
  // del plugin provider activo.

  async checkUniverseSymbol(symbol: string) {
    if (!symbol?.trim()) throw new BadRequestException('símbolo vacío');
    const sym = symbol.trim().toUpperCase();
    const cfg = await this.getConfig();
    const universe = (cfg['universe'] as Record<string, unknown>) ?? {};
    const exists = sym in universe;
    return {
      symbol: sym,
      registered: exists,
      meta: exists ? universe[sym] : null,
    };
  }

  async editUniverse(dto: UniverseEditDto) {
    const symbol = dto.symbol.trim().toUpperCase();
    const cfg = await this.getConfig();
    const universe = (cfg['universe'] as Record<string, unknown>) ?? {};

    if (dto.action === 'add') {
      universe[symbol] = {
        ...(dto.kind ? { kind: dto.kind } : {}),
        ...(dto.description ? { description: dto.description } : {}),
      };
    } else {
      delete universe[symbol];
    }

    await this.saveConfig({ universe });
    return { ok: true, symbol, action: dto.action };
  }

  // ── Skills ────────────────────────────────────────────────────────────────
  // Solo lee metadatos de plugins tipo skill — la plataforma no gestiona skills manualmente.

  async getSkills() {
    return this.plugins.getSkillsMetadata();
  }

  // ── Plugins activos por tipo ───────────────────────────────────────────────

  async getActiveByType(type: string) {
    const all = await this.plugins.findActive();
    return { type, plugins: all.filter((p) => p.type === type) };
  }

  // ── NAV / métricas genéricas ───────────────────────────────────────────────
  // Los plugins escriben sus métricas en config keys; el panel las expone tal cual.

  async getMetrics(key: string) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) {
      throw new BadRequestException(`clave de métrica inválida: ${JSON.stringify(key)}`);
    }
    return this.getCfgKey(key, null);
  }
}
