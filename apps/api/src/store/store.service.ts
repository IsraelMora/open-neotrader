import { Injectable, Logger, BadGatewayException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KvService } from '../common/kv.service';
import {
  buildSignedHeaders,
  generateStoreKeypair,
  publisherIdFromPublicKey,
  type StoreKeypair,
} from './store-signer';

const KV_PUBLIC_KEY = 'store.publisher.public_key';
const KV_PRIVATE_KEY = 'store.publisher.private_key';
const KV_DISPLAY_NAME = 'store.publisher.display_name';

/**
 * Cliente de la tienda comunitaria de plugins (STORE_URL).
 *
 * Lecturas (catálogo, detalle, descarga) son públicas. Las escrituras (publicar,
 * votar, reportar, fijar nombre) van firmadas con Ed25519 — el store las valida con
 * su SignatureGuard. La identidad de publisher (par de claves) vive localmente en KV;
 * se genera la primera vez que se necesita y nunca se expone la clave privada.
 */
@Injectable()
export class StoreService {
  private readonly log = new Logger(StoreService.name);
  private readonly storeUrl: string;

  constructor(
    cfg: ConfigService,
    private readonly kv: KvService,
  ) {
    this.storeUrl = cfg.get<string>('STORE_URL', 'https://store.neurotrader.app');
  }

  // ── Identidad de publisher (local, KV) ──────────────────────────────────────

  /** Carga el par de claves del publisher desde KV; lo genera y persiste si no existe. */
  private async keypair(): Promise<StoreKeypair> {
    const [pub, priv] = await Promise.all([
      this.kv.get(KV_PUBLIC_KEY),
      this.kv.get(KV_PRIVATE_KEY),
    ]);
    if (pub && priv) return { publicKeyB64: pub, privateKeyB64: priv };
    const kp = generateStoreKeypair();
    await Promise.all([
      this.kv.set(KV_PUBLIC_KEY, kp.publicKeyB64),
      this.kv.set(KV_PRIVATE_KEY, kp.privateKeyB64),
    ]);
    this.log.log('Identidad de publisher generada (Ed25519) y persistida en KV');
    return kp;
  }

  // ── HTTP ────────────────────────────────────────────────────────────────────

  private async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  /** Petición firmada (Ed25519) — para las rutas del store protegidas por SignatureGuard. */
  private async signed<T>(method: string, path: string, body: unknown): Promise<T> {
    const kp = await this.keypair();
    const signPath = new URL(`${this.storeUrl}${path}`).pathname; // incluye el prefijo /api
    const headers = buildSignedHeaders(kp, method, signPath, body);
    return this.request<T>(method, path, body, headers);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    const url = `${this.storeUrl}${path}`;
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body ?? {}) } : {}),
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

  // ── Lecturas (públicas) ─────────────────────────────────────────────────────

  /** Lista plugins de la tienda con filtros opcionales (querystring). */
  browse(qs: Record<string, string>) {
    const params = new URLSearchParams(qs).toString();
    return this.get(`/plugins${params ? '?' + params : ''}`);
  }

  /** Detalle completo de un plugin por publisher y manifestId. */
  detail(publisherId: string, manifestId: string) {
    return this.get(`/plugins/${publisherId}/${manifestId}`);
  }

  /** Descarga el payload + manifiesto de una versión concreta (ruta real del store). */
  install(publisherId: string, manifestId: string, version: string) {
    return this.get(`/plugins/${publisherId}/${manifestId}/${version}/download`);
  }

  // ── Escrituras (firmadas) ───────────────────────────────────────────────────

  /** Publica/actualiza un plugin (firmado). Requiere el manifiesto TOML y el payload base64. */
  publish(manifestToml: string, payloadBase64: string) {
    return this.signed('POST', '/plugins', { manifestToml, payloadBase64 });
  }

  /** Vota un plugin (firmado). */
  vote(pluginId: string, kind: 'like' | 'dislike') {
    return this.signed('POST', `/plugins/${pluginId}/vote`, { kind });
  }

  /** Reporta un plugin (firmado). */
  report(pluginId: string, reason: string) {
    return this.signed('POST', `/plugins/${pluginId}/report`, { reason });
  }

  // ── Identidad ───────────────────────────────────────────────────────────────

  /** Identidad pública local del publisher (no hay GET remoto en el store). */
  async getIdentity(): Promise<{
    publisher_id: string;
    public_key: string;
    display_name: string | null;
  }> {
    const kp = await this.keypair();
    const displayName = await this.kv.get(KV_DISPLAY_NAME);
    return {
      publisher_id: publisherIdFromPublicKey(kp.publicKeyB64),
      public_key: kp.publicKeyB64,
      display_name: displayName,
    };
  }

  /** Fija el nombre visible: persiste local y lo registra en el store (firmado). */
  async setIdentity(displayName: string | null) {
    await this.kv.set(KV_DISPLAY_NAME, displayName ?? '');
    await this.signed('POST', '/publishers/name', { displayName });
    return this.getIdentity();
  }
}
