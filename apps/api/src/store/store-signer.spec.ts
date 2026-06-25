import { createPublicKey, verify as edVerify } from 'node:crypto';
import {
  generateStoreKeypair,
  buildSignedHeaders,
  buildSignedMessage,
  sha256Hex,
  publisherIdFromPublicKey,
  type SignedHeaders,
} from './store-signer';

/**
 * Replica EXACTA del SignatureGuard del store (apps/store/src/auth/signature.guard.ts +
 * signature.util.ts). Si nuestras cabeceras pasan esta verificación, el store las acepta.
 */
function storeVerifies(
  headers: SignedHeaders,
  method: string,
  path: string,
  body: unknown,
): boolean {
  const id = headers['x-publisher-id'];
  const pub = headers['x-public-key'];
  const ts = headers['x-timestamp'];
  const sig = headers['x-signature'];
  if (!id || !pub || !ts || !sig) return false;
  if (publisherIdFromPublicKey(pub) !== id) return false;
  const bodyHash = sha256Hex(JSON.stringify(body ?? {}));
  const msg = buildSignedMessage(ts, method, path, bodyHash);
  try {
    const key = createPublicKey({ key: Buffer.from(pub, 'base64'), format: 'der', type: 'spki' });
    return edVerify(null, Buffer.from(msg, 'utf8'), key, Buffer.from(sig, 'base64'));
  } catch {
    return false;
  }
}

describe('store-signer — interoperabilidad con el SignatureGuard del store', () => {
  it('las cabeceras firmadas pasan la verificación del store', () => {
    const kp = generateStoreKeypair();
    const path = '/api/publishers/name';
    const body = { displayName: 'Alex' };
    const headers = buildSignedHeaders(kp, 'POST', path, body, 1_000_000);
    expect(storeVerifies(headers, 'POST', path, body)).toBe(true);
  });

  it('publisher id = base64url(sha256(publicKey)) y coincide con la cabecera', () => {
    const kp = generateStoreKeypair();
    const headers = buildSignedHeaders(kp, 'POST', '/api/plugins/p1/vote', { kind: 'like' }, 5);
    expect(headers['x-publisher-id']).toBe(publisherIdFromPublicKey(kp.publicKeyB64));
  });

  it('una firma no cubre un cuerpo distinto (anti-tamper)', () => {
    const kp = generateStoreKeypair();
    const path = '/api/plugins/p1/report';
    const headers = buildSignedHeaders(kp, 'POST', path, { reason: 'spam' }, 42);
    // mismo header, cuerpo manipulado → la verificación debe fallar
    expect(storeVerifies(headers, 'POST', path, { reason: 'otra cosa' })).toBe(false);
  });

  it('una firma no es válida para otra ruta', () => {
    const kp = generateStoreKeypair();
    const headers = buildSignedHeaders(kp, 'POST', '/api/plugins/p1/vote', { kind: 'like' }, 7);
    expect(storeVerifies(headers, 'POST', '/api/plugins/p2/vote', { kind: 'like' })).toBe(false);
  });
});
