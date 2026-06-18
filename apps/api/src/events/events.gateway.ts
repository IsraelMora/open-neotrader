import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { PluginEventsService, type NeuroTraderEvents } from '../plugins/plugin-events.service';
import { TotpRequiredGuard } from '../auth/guards/totp-required.guard';

/** Controlador SSE que reenvía todos los eventos del bus interno (ciclos, plugins, señales) como Server-Sent Events. */
@ApiTags('events')
@ApiBearerAuth()
@UseGuards(TotpRequiredGuard)
@Controller('events')
export class EventsGateway {
  constructor(private readonly pluginEvents: PluginEventsService) {}

  @Get()
  @ApiOperation({ summary: 'Stream SSE de eventos de la plataforma (ciclos, plugins, señales)' })
  /** Abre un stream SSE y suscribe al bus de eventos hasta que el cliente se desconecte. */
  stream(@Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const raw = reply.raw;
    raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    raw.setHeader('Cache-Control', 'no-cache, no-transform');
    raw.setHeader('Connection', 'keep-alive');
    raw.setHeader('X-Accel-Buffering', 'no'); // desactiva buffering en nginx
    raw.flushHeaders();

    const send = (event: string, data: unknown) => {
      try {
        raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        /* cliente desconectado */
      }
    };

    // Heartbeat cada 25s para mantener la conexión viva a través de proxies
    const heartbeat = setInterval(() => {
      try {
        raw.write(': heartbeat\n\n');
      } catch {
        clearInterval(heartbeat);
      }
    }, 25_000);

    // Suscribir a todos los eventos del bus
    const handlers: { [K in keyof NeuroTraderEvents]?: (p: NeuroTraderEvents[K]) => void } = {
      'cycle.started': (p) => send('cycle.started', p),
      'cycle.completed': (p) => send('cycle.completed', p),
      'cycle.failed': (p) => send('cycle.failed', p),
      'plugin.activated': (p) => send('plugin.activated', p),
      'plugin.deactivated': (p) => send('plugin.deactivated', p),
      'plugin.installed': (p) => send('plugin.installed', p),
      'plugin.removed': (p) => send('plugin.removed', p),
      'plugin.signal': (p) => send('plugin.signal', p),
      'plugin.log': (p) => send('plugin.log', p),
    };

    for (const [event, handler] of Object.entries(handlers)) {
      this.pluginEvents.on(event as keyof NeuroTraderEvents, handler);
    }

    // Enviar evento de bienvenida con el estado inicial
    send('connected', { ts: new Date().toISOString(), message: 'Stream SSE conectado' });

    // Limpiar al desconectar
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      for (const [event, handler] of Object.entries(handlers)) {
        this.pluginEvents.off(event as keyof NeuroTraderEvents, handler);
      }
    });
  }
}
