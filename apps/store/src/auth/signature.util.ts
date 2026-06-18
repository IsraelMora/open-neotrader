import {
  createHash,
  createPublicKey,
  verify,
  sign,
  KeyObject,
} from 'node:crypto';

export function publisherIdFromPublicKey(publicKeyBase64: string): string {
  return createHash('sha256').update(publicKeyBase64).digest('base64url');
}

export function buildSignedMessage(
  timestamp: string,
  method: string,
  path: string,
  bodyHashHex: string,
): string {
  return [timestamp, method.toUpperCase(), path, bodyHashHex].join('\n');
}

export function sha256Hex(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

export function signMessage(privateKey: KeyObject, message: string): string {
  return sign(null, Buffer.from(message, 'utf8'), privateKey).toString(
    'base64',
  );
}

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
