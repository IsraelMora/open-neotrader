import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  MessageBody,
  ConnectedSocket,
  WsException,
} from '@nestjs/websockets';
import { Logger, OnModuleInit } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Server, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { LlmService } from '../llm/llm.service';
import { PluginEventsService, type NeuroTraderEvents } from '../plugins/plugin-events.service';

interface AuthClient extends WebSocket {
  userId?: string;
  username?: string;
  isAlive?: boolean;
}

// ── Mensajes cliente → servidor ──────────────────────────────────────────────

export interface AgentMessagePayload {
  message: string;
  context?: string;
}

export interface PingPayload {
  ts?: number;
}

// ── Mensajes servidor → cliente ──────────────────────────────────────────────

@WebSocketGateway({ port: parseInt(process.env['WS_PORT'] ?? '3001', 10), path: '/api/ws' })
export class WsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleInit
{
  private readonly log = new Logger(WsGateway.name);
  private readonly clients = new Set<AuthClient>();

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly llm: LlmService,
    private readonly events: PluginEventsService,
  ) {}

  afterInit(server: Server) {
    this.log.log('WS Gateway inicializado');

    // Heartbeat para detectar clientes desconectados
    const interval = setInterval(() => {
      server.clients.forEach((ws: WebSocket) => {
        const client = ws as AuthClient;
        if (!client.isAlive) {
          client.terminate();
          return;
        }
        client.isAlive = false;
        client.ping();
      });
    }, 30_000);

    server.on('close', () => clearInterval(interval));
  }

  onModuleInit() {
    // Suscribir al bus interno y reenviar eventos a todos los clientes WS autenticados
    const forward = (event: string) => (payload: unknown) => {
      this.broadcast({ event, data: payload });
    };

    const handlers: { [K in keyof NeuroTraderEvents]?: (p: NeuroTraderEvents[K]) => void } = {
      'cycle.started': forward('cycle.started'),
      'cycle.completed': forward('cycle.completed'),
      'cycle.failed': forward('cycle.failed'),
      'plugin.activated': forward('plugin.activated'),
      'plugin.deactivated': forward('plugin.deactivated'),
      'plugin.installed': forward('plugin.installed'),
      'plugin.removed': forward('plugin.removed'),
      'plugin.signal': forward('plugin.signal'),
      'plugin.log': forward('plugin.log'),
      'plugin.skill_updated': forward('plugin.skill_updated'),
      'plugin.manifest_updated': forward('plugin.manifest_updated'),
    };

    for (const [event, handler] of Object.entries(handlers)) {
      this.events.on(event as keyof NeuroTraderEvents, handler);
    }
  }

  // ── Conexión ─────────────────────────────────────────────────────────────

  handleConnection(client: AuthClient, req: IncomingMessage) {
    try {
      const token = this.extractToken(req);
      const payload = this.jwt.verify<{ sub: string; username: string; totp_verified?: boolean }>(
        token,
      );
      if (!payload.totp_verified) {
        this.send(client, 'error', { code: 403, message: 'Se requiere verificación TOTP' });
        client.close(1008, 'TOTP required');
        return;
      }
      client.userId = payload.sub;
      client.username = payload.username;
      client.isAlive = true;

      client.on('pong', () => {
        client.isAlive = true;
      });
      this.clients.add(client);

      this.send(client, 'connected', {
        ts: new Date().toISOString(),
        userId: client.userId,
        username: client.username,
        message: 'WebSocket NeuroTrader conectado',
      });
      this.log.log(`WS conectado: ${client.username} (${client.userId})`);
    } catch {
      this.send(client, 'error', { code: 401, message: 'Token inválido o expirado' });
      client.close(1008, 'Unauthorized');
    }
  }

  handleDisconnect(client: AuthClient) {
    this.clients.delete(client);
    if (client.username) {
      this.log.log(`WS desconectado: ${client.username}`);
    }
  }

  // ── Mensajes ──────────────────────────────────────────────────────────────

  @SubscribeMessage('agent:message')
  async onAgentMessage(
    @MessageBody() payload: AgentMessagePayload,
    @ConnectedSocket() client: AuthClient,
  ) {
    if (!payload?.message?.trim()) {
      throw new WsException('message no puede estar vacío');
    }
    if (payload.message.length > 8000) {
      throw new WsException('message supera el límite de 8000 caracteres');
    }
    if ((payload.context?.length ?? 0) > 32000) {
      throw new WsException('context supera el límite de 32000 caracteres');
    }

    this.send(client, 'agent:thinking', { ts: new Date().toISOString() });

    try {
      const result = await this.llm.complete({
        context: payload.context ?? '',
        system_prompt: payload.message,
      });

      this.send(client, 'agent:response', {
        ts: new Date().toISOString(),
        text: result.text,
        tool_calls: result.tool_calls,
        backend: result.backend,
        skills_read: result.skills_read,
        skills_written: result.skills_written,
      });
    } catch (err) {
      this.send(client, 'agent:error', {
        ts: new Date().toISOString(),
        message: (err as Error).message,
      });
    }
  }

  @SubscribeMessage('ping')
  onPing(@MessageBody() payload: PingPayload, @ConnectedSocket() client: AuthClient) {
    this.send(client, 'pong', { ts: Date.now(), client_ts: payload?.ts });
  }

  // ── Utilidades ────────────────────────────────────────────────────────────

  private send(client: WebSocket, event: string, data: unknown) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ event, data }));
    }
  }

  private broadcast(msg: { event: string; data: unknown }) {
    const raw = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(raw);
      }
    }
  }

  private extractToken(req: IncomingMessage): string {
    const auth = req.headers['authorization'];
    if (auth?.startsWith('Bearer ')) return auth.slice(7);

    // Sec-WebSocket-Protocol como alternativa para clientes que no pueden enviar headers
    const proto = req.headers['sec-websocket-protocol'];
    if (typeof proto === 'string' && proto.startsWith('bearer.')) return proto.slice(7);

    throw new Error('token no encontrado');
  }
}
