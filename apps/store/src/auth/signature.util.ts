import {
  createHash,
  createPublicKey,
  verify,
  sign,
  KeyObject,
} from 'node:crypto';

/**
 * Deriva el identificador de publisher a partir de su clave pública.
 *
 * @param publicKeyBase64 - Clave pública en formato DER codificada en base64.
 * @returns SHA-256 de la clave codificado en base64url.
 */
export function publisherIdFromPublicKey(publicKeyBase64: string): string {
  return createHash('sha256').update(publicKeyBase64).digest('base64url');
}

/**
 * Construye el mensaje canónico que se firma/verifica.
 *
 * El formato es: `timestamp\nMETHOD\npath\nbodyHashHex`, con cada campo
 * separado por un salto de línea y el método en mayúsculas.
 *
 * @param timestamp    - Marca de tiempo Unix en milisegundos (como string).
 * @param method       - Método HTTP (se normaliza a mayúsculas).
 * @param path         - Ruta de la URL sin query string.
 * @param bodyHashHex  - SHA-256 del cuerpo serializado, en hexadecimal.
 */
export function buildSignedMessage(
  timestamp: string,
  method: string,
  path: string,
  bodyHashHex: string,
): string {
  return [timestamp, method.toUpperCase(), path, bodyHashHex].join('\n');
}

/**
 * Calcula el hash SHA-256 de un string y lo devuelve en hexadecimal.
 *
 * @param body - Texto a hashear (UTF-8).
 */
export function sha256Hex(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/**
 * Firma un mensaje con la clave privada indicada usando el algoritmo Ed25519.
 *
 * @param privateKey - Clave privada como `KeyObject` de Node.js.
 * @param message    - Mensaje canónico a firmar.
 * @returns Firma en base64.
 */
export function signMessage(privateKey: KeyObject, message: string): string {
  return sign(null, Buffer.from(message, 'utf8'), privateKey).toString(
    'base64',
  );
}

/**
 * Verifica una firma Ed25519 contra un mensaje y una clave pública.
 *
 * @param publicKeyBase64   - Clave pública DER en base64.
 * @param message           - Mensaje canónico original.
 * @param signatureBase64   - Firma a verificar en base64.
 * @returns `true` si la firma es válida; `false` en cualquier otro caso
 *          (incluyendo errores de parseo de la clave).
 */
export function verifySignature(
  publicKeyBase64: string,
  message: string,
  signatureBase64: string,
): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeyBase64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    return verify(
      null,
      Buffer.from(message, 'utf8'),
      key,
      Buffer.from(signatureBase64, 'base64'),
    );
  } catch {
    return false;
  }
}
