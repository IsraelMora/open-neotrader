import { Injectable, Logger, BadGatewayException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class StoreService {
  private readonly log = new Logger(StoreService.name);
  private readonly storeUrl: string;

  constructor(cfg: ConfigService) {
    this.storeUrl = cfg.get<string>('STORE_URL', 'https://store.neurotrader.app');
  }

  private async fetch<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.storeUrl}${path}`;
    try {
      const res = await fetch(url, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new BadGatewayException(`Store error ${res.status}: ${text}`);
      }
      return res.json() as Promise<T>;
    } catch (err) {
      if (err instanceof BadGatewayException) throw err;
      this.log.warn(`Store unreachable: ${(err as Error).message}`);
      throw new BadGatewayException('Tienda no disponible');
    }
  }

  browse(qs: Record<string, string>) {
    const params = new URLSearchParams(qs).toString();
    return this.fetch(`/plugins${params ? '?' + params : ''}`);
  }

  detail(publisherId: string, manifestId: string) {
    return this.fetch(`/plugins/${publisherId}/${manifestId}`);
  }

  install(publisherId: string, manifestId: string, version: string) {
    return this.fetch('/install', {
      method: 'POST',
      body: JSON.stringify({ publisherId, manifestId, version }),
    });
  }

  publish(pluginId: string) {
    return this.fetch('/publish', {
      method: 'POST',
      body: JSON.stringify({ pluginId }),
    });
  }

  vote(pluginId: string, kind: 'like' | 'dislike') {
    return this.fetch('/vote', {
      method: 'POST',
      body: JSON.stringify({ pluginId, kind }),
    });
  }

  report(pluginId: string, reason: string) {
    return this.fetch('/report', {
      method: 'POST',
      body: JSON.stringify({ pluginId, reason }),
    });
  }

  getIdentity() {
    return this.fetch('/identity');
  }

  setIdentity(displayName: string | null) {
    return this.fetch('/identity', {
      method: 'POST',
      body: JSON.stringify({ display_name: displayName }),
    });
  }
}
