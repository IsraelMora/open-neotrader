import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PluginsService } from '../plugins/plugins.service';
import {
  CycleCompletedEvent,
  CycleFailedEvent,
  CycleStartedEvent,
  PluginActivatedEvent,
  PluginSignalEvent,
} from '../plugins/plugin-events.service';

const PLUGIN_ID = 'telegram-notifier';
const TELEGRAM_API = 'https://api.telegram.org';

interface TelegramConfig {
  notify_cycle_start: boolean;
  notify_cycle_complete: boolean;
  notify_signals: boolean;
  notify_circuit_breaker: boolean;
  notify_errors: boolean;
  min_confidence: number;
  max_messages_per_cycle: number;
}

const DEFAULT_CONFIG: TelegramConfig = {
  notify_cycle_start: false,
  notify_cycle_complete: true,
  notify_signals: true,
  notify_circuit_breaker: true,
  notify_errors: true,
  min_confidence: 0.5,
  max_messages_per_cycle: 10,
};

@Injectable()
export class TelegramService implements OnModuleInit {
  private readonly log = new Logger(TelegramService.name);
  private botToken: string | null = null;
  private chatId: string | null = null;
  private config: TelegramConfig = { ...DEFAULT_CONFIG };
  private messagesThisCycle = 0;
  private active = false;

  constructor(private readonly plugins: PluginsService) {}

  async onModuleInit(): Promise<void> {
    await this.reload();
  }

  /** Recarga credenciales y config cuando el plugin se activa/desactiva */
  @OnEvent('plugin.activated')
  async onPluginActivated(event: PluginActivatedEvent): Promise<void> {
    if (event.plugin_id === PLUGIN_ID) await this.reload();
  }

  @OnEvent('plugin.deactivated')
  onPluginDeactivated(event: { plugin_id: string }): void {
    if (event.plugin_id === PLUGIN_ID) {
      this.active = false;
      this.log.log('Telegram notifier desactivado');
    }
  }

  private async reload(): Promise<void> {
    try {
      const active = await this.plugins.findActive();
      const plugin = active.find((p) => p.id === PLUGIN_ID);
      if (!plugin) {
        this.active = false;
        return;
      }

      // Credenciales desde variables de entorno (nunca de la BD)
      this.botToken = process.env['TELEGRAM_BOT_TOKEN'] ?? null;
      this.chatId = process.env['TELEGRAM_CHAT_ID'] ?? null;

      if (!this.botToken || !this.chatId) {
        this.log.warn(
          'Telegram Notifier activo pero faltan TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID en .env',
        );
        this.active = false;
        return;
      }

      // Config del plugin (sobreescribe defaults)
      const pluginConfig = plugin.config ?? {};
      this.config = { ...DEFAULT_CONFIG, ...pluginConfig };
      this.active = true;
      this.log.log('Telegram notifier activado');
    } catch (err) {
      this.log.error(`Error cargando Telegram config: ${err}`);
      this.active = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Listeners de eventos del agente
  // ---------------------------------------------------------------------------

  @OnEvent('cycle.started')
  onCycleStarted(event: CycleStartedEvent): void {
    if (!this.active || !this.config.notify_cycle_start) return;
    this.messagesThisCycle = 0;
    void this.send(`🤖 *Ciclo iniciado*\n\`${new Date(event.started_at).toLocaleTimeString()}\``);
  }

  @OnEvent('cycle.completed')
  onCycleCompleted(event: CycleCompletedEvent): void {
    if (!this.active || !this.config.notify_cycle_complete) return;
    const skills = event.skills_read?.length ?? 0;
    const written = event.skills_written?.length ?? 0;
    const text =
      `✅ *Ciclo completado*\n` +
      `Decisiones: ${event.decisions ?? 0}\n` +
      `Skills leídos: ${skills} | escritos: ${written}`;
    void this.send(text);
    this.messagesThisCycle = 0;
  }

  @OnEvent('cycle.failed')
  onCycleFailed(event: CycleFailedEvent): void {
    if (!this.active || !this.config.notify_errors) return;
    void this.send(`❌ *Ciclo fallido*\n\`${event.error?.slice(0, 200) ?? 'error desconocido'}\``);
    this.messagesThisCycle = 0;
  }

  @OnEvent('plugin.signal')
  onPluginSignal(event: PluginSignalEvent): void {
    if (!this.active || !this.config.notify_signals) return;
    if (this.messagesThisCycle >= this.config.max_messages_per_cycle) return;

    const signal = event.payload;
    const confidence = (signal['confidence'] as number | undefined) ?? 0;
    if (confidence < this.config.min_confidence) return;

    const action = signal['action'] as string;
    const symbol = signal['symbol'] as string;
    const type = signal['type'] as string;

    // Detectar circuit breaker para notificación especial
    if (type === 'circuit_breaker' && !this.config.notify_circuit_breaker) return;

    let emoji = '📊';
    if (action === 'long') emoji = '📈';
    else if (action === 'exit') emoji = '🚪';
    else if (action === 'cancelled') emoji = '🚫';
    const text =
      `${emoji} *Señal: ${symbol}*\n` +
      `Acción: ${action.toUpperCase()}\n` +
      `Tipo: ${type}\n` +
      `Confianza: ${(confidence * 100).toFixed(0)}%`;

    void this.send(text);
    this.messagesThisCycle++;
  }

  // ---------------------------------------------------------------------------
  // API Telegram
  // ---------------------------------------------------------------------------

  async send(text: string, parseMode: 'Markdown' | 'HTML' = 'Markdown'): Promise<void> {
    if (!this.botToken || !this.chatId) return;
    try {
      const url = `${TELEGRAM_API}/bot${this.botToken}/sendMessage`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: parseMode,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const body = await res.text();
        this.log.warn(`Telegram API error ${res.status}: ${body.slice(0, 200)}`);
      }
    } catch (err) {
      this.log.error(`Error enviando mensaje Telegram: ${err}`);
    }
  }

  /** Envía un mensaje de prueba (para verificar la configuración) */
  async sendTest(): Promise<{ ok: boolean; error?: string }> {
    if (!this.active) return { ok: false, error: 'Plugin no activo o sin credenciales' };
    try {
      await this.send('🧪 *NeuroTrader* — Conexión de prueba OK ✓');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }
}
