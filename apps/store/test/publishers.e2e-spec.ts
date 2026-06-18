import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { generateKeyPairSync } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildSignedMessage, sha256Hex, signMessage, publisherIdFromPublicKey } from '../src/auth/signature.util';

function keys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return { pub, privateKey };
}
const UNI = `
[plugin]
id = "demo-uni"
name = "Demo"
type = "universe"
version = "1.0.0"
author = "a"
description = "d"
[universe]
symbols = { NVDA = "equity" }
`;
function headersFor(k: ReturnType<typeof keys>, method: string, path: string, body: any) {
  const ts = String(Date.now());
  const msg = buildSignedMessage(ts, method, path, sha256Hex(JSON.stringify(body)));
  return {
    'x-publisher-id': publisherIdFromPublicKey(k.pub),
    'x-public-key': k.pub, 'x-timestamp': ts,
    'x-signature': signMessage(k.privateKey, msg),
  };
}

describe('Publishers nombre opt-in (e2e)', () => {
  let app: INestApplication; let prisma: PrismaService;
  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
  });
  afterAll(async () => { await app.close(); });
  beforeEach(async () => {
    await prisma.vote.deleteMany(); await prisma.report.deleteMany();
    await prisma.pluginVersion.deleteMany(); await prisma.plugin.deleteMany();
    await prisma.publisher.deleteMany();
  });

  it('fija el nombre (firmado) y queda persistido', async () => {
    const k = keys(); const body = { displayName: 'Alex' };
    const res = await request(app.getHttpServer())
      .post('/publishers/name').set(headersFor(k, 'POST', '/publishers/name', body)).send(body);
    expect(res.status).toBe(201);
    expect(res.body.displayName).toBe('Alex');
    const row = await prisma.publisher.findUnique({ where: { id: publisherIdFromPublicKey(k.pub) } });
    expect(row?.displayName).toBe('Alex');
  });

  it('permite quitar el nombre (null)', async () => {
    const k = keys();
    const b1 = { displayName: 'Alex' };
    await request(app.getHttpServer()).post('/publishers/name').set(headersFor(k, 'POST', '/publishers/name', b1)).send(b1);
    const b2 = { displayName: null };
    const res = await request(app.getHttpServer()).post('/publishers/name').set(headersFor(k, 'POST', '/publishers/name', b2)).send(b2);
    expect(res.status).toBe(201);
    const row = await prisma.publisher.findUnique({ where: { id: publisherIdFromPublicKey(k.pub) } });
    expect(row?.displayName).toBeNull();
  });

  it('rechaza sin firma (401)', async () => {
    const res = await request(app.getHttpServer()).post('/publishers/name').send({ displayName: 'x' });
    expect(res.status).toBe(401);
  });
});
