import { BadRequestException, Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AgentsService } from '../agents/agents.service';
import { LlmService } from '../llm/llm.service';
import { SandboxGateway } from '../sandbox/sandbox.gateway';
import { PluginsService } from '../plugins/plugins.service';
import { PluginEventsService } from '../plugins/plugin-events.service';
import { AuditService } from '../audit/audit.service';
import { UniverseEditDto } from './dto/universe-edit.dto';
import { CycleExecutorService } from '../cycle/cycle-executor.service';
import { ProviderGatewayService } from '../providers/provider-gateway.service';
import { REAL_EXECUTION_HALTED_KEY } from '../common/real-execution-halt.util';
import { kvBool } from '../common/kv.util';

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

// Log stream names: cualquier slug de letras minúsculas, números y guiones bajos
const VALID_LOG_STREAM = /^[a-z][a-z0-9_]{0,63}$/;

/** Un chequeo de salud individual reportado en `doctor().checks`. */
export interface CheckItem {
  name: string;
  ok: boolean;
  level: 'error' | 'warn' | 'ok';
  detail?: string;
}

/** Fachada principal del panel: config, estado del agente, ciclos, chat, portfolios, logs y universo de activos. */
@Injectable()
export class PanelService {
  private readonly log = new Logger(PanelService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly agents: AgentsService,
    private readonly llm: LlmService,
    private readonly sandbox: SandboxGateway,
    private readonly plugins: PluginsService,
    private readonly pluginEvents: PluginEventsService,
    private readonly audit: AuditService,
    @Inject(forwardRef(() => CycleExecutorService))
    private readonly cycleExecutor: CycleExecutorService,
    private readonly gateway: ProviderGatewayService,
  ) {}

  // ── Config ────────────────────────────────────────────────────────────────

  /** Devuelve todos los pares clave-valor del config store, parseados como JSON cuando es posible. */
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

  /** Persiste (upsert) un conjunto de claves en el config store y devuelve el estado completo. */
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

  /** Elimina una clave del config store. */
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

