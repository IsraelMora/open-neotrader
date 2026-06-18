import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { generateKeyPairSync } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  buildSignedMessage, sha256Hex, signMessage, publisherIdFromPublicKey,
} from '../src/auth/signature.util';

function keys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return { pub, privateKey };
}

// Regresión del hallazgo crítico de la revisión: por DI, windowMs llegaba
// undefined y el anti-replay se SALTABA. Este test ejercita la ruta HTTP real
// (DI), no `new SignatureGuard(...)`.
describe('Anti-replay vía DI (HTTP real)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
  });
  afterAll(async () => { await app.close(); });
  beforeEach(async () => { await prisma.publisher.deleteMany(); });

  it('timestamp viejo (10 min) → 401', async () => {
    const k = keys();
    const body = { displayName: 'x' };
    const ts = String(Date.now() - 10 * 60 * 1000);
    const msg = buildSignedMessage(ts, 'POST', '/publishers/name', sha256Hex(JSON.stringify(body)));
    const res = await request(app.getHttpServer()).post('/publishers/name').set({
      'x-publisher-id': publisherIdFromPublicKey(k.pub),
      'x-public-key': k.pub, 'x-timestamp': ts,
      'x-signature': signMessage(k.privateKey, msg),
    }).send(body);
    expect(res.status).toBe(401);
  });

  it('timestamp fresco → pasa (201)', async () => {
    const k = keys();
    const body = { displayName: 'x' };
    const ts = String(Date.now());
    const msg = buildSignedMessage(ts, 'POST', '/publishers/name', sha256Hex(JSON.stringify(body)));
    const res = await request(app.getHttpServer()).post('/publishers/name').set({
      'x-publisher-id': publisherIdFromPublicKey(k.pub),
      'x-public-key': k.pub, 'x-timestamp': ts,
      'x-signature': signMessage(k.privateKey, msg),
    }).send(body);
    expect(res.status).toBe(201);
  });
});
