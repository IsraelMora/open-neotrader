import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PluginsService } from '../plugins/plugins.service';

const PLUGIN_ID = 'telegram-notifier';
const TELEGRAM_API = 'https://api.telegram.org';

/** TelegramService: manages plugin activation state and exposes send/sendTest for the controller. */
@Injectable()
export class TelegramService implements OnModuleInit {
  private readonly log = new Logger(TelegramService.name);
  private botToken: string | null = null;
  private chatId: string | null = null;
  private active = false;

  constructor(private readonly plugins: PluginsService) {}

  async onModuleInit(): Promise<void> {
    await this.reload();
  }

  private async reload(): Promise<void> {
    try {
      const active = await this.plugins.findActive();
      const plugin = active.find((p) => p.id === PLUGIN_ID);
      if (!plugin) {
        this.active = false;
        return;
      }

      // Credentials from environment variables (never from DB)
      this.botToken = process.env['TELEGRAM_BOT_TOKEN'] ?? null;
      this.chatId = process.env['TELEGRAM_CHAT_ID'] ?? null;

      if (!this.botToken || !this.chatId) {
        this.log.warn(
          'Telegram plugin active but TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing from env',
        );
        this.active = false;
        return;
      }

      this.active = true;
      this.log.log('Telegram notifier activated');
    } catch (err) {
      this.log.error(`Error loading Telegram config: ${err}`);
      this.active = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Public API — used by NotifierController (/notifier/test)
  // ---------------------------------------------------------------------------

  /** Sends a Telegram message. Does not throw if credentials are missing. */
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
      this.log.error(`Error sending Telegram message: ${err}`);
    }
  }

  /** Sends a test message (used to verify configuration). */
  async sendTest(): Promise<{ ok: boolean; error?: string }> {
    if (!this.active) return { ok: false, error: 'Plugin not active or missing credentials' };
    try {
      await this.send('🧪 *NeuroTrader* — Test connection OK ✓');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }
}
