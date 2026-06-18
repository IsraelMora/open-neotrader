import {
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { generateKeyPairSync, KeyObject } from 'node:crypto';
import { SignatureGuard } from './signature.guard';
import {
  buildSignedMessage,
  signMessage,
  sha256Hex,
  publisherIdFromPublicKey,
} from './signature.util';

interface KeyPair {
  pub: string;
  privateKey: KeyObject;
}

function keys(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey
    .export({ type: 'spki', format: 'der' })
    .toString('base64');
  return { pub, privateKey };
}

interface MockRequest {
  headers: Record<string, string>;
  method: string;
  url: string;
  body: unknown;
  publisherId?: string;
}

function ctx(
  headers: Record<string, string>,
  method = 'POST',
  url = '/plugins',
  body: unknown = {},
): ExecutionContext {
  const req: MockRequest = { headers, method, url, body };
  return {
    switchToHttp: () => ({ getRequest: <T>() => req as T }),
  } as ExecutionContext;
}
function signedHeaders(k: KeyPair, body: unknown, ts = String(Date.now())) {
  const bodyHash = sha256Hex(JSON.stringify(body ?? {}));
  const msg = buildSignedMessage(ts, 'POST', '/plugins', bodyHash);
  return {
    'x-publisher-id': publisherIdFromPublicKey(k.pub),
    'x-public-key': k.pub,
    'x-timestamp': ts,
    'x-signature': signMessage(k.privateKey, msg),
  } as Record<string, string>;
}

describe('SignatureGuard', () => {
  const guard = new SignatureGuard(300_000);

  it('acepta una firma válida y fija req.publisherId', () => {
    const k = keys();
    const body = { a: 1 };
    const c = ctx(signedHeaders(k, body), 'POST', '/plugins', body);
    expect(guard.canActivate(c)).toBe(true);
    expect(c.switchToHttp().getRequest<MockRequest>().publisherId).toBe(
      publisherIdFromPublicKey(k.pub),
    );
  });

  it('rechaza id que no coincide con la clave (403)', () => {
    const k = keys();
    const body = {};
    const h = signedHeaders(k, body);
    h['x-publisher-id'] = 'otro';
    expect(() => guard.canActivate(ctx(h, 'POST', '/plugins', body))).toThrow(
      ForbiddenException,
    );
  });

  it('rechaza timestamp viejo (401)', () => {
    const k = keys();
    const body = {};
    const h = signedHeaders(k, body, String(Date.now() - 10 * 60 * 1000));
    expect(() => guard.canActivate(ctx(h, 'POST', '/plugins', body))).toThrow(
      UnauthorizedException,
    );
  });

  it('rechaza firma inválida (401)', () => {
    const k = keys();
    const body = {};
    const h = signedHeaders(k, body);
    h['x-signature'] = Buffer.from('mala').toString('base64');
    expect(() => guard.canActivate(ctx(h, 'POST', '/plugins', body))).toThrow(
      UnauthorizedException,
    );
  });
});
