import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

// ── Typed events ──────────────────────────────────────────────────────────────
// Los plugins emiten eventos; la plataforma los distribuye.
// Otros plugins, el frontend (websocket) y servicios internos pueden suscribirse.

export interface PluginActivatedEvent {
  plugin_id: string;
  type: string;
}
export interface PluginDeactivatedEvent {
  plugin_id: string;
}
export interface PluginInstalledEvent {
  plugin_id: string;
  version: string;
}
export interface PluginRemovedEvent {
  plugin_id: string;
}

export interface CycleStartedEvent {
  started_at: string;
  dry_run: boolean;
}
export interface CycleCompletedEvent {
  started_at: string;
  dry_run: boolean;
  decisions: number;
  skills_read: string[];
  skills_written: string[];
}
export interface CycleFailedEvent {
  started_at: string;
  error: string;
}

export interface PluginSignalEvent {
  plugin_id: string;
  signal_type: string; // 'buy' | 'sell' | 'alert' | cualquier string definido por el plugin
  payload: Record<string, unknown>;
  ts: string;
}

export interface PluginLogEvent {
  plugin_id: string;
  stream: string;
  entry: Record<string, unknown>;
}

export interface PluginSkillUpdatedEvent {
  plugin_id: string;
  path: string;
}
export interface PluginManifestUpdatedEvent {
  plugin_id: string;
  path: string;
}

// Mapa de nombres de evento → tipo de payload
export interface NeuroTraderEvents {
  'plugin.activated': PluginActivatedEvent;
  'plugin.deactivated': PluginDeactivatedEvent;
  'plugin.installed': PluginInstalledEvent;
  'plugin.removed': PluginRemovedEvent;
  'plugin.skill_updated': PluginSkillUpdatedEvent;
  'plugin.manifest_updated': PluginManifestUpdatedEvent;
  'cycle.started': CycleStartedEvent;
  'cycle.completed': CycleCompletedEvent;
  'cycle.failed': CycleFailedEvent;
  'plugin.signal': PluginSignalEvent;
  'plugin.log': PluginLogEvent;
}

@Injectable()
export class PluginEventsService {
  constructor(private readonly emitter: EventEmitter2) {}

  emit<K extends keyof NeuroTraderEvents>(event: K, payload: NeuroTraderEvents[K]): void {
    this.emitter.emit(event, payload);
  }

  on<K extends keyof NeuroTraderEvents>(
    event: K,
    listener: (payload: NeuroTraderEvents[K]) => void,
  ): void {
    this.emitter.on(event, listener);
  }

  off<K extends keyof NeuroTraderEvents>(
    event: K,
    listener: (payload: NeuroTraderEvents[K]) => void,
  ): void {
    this.emitter.off(event, listener);
  }
}
