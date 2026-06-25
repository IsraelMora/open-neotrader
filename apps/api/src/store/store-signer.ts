import { createHash, createPrivateKey, generateKeyPairSync, sign as edSign } from 'node:crypto';

/**
 * Firma de peticiones a la tienda comunitaria (Ed25519).
 *
 * La tienda (apps/store) protege las escrituras con SignatureGuard: cada request
 * debe traer `x-publisher-id`, `x-public-key`, `x-timestamp` y `x-signature`. El
 * mensaje canónico que se firma es:
 *
 *   `${timestamp}\n${METHOD}\n${path}\n${sha256Hex(JSON.stringify(body))}`
 *
 * donde `path` es la ruta SIN query string (incluyendo el prefijo `/api`) y el
 * hash del cuerpo es sobre `JSON.stringify(body ?? {})`. Replicamos ese esquema
 * exacto para que la verificación del store acepte nuestras firmas.
 */

export interface StoreKeypair {
  /** Clave pública DER (spki) en base64 — va en la cabecera x-public-key. */
  publicKeyB64: string;
  /** Clave privada DER (pkcs8) en base64 — persistida en KV, nunca se expone. */
  privateKeyB64: string;
}

export interface SignedHeaders {
  // index signature → asignable a Record<string, string> (fetch headers)
  [header: string]: string;
  'x-publisher-id': string;
  'x-public-key': string;
  'x-timestamp': string;
  'x-signature': string;
}

/** Genera un par de claves Ed25519 nuevo para la identidad de publisher. */
export function generateStoreKeypair(): StoreKeypair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyB64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKeyB64: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

/** Deriva el publisher id = base64url(sha256(publicKeyBase64)) — igual que el store. */
export function publisherIdFromPublicKey(publicKeyB64: string): string {
  return createHash('sha256').update(publicKeyB64).digest('base64url');
}

/** SHA-256 del cuerpo serializado, en hexadecimal (igual que el store). */
export function sha256Hex(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/** Construye el mensaje canónico firmado: timestamp\nMETHOD\npath\nbodyHashHex. */
export function buildSignedMessage(
  timestamp: string,
  method: string,
  path: string,
  bodyHashHex: string,
): string {
  return [timestamp, method.toUpperCase(), path, bodyHashHex].join('\n');
}

/**
 * Produce las cabeceras de firma para una petición de escritura a la tienda.
 *
 * @param kp        - Par de claves del publisher.
 * @param method    - Método HTTP (POST, …).
 * @param path      - Ruta absoluta SIN query (p.ej. `/api/publishers/name`).
 * @param body      - Objeto del cuerpo (se hashea como JSON.stringify(body ?? {})).
 * @param timestamp - Unix ms (inyectable para tests; por defecto Date.now()).
 */
export function buildSignedHeaders(
  kp: StoreKeypair,
  method: string,
  path: string,
  body: unknown,
  timestamp: number = Date.now(),
): SignedHeaders {
  const ts = String(timestamp);
  const bodyHash = sha256Hex(JSON.stringify(body ?? {}));
  const msg = buildSignedMessage(ts, method, path, bodyHash);
  const privateKey = createPrivateKey({
    key: Buffer.from(kp.privateKeyB64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  const signature = edSign(null, Buffer.from(msg, 'utf8'), privateKey).toString('base64');
  return {
    'x-publisher-id': publisherIdFromPublicKey(kp.publicKeyB64),
    'x-public-key': kp.publicKeyB64,
    'x-timestamp': ts,
    'x-signature': signature,
  };
}
