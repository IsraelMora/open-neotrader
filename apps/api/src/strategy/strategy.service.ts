import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { KvService } from '../common/kv.service';

/**
 * Claves KV que constituyen una "estrategia" (perfil de configuración del ciclo).
 *
 * Una estrategia es un bundle nombrado de estos parámetros. Capturamos solo las claves
 * que afectan el comportamiento de un ciclo de trading — NO secretos ni estado interno
 * (store.publisher.*, scheduler runtime, etc.).
 */
export const STRATEGY_CONFIG_KEYS = [
  // Entradas del ciclo
  'cycle.universe',
  'cycle.data_provider',
  'cycle.timeframe',
  'cycle.bars',
  'cycle.capital',
  // Política de ejecución
  'execution.autonomous',
  'execution.real',
  'execution.broker_plugin_id',
  'execution.max_position_pct',
  'execution.max_open_positions',
  'execution.max_drawdown_halt_pct',
  'execution.max_order_notional',
  // LLM
  'llm.backend',
  'llm.model',
  // ReAct
  'react.max_turns',
  // Debate
  'debate.enabled',
  'debate.fail_mode',
  'debate.max_roles',
  'debate.min_notional_pct',
] as const;

/** test = usa data real pero NO coloca órdenes (mide resultados); live = opera de verdad. */
export type StrategyMode = 'test' | 'live';
export const STRATEGY_MODES: readonly StrategyMode[] = ['test', 'live'];

export interface StrategyDto {
  id: string;
  name: string;
  description: string | null;
  config: Record<string, string>;
  active: boolean;
  mode: StrategyMode;
  created_at: Date;
  updated_at: Date;
}

interface StrategyRow {
  id: string;
  name: string;
  description: string | null;
  config: string;
  active: boolean;
  mode: string;
  created_at: Date;
  updated_at: Date;
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}

@Injectable()
export class StrategyService {
  constructor(
    private readonly db: PrismaService,
    private readonly kv: KvService,
  ) {}

  /** Lee el snapshot actual de las claves de estrategia desde el KV global. */
  async captureCurrentConfig(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    await Promise.all(
      STRATEGY_CONFIG_KEYS.map(async (k) => {
        const v = await this.kv.get(k);
        if (v !== null) out[k] = v;
      }),
    );
    return out;
  }

  private toDto(row: StrategyRow): StrategyDto {
    let config: Record<string, string> = {};
    try {
      config = JSON.parse(row.config) as Record<string, string>;
    } catch {
      config = {};
    }
    const mode: StrategyMode = row.mode === 'live' ? 'live' : 'test';
    return { ...row, config, mode };
  }

  async list(): Promise<StrategyDto[]> {
    const rows = (await this.db.strategy.findMany({
      orderBy: { created_at: 'desc' },
    })) as StrategyRow[];
    return rows.map((r) => this.toDto(r));
  }

  async get(id: string): Promise<StrategyDto> {
    const r = await this.db.strategy.findUnique({ where: { id } });
    if (!r) throw new NotFoundException(`Estrategia ${id} no existe`);
    return this.toDto(r);
  }

  /** Crea una estrategia. Si no se pasa `config`, captura la configuración actual del KV. */
  async create(input: {
    name: string;
    description?: string | null;
    config?: Record<string, string>;
    mode?: StrategyMode;
  }): Promise<StrategyDto> {
    const config = input.config ?? (await this.captureCurrentConfig());
    try {
      const r = await this.db.strategy.create({
        data: {
          name: input.name,
          description: input.description ?? null,
          config: JSON.stringify(config),
          mode: input.mode ?? 'test',
        },
      });
      return this.toDto(r);
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictException(`Ya existe una estrategia llamada "${input.name}"`);
      }
      throw e;
    }
  }

  async update(
    id: string,
    patch: {
      name?: string;
      description?: string | null;
      config?: Record<string, string>;
      mode?: StrategyMode;
    },
  ): Promise<StrategyDto> {
    await this.get(id);
    const data: Record<string, unknown> = {};
    if (patch.name !== undefined) data['name'] = patch.name;
    if (patch.description !== undefined) data['description'] = patch.description;
    if (patch.config !== undefined) data['config'] = JSON.stringify(patch.config);
    if (patch.mode !== undefined) data['mode'] = patch.mode;
    try {
      const r = await this.db.strategy.update({ where: { id }, data });
      return this.toDto(r);
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictException(`Ya existe una estrategia llamada "${patch.name ?? ''}"`);
      }
      throw e;
    }
  }

  async remove(id: string): Promise<void> {
    await this.get(id);
    await this.db.strategy.delete({ where: { id } });
  }

  async setActive(id: string, active: boolean): Promise<StrategyDto> {
    await this.get(id);
    const r = await this.db.strategy.update({
      where: { id },
      data: { active },
    });
    return this.toDto(r);
  }

  /** Aplica la config de la estrategia al KV global (la vuelve la configuración activa). */
  async apply(id: string): Promise<{ applied: string[] }> {
    const s = await this.get(id);
    const applied: string[] = [];
    for (const [k, v] of Object.entries(s.config)) {
      await this.kv.set(k, v);
      applied.push(k);
    }
    return { applied };
  }
}
