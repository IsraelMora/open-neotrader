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

describe('Plugins (e2e)', () => {
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

  it('publica un plugin válido (firmado)', async () => {
    const k = keys();
    const body = { manifestToml: UNI, payloadBase64: Buffer.from('x').toString('base64') };
    const res = await request(app.getHttpServer())
      .post('/plugins').set(headersFor(k, 'POST', '/plugins', body)).send(body);
    expect(res.status).toBe(201);
    expect(res.body.manifestId).toBe('demo-uni');
  });

  it('rechaza sin firma (401)', async () => {
    const body = { manifestToml: UNI, payloadBase64: 'eA==' };
    const res = await request(app.getHttpServer()).post('/plugins').send(body);
    expect(res.status).toBe(401);
  });

  it('rechaza type=provider (400)', async () => {
    const k = keys();
    const body = { manifestToml: UNI.replace('type = "universe"', 'type = "provider"'), payloadBase64: 'eA==' };
    const res = await request(app.getHttpServer())
      .post('/plugins').set(headersFor(k, 'POST', '/plugins', body)).send(body);
    expect(res.status).toBe(400);
  });

  it('lista y filtra por tipo', async () => {
    const k = keys();
    const body = { manifestToml: UNI, payloadBase64: Buffer.from('x').toString('base64') };
    await request(app.getHttpServer()).post('/plugins').set(headersFor(k, 'POST', '/plugins', body)).send(body);
    const res = await request(app.getHttpServer()).get('/plugins?type=universe');
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(1);
    expect(res.body.items[0].manifestId).toBe('demo-uni');
  });

  it('descarga el payload', async () => {
    const k = keys(); const pid = publisherIdFromPublicKey(k.pub);
    const body = { manifestToml: UNI, payloadBase64: Buffer.from('hola').toString('base64') };
    await request(app.getHttpServer()).post('/plugins').set(headersFor(k, 'POST', '/plugins', body)).send(body);
    const res = await request(app.getHttpServer()).get(`/plugins/${pid}/demo-uni/1.0.0/download`);
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body.payloadBase64, 'base64').toString()).toBe('hola');
  });

  it('detalle incluye contadores', async () => {
    const k = keys(); const pid = publisherIdFromPublicKey(k.pub);
    const body = { manifestToml: UNI, payloadBase64: Buffer.from('x').toString('base64') };
    await request(app.getHttpServer()).post('/plugins').set(headersFor(k, 'POST', '/plugins', body)).send(body);
    const res = await request(app.getHttpServer()).get(`/plugins/${pid}/demo-uni`);
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ likes: 0, dislikes: 0, reports: 0 });
    expect(res.body.versions.length).toBe(1);
  });
});
