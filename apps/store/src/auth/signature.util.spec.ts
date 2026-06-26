import { generateKeyPairSync } from 'node:crypto';
import {
  publisherIdFromPublicKey,
  buildSignedMessage,
  verifySignature,
} from './signature.util';
import { signMessage } from './__test-helpers__/sign';

function newKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey
    .export({ type: 'spki', format: 'der' })
    .toString('base64');
  return { pub, privateKey };
}

describe('signature.util', () => {
  it('id deriva determinista de la clave pública', () => {
    const { pub } = newKeys();
    expect(publisherIdFromPublicKey(pub)).toBe(publisherIdFromPublicKey(pub));
    expect(publisherIdFromPublicKey(pub)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('firma y verifica un mensaje', () => {
    const { pub, privateKey } = newKeys();
    const msg = buildSignedMessage('1700000000000', 'POST', '/plugins', 'abc');
    const sig = signMessage(privateKey, msg);
    expect(verifySignature(pub, msg, sig)).toBe(true);
  });

  it('rechaza firma de otra clave', () => {
    const a = newKeys();
    const b = newKeys();
    const msg = buildSignedMessage('1700000000000', 'POST', '/plugins', 'abc');
    const sig = signMessage(a.privateKey, msg);
    expect(verifySignature(b.pub, msg, sig)).toBe(false);
  });
});
