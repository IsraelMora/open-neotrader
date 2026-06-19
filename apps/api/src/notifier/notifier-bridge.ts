import { Injectable, Logger } from '@nestjs/common';

export type NotifyChannel = 'telegram';

export interface SendOpts {
  parse_mode?: 'Markdown' | 'HTML';
}

export interface SendResult {
  ok: boolean;
  error?: string;
}

const TELEGRAM_API = 'https://api.telegram.org';

/**
 * NotifierBridge — thin mechanism layer for dispatching notifications.
 *
 * Responsibilities:
 *  - Accepts a channel name + text and dispatches via the appropriate transport.
 *  - Reads credentials from process.env at call time (never from DB or config).
 *  - Unknown channels: no-op (log warn, return {ok:true}).
 *  - Missing credentials: log error, return {ok:false, error} — no throw.
 *
 * This class contains ZERO notification policy (no thresholds, no event listeners,
 * no DEFAULT_CONFIG). Policy lives exclusively in plugins.
 */
@Injectable()
export class NotifierBridge {
  private readonly log = new Logger(NotifierBridge.name);

  async send(channel: string, text: string, opts?: SendOpts): Promise<SendResult> {
    if (channel === 'telegram') {
      return this._sendTelegram(text, opts);
    }

    // Unknown channel: warn + no-op (not an error from the caller's perspective).
    this.log.warn(`NotifierBridge: unknown channel '${String(channel)}' — message dropped`);
    return { ok: true };
  }

  private async _sendTelegram(text: string, opts?: SendOpts): Promise<SendResult> {
    const botToken = process.env['TELEGRAM_BOT_TOKEN'];
    const chatId = process.env['TELEGRAM_CHAT_ID'];

    if (!botToken || !chatId) {
      const error = 'NotifierBridge: missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID';
      this.log.error(error);
      return { ok: false, error };
    }

    try {
      const url = `${TELEGRAM_API}/bot${botToken}/sendMessage`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: opts?.parse_mode ?? 'Markdown',
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        const body = await res.text();
        const error = `Telegram API ${res.status}: ${body.slice(0, 200)}`;
        this.log.warn(error);
        return { ok: false, error };
      }

      return { ok: true };
    } catch (err: unknown) {
      const error = String(err);
      this.log.error(`NotifierBridge: fetch error — ${error}`);
      return { ok: false, error };
    }
  }
}