  /** Devuelve el estado general: plugins activos, portfolios y último ciclo. */
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
      last_run: this.cycleExecutor.getRunStatus().last,
    };
  }

  // ── Chat ──────────────────────────────────────────────────────────────────

  /** Envía una pregunta al LLM con historial opcional y devuelve la respuesta. */
  async chat(question: string, history?: unknown[]) {
    const context = history ? `${JSON.stringify(history)}\n\n${question}` : question;
    const r = await this.agents.runGovernedTurn({ source: 'chat', context });
    return { response: r.text, tool_calls: r.tool_calls, backend: r.backend };
  }

  // ── Doctor ────────────────────────────────────────────────────────────────

  /** Diagnóstico de salud: sandbox alcanzable, plugins registrados y activos. */
  async doctor() {
    const [plugins, sandboxRes, haltedRow] = await Promise.all([
      this.plugins.findAll(),
      this.sandbox.call({ cmd: 'list_plugins', active_ids: [] }).catch(() => null),
      this.db.configEntry.findUnique({ where: { key: REAL_EXECUTION_HALTED_KEY } }),
    ]);
    const llm = this.llm.getReadiness();
    const pluginsRegistered = plugins.length;
    const pluginsActive = plugins.filter((p) => p.active).length;
    const sandboxReachable = sandboxRes?.ok ?? false;
    const llmReady = llm.credentialPresent;
    const realExecutionHalted = kvBool(haltedRow?.value ?? null, false);

    // Frontend health-card contract: a structured list of individual checks derived
    // from the same flags below (additive — every pre-existing field is untouched).
    const checks: CheckItem[] = [
      {
        name: 'sandbox_reachable',
        ok: sandboxReachable,
        level: sandboxReachable ? 'ok' : 'error',
        ...(sandboxReachable ? {} : { detail: 'El runner.py del sandbox no respondió.' }),
      },
      {
        name: 'llm_ready',
        ok: llmReady,
        level: llmReady ? 'ok' : 'error',
        ...(llmReady ? {} : { detail: llm.detail }),
      },
      {
        name: 'plugins_active',
        ok: pluginsActive > 0,
        level: pluginsActive > 0 ? 'ok' : 'warn',
        ...(pluginsActive > 0
          ? {}
          : { detail: `0 plugins activos de ${pluginsRegistered} registrados.` }),
      },
      {
        name: 'real_execution_halted',
        ok: !realExecutionHalted,
        level: realExecutionHalted ? 'warn' : 'ok',
        ...(realExecutionHalted
          ? { detail: 'El kill-switch de ejecución real está activo (real_execution.halted).' }
          : {}),
      },
    ];

    return {
      ok: true,
      plugins_registered: pluginsRegistered,
      plugins_active: pluginsActive,
      sandbox_reachable: sandboxReachable,
      // Surfaces a missing/misconfigured LLM credential: if false, cycles can't decide
      // or trade. This is the single highest-signal "why isn't it trading" check.
      llm_ready: llmReady,
      llm_backend: llm.backend,
      llm_detail: llm.detail,
      checks,
      timestamp: new Date().toISOString(),
    };
  }

  // ── Portfolios ────────────────────────────────────────────────────────────
  // Genérico: devuelve todos los portfolios que los plugins hayan escrito en la BD.

  /** Devuelve todos los portfolios escritos por plugins como mapa nombre→datos. */
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

  // ── Operaciones (trades ejecutados) ────────────────────────────────────────

  /** Trades ejecutados (desde trade_intents status=executed) para la pantalla Operaciones. */
  async getTrades(limit = 200): Promise<{ trades: unknown[] }> {
    const rows = await this.db.tradeIntent.findMany({
      where: { status: 'executed' },
      orderBy: { decided_at: 'desc' },
      take: limit,
    });
    const trades = rows.map((r) => ({
      ts: (r.decided_at ?? r.created_at).toISOString(),
      cartera: r.mode || 'paper',
      symbol: r.symbol,
      lado: r.action,
      valor: (r.fill_price ?? 0) * (r.quantity ?? 0),
      precio: r.fill_price ?? 0,
      comision: 0,
    }));
    return { trades };
  }

  // ── NAV history (competencia de estrategias) ───────────────────────────────

  /** Series de NAV por estrategia (para la curva de competencia del Dashboard). */
  async getNavHistory(
    limit = 1000,
  ): Promise<{ series: Record<string, { ts: string; nav: number }[]> }> {
    const rows = await this.db.navSnapshot.findMany({
      where: { strategy_id: { not: null } },
      orderBy: { ts: 'asc' },
      take: limit,
      select: { ts: true, equity: true, strategy_id: true },
    });
    const strats = await this.db.strategy.findMany({ select: { id: true, name: true } });
    const nameById: Record<string, string> = {};
    for (const s of strats) nameById[s.id] = s.name;
    const series: Record<string, { ts: string; nav: number }[]> = {};
    for (const r of rows) {
      const key = r.strategy_id ? (nameById[r.strategy_id] ?? r.strategy_id) : 'desconocida';
      if (!series[key]) series[key] = [];
      series[key].push({ ts: r.ts.toISOString(), nav: r.equity });
    }
    return { series };
  }

  // ── Journal / Evidencia (red anti-overfitting) ─────────────────────────────

  /** Estado de disciplina/evidencia: candados de parámetros, gates de pretest y promoción. */
  async getJournal(): Promise<Record<string, JsonValue>> {
    const cfg = await this.getConfig();
    const disciplina: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(cfg)) {
      if (
        k.startsWith('param') ||
        k.startsWith('pretest') ||
        k.startsWith('promotion') ||
        k.startsWith('reflection') ||
        k.includes('discipline') ||
        k.includes('lock')
      ) {
        disciplina[k] = v;
      }
    }
    const strategies = await this.db.strategy.count();
    return {
      nota: 'Red anti-overfitting: candados de parámetros, gates de pretest y promoción.',
      estrategias_registradas: strategies,
      disciplina,
    };
  }

  // ── Notifications ─────────────────────────────────────────────────────────

  /** Agrega notificaciones del sistema (sandbox caído) y las de plugins (clave 'notifications'). */
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

    if (!doctorData.llm_ready) {
      items.push({
        level: 'error',
        title: 'LLM sin credencial — el agente no puede operar',
        source: 'platform',
        body: doctorData.llm_detail,
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

  /** Lee las últimas `limit` entradas de un stream de log (clave `logs_<stream>` en config store). */
  async getLogs(stream: string, limit: number) {
    if (!VALID_LOG_STREAM.test(stream)) {
      throw new BadRequestException(`nombre de stream inválido: ${JSON.stringify(stream)}`);
    }
    const raw = await this.getCfgKey<unknown[]>(`logs_${stream}`, []);
    return { stream, entries: raw.slice(-Math.max(1, Math.min(limit, 5000))) };
  }

  /** Añade una entrada a un stream de log. Mantiene máximo 2000 entradas por stream. */
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

  /** Comprueba si un símbolo (normalizado a mayúsculas) existe en el universo de activos configurado. */
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

  /** Añade o elimina un símbolo del universo de activos en el config store. */
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
  // Exposes LLM-callable skill functions from active plugins as a structured list.

  /** Returns the list of LLM-callable tools from active plugins as { from_plugins, n_plugins }. */
  async getSkills() {
    const tools = await this.plugins.getProviderTools();
    const fromPlugins = tools.map((t) => {
      const sep = t.name.indexOf('__');
      const fn = sep >= 0 ? t.name.slice(sep + 2) : t.name;
      return { name: fn, plugin: t.plugin_id, key: `${t.plugin_id}.${fn}` };
    });
    const nPlugins = new Set(tools.map((t) => t.plugin_id)).size;
    return { from_plugins: fromPlugins, n_plugins: nPlugins };
  }

  // ── Plugins activos por tipo ───────────────────────────────────────────────

  /** Filtra los plugins activos por tipo (skill, provider, discipline, universe, stack, extra). */
  async getActiveByType(type: string) {
    const all = await this.plugins.findActive();
    return { type, plugins: all.filter((p) => p.type === type) };
  }

  // ── NAV / métricas genéricas ───────────────────────────────────────────────
  // Los plugins escriben sus métricas en config keys; el panel las expone tal cual.

  /** Lee una métrica del config store por clave. Solo acepta claves en formato snake_case. */
  async getMetrics(key: string) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) {
      throw new BadRequestException(`clave de métrica inválida: ${JSON.stringify(key)}`);
    }
    return this.getCfgKey(key, null);
  }
}
