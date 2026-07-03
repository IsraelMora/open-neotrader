import { Injectable, Logger } from '@nestjs/common';
import { KvService } from '../common/kv.service';

// ── Tipos ────────────────────────────────────────────────────────────────────

export interface Observation {
  ts: string;
  cycle_id: string;
  text: string; // extracto del LLM (≤500 chars)
  signals_count: number;
  skills_read: string[];
}

export interface ContextFlag {
  key: string;
  value: string | number | boolean;
  set_at: string;
  set_by: 'user' | 'llm';
  note?: string;
}

export interface ContextMemory {
  last_updated: string;
  observations: Observation[]; // últimas N observaciones del LLM
  flags: ContextFlag[]; // flags persistentes
  signal_summary: Record<
    string,
    {
      // resumen de señales por símbolo
      last_action: string;
      last_ts: string;
      count: number;
    }
  >;
}

const MEMORY_KEY = 'context:memory';
const MAX_OBSERVATIONS = 20;
const MAX_FLAGS = 50;

const EMPTY_MEMORY: ContextMemory = {
  last_updated: '',
  observations: [],
  flags: [],
  signal_summary: {},
};

// ── Servicio ─────────────────────────────────────────────────────────────────

/** Memoria persistente entre ciclos del agente: observaciones, flags y resumen de señales por símbolo. */
@Injectable()
export class ContextMemoryService {
  private readonly log = new Logger(ContextMemoryService.name);

  constructor(private readonly kv: KvService) {}

  /** Lee el estado completo de la memoria desde el KV store. Devuelve estado vacío si no existe. */
  async get(): Promise<ContextMemory> {
    const raw = await this.kv.get(MEMORY_KEY);
    if (!raw) return { ...EMPTY_MEMORY };
    try {
      return JSON.parse(raw) as ContextMemory;
    } catch {
      return { ...EMPTY_MEMORY };
    }
  }

  /** Persiste el estado de la memoria actualizando `last_updated`. */
  async save(mem: ContextMemory): Promise<void> {
    mem.last_updated = new Date().toISOString();
    await this.kv.set(MEMORY_KEY, JSON.stringify(mem));
  }

  /** Elimina toda la memoria acumulada (irreversible). */
  async reset(): Promise<void> {
    await this.kv.delete(MEMORY_KEY);
    this.log.log('Context memory reseteada');
  }

  /** Añade una observación del ciclo. Mantiene las últimas MAX_OBSERVATIONS. */
  async appendObservation(obs: Omit<Observation, 'ts'>): Promise<void> {
    const mem = await this.get();
    mem.observations.unshift({ ...obs, ts: new Date().toISOString() });
    if (mem.observations.length > MAX_OBSERVATIONS) {
      mem.observations = mem.observations.slice(0, MAX_OBSERVATIONS);
    }
    await this.save(mem);
  }

  /** Registra una señal en el resumen por símbolo. */
  async trackSignal(symbol: string, action: string): Promise<void> {
    const mem = await this.get();
    const prev = mem.signal_summary[symbol];
    mem.signal_summary[symbol] = {
      last_action: action,
      last_ts: new Date().toISOString(),
      count: (prev?.count ?? 0) + 1,
    };
    await this.save(mem);
  }

  /** Setea un flag persistente (usuario o LLM). */
  async setFlag(
    key: string,
    value: string | number | boolean,
    setBy: 'user' | 'llm',
    note?: string,
  ): Promise<void> {
    const mem = await this.get();
    const existing = mem.flags.findIndex((f) => f.key === key);
    const flag: ContextFlag = { key, value, set_at: new Date().toISOString(), set_by: setBy, note };
    if (existing >= 0) {
      mem.flags[existing] = flag;
    } else {
      mem.flags.unshift(flag);
      if (mem.flags.length > MAX_FLAGS) mem.flags = mem.flags.slice(0, MAX_FLAGS);
    }
    await this.save(mem);
  }

  /** Elimina un flag persistente por clave. */
  async deleteFlag(key: string): Promise<void> {
    const mem = await this.get();
    mem.flags = mem.flags.filter((f) => f.key !== key);
    await this.save(mem);
  }

  /**
   * Serializa la memoria como contexto inyectable para el LLM.
   * Devuelve un bloque de texto conciso con las últimas observaciones y flags activos.
   */
  async toContextString(): Promise<string> {
    const mem = await this.get();
    const sections: string[] = [];

    const flagsSection = this.buildFlagsSection(mem.flags);
    if (flagsSection) sections.push(flagsSection);

    const obsSection = this.buildObservationsSection(mem.observations);
    if (obsSection) sections.push(obsSection);

    const signalsSection = this.buildSignalsSection(mem.signal_summary);
    if (signalsSection) sections.push(signalsSection);

    return sections.join('\n');
  }

  private buildFlagsSection(flags: ContextFlag[]): string {
    if (flags.length === 0) return '';
    const lines = ['[FLAGS PERSISTENTES]'];
    for (const f of flags.slice(0, 10)) {
      const note = f.note ? ` (${f.note})` : '';
      lines.push(`  ${f.key}=${JSON.stringify(f.value)}${note}`);
    }
    return lines.join('\n');
  }

  private buildObservationsSection(observations: Observation[]): string {
    if (observations.length === 0) return '';
    const lines = ['[OBSERVACIONES PREVIAS (últimas 5)]'];
    for (const obs of observations.slice(0, 5)) {
      // Defensive: legacy/corrupted KV blobs may be missing fields — coerce
      // before slicing so one malformed observation doesn't crash the cycle.
      const ts = typeof obs.ts === 'string' ? obs.ts : '';
      const cycleId = typeof obs.cycle_id === 'string' ? obs.cycle_id : '';
      const text = typeof obs.text === 'string' ? obs.text : '';
      lines.push(
        `  [${ts.slice(0, 16)}] ciclo=${cycleId.slice(0, 8)} señales=${obs.signals_count}`,
      );
      if (text) lines.push(`    "${text.slice(0, 200)}"`);
    }
    return lines.join('\n');
  }

  private buildSignalsSection(signal_summary: ContextMemory['signal_summary']): string {
    const entries = Object.entries(signal_summary);
    if (entries.length === 0) return '';
    const lines = ['[HISTORIAL DE SEÑALES]'];
    for (const [sym, info] of entries.slice(0, 15)) {
      // Defensive: same rationale as buildObservationsSection above.
      const lastTs = typeof info.last_ts === 'string' ? info.last_ts : '';
      lines.push(`  ${sym}: última=${info.last_action} (${lastTs.slice(0, 10)}, ${info.count}x)`);
    }
    return lines.join('\n');
  }
}
