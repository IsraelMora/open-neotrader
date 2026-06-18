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
async function publicar(app: INestApplication, k: ReturnType<typeof keys>): Promise<string> {
  const body = { manifestToml: UNI, payloadBase64: Buffer.from('x').toString('base64') };
  const res = await request(app.getHttpServer()).post('/plugins').set(headersFor(k, 'POST', '/plugins', body)).send(body);
  return res.body.id as string; // id real del plugin
}

describe('Votos y reports (e2e)', () => {
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

  async function detalle(app: INestApplication, autor: ReturnType<typeof keys>): Promise<any> {
    const pid = publisherIdFromPublicKey(autor.pub);
    const res = await request(app.getHttpServer()).get(`/plugins/${pid}/demo-uni`);
    return res.body;
  }

  it('like incrementa a 1; segundo like del mismo id sigue 1 (upsert)', async () => {
    const autor = keys(); const id = await publicar(app, autor);
    const votante = keys(); const body = { kind: 'like' };
    const path = `/plugins/${id}/vote`;
    await request(app.getHttpServer()).post(path).set(headersFor(votante, 'POST', path, body)).send(body);
    await request(app.getHttpServer()).post(path).set(headersFor(votante, 'POST', path, body)).send(body);
    expect((await detalle(app, autor)).counts.likes).toBe(1);
  });

  it('cambiar like→dislike del mismo id deja likes=0, dislikes=1', async () => {
    const autor = keys(); const id = await publicar(app, autor);
    const votante = keys(); const path = `/plugins/${id}/vote`;
    const like = { kind: 'like' }; const dislike = { kind: 'dislike' };
    await request(app.getHttpServer()).post(path).set(headersFor(votante, 'POST', path, like)).send(like);
    await request(app.getHttpServer()).post(path).set(headersFor(votante, 'POST', path, dislike)).send(dislike);
    const d = await detalle(app, autor);
    expect(d.counts.likes).toBe(0);
    expect(d.counts.dislikes).toBe(1);
  });

  it('report inserta y aparece en counts.reports', async () => {
    const autor = keys(); const id = await publicar(app, autor);
    const rep = keys(); const body = { reason: 'malware sospechoso' };
    const path = `/plugins/${id}/report`;
    const res = await request(app.getHttpServer()).post(path).set(headersFor(rep, 'POST', path, body)).send(body);
    expect(res.status).toBe(201);
    expect((await detalle(app, autor)).counts.reports).toBe(1);
  });

  it('votar sin firma → 401', async () => {
    const autor = keys(); const id = await publicar(app, autor);
    const res = await request(app.getHttpServer()).post(`/plugins/${id}/vote`).send({ kind: 'like' });
    expect(res.status).toBe(401);
  });

  it('report del mismo reportante es idempotente (replay no duplica)', async () => {
    const autor = keys(); const id = await publicar(app, autor);
    const rep = keys(); const body = { reason: 'malware' };
    const path = `/plugins/${id}/report`;
    // mismo reportante reporta dos veces (p.ej. por reenvío/replay)
    await request(app.getHttpServer()).post(path).set(headersFor(rep, 'POST', path, body)).send(body);
    await request(app.getHttpServer()).post(path).set(headersFor(rep, 'POST', path, body)).send(body);
    expect((await detalle(app, autor)).counts.reports).toBe(1);
  });
});
