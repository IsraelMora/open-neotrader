import { sign, KeyObject } from 'node:crypto';

/**
 * Firma un mensaje con la clave privada indicada usando el algoritmo Ed25519.
 * Auxiliar exclusivo para specs — no debe importarse desde código de producción.
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
