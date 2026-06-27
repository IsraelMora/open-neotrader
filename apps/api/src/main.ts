import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { WsAdapter } from '@nestjs/platform-ws';
import helmet from '@fastify/helmet';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';

const log = new Logger('Bootstrap');

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: false }), // NestJS Logger en su lugar
  );

  // ── Seguridad ──────────────────────────────────────────────────────────────
  await app.register(helmet, {
    contentSecurityPolicy: process.env['NODE_ENV'] === 'production',
  });

  app.setGlobalPrefix('api');

  const corsOrigins = process.env['CORS_ORIGINS'];
  app.enableCors({
    origin: corsOrigins ? corsOrigins.split(',') : false,
    credentials: true,
  });

  // ── Validación global ──────────────────────────────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  // ── Manager de errores estandarizado ──────────────────────────────────────
  app.useGlobalFilters(new AllExceptionsFilter());

  // ── Swagger (solo desarrollo) ──────────────────────────────────────────────
  if (process.env['NODE_ENV'] !== 'production') {
    const doc = new DocumentBuilder()
      .setTitle('OpenNeoTrader API')
      .setDescription('Plataforma de agentes IA para trading — local & secure first')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, doc));
  }

  // ── WebSocket bidireccional ────────────────────────────────────────────────
  app.useWebSocketAdapter(new WsAdapter());

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  app.enableShutdownHooks(); // responde a SIGTERM/SIGINT correctamente

  const port = parseInt(process.env['API_PORT'] ?? '3000', 10);
  const host =
    process.env['API_HOST'] ?? (process.env['NODE_ENV'] === 'production' ? '0.0.0.0' : '127.0.0.1');

  await app.listen(port, host);
  const wsPort = parseInt(process.env['WS_PORT'] ?? '3001', 10);
  log.log(`OpenNeoTrader API → http://${host}:${port}/api`);
  log.log(`WebSocket WS   → ws://${host}:${wsPort}/api/ws`);
  log.log(`Swagger UI      → http://${host}:${port}/api/docs`);
}

bootstrap().catch((err) => {
  console.error('Error fatal al iniciar:', err);
  process.exit(1);
});
