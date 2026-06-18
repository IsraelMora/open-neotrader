import { Injectable, Logger, BadGatewayException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Cliente HTTP para la tienda remota de plugins (STORE_URL); hace proxy de búsqueda, instalación, publicación, votos y reportes. */
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

  /** Lista plugins de la tienda con filtros opcionales (querystring). */
  browse(qs: Record<string, string>) {
    const params = new URLSearchParams(qs).toString();
    return this.fetch(`/plugins${params ? '?' + params : ''}`);
  }

  /** Obtiene el detalle completo de un plugin por publisher y manifestId. */
  detail(publisherId: string, manifestId: string) {
    return this.fetch(`/plugins/${publisherId}/${manifestId}`);
  }

  /** Registra una instalación de plugin en la tienda (estadísticas de descarga). */
  install(publisherId: string, manifestId: string, version: string) {
    return this.fetch('/install', {
      method: 'POST',
      body: JSON.stringify({ publisherId, manifestId, version }),
    });
  }

  /** Publica o actualiza un plugin en la tienda remota. */
  publish(pluginId: string) {
    return this.fetch('/publish', {
      method: 'POST',
      body: JSON.stringify({ pluginId }),
    });
  }

  /** Emite un voto (like/dislike) para un plugin en la tienda. */
  vote(pluginId: string, kind: 'like' | 'dislike') {
    return this.fetch('/vote', {
      method: 'POST',
      body: JSON.stringify({ pluginId, kind }),
    });
  }

  /** Reporta un plugin por contenido inapropiado o malicioso. */
  report(pluginId: string, reason: string) {
    return this.fetch('/report', {
      method: 'POST',
      body: JSON.stringify({ pluginId, reason }),
    });
  }

  /** Obtiene la identidad del publicador registrada en la tienda. */
  getIdentity() {
    return this.fetch('/identity');
  }

  /** Actualiza el nombre visible del publicador en la tienda. */
  setIdentity(displayName: string | null) {
    return this.fetch('/identity', {
      method: 'POST',
      body: JSON.stringify({ display_name: displayName }),
    });
  }
}
