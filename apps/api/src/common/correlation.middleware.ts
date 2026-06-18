import { Injectable, NestMiddleware } from '@nestjs/common';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { v4 as uuidv4 } from 'uuid';

/**
 * Añade X-Correlation-Id a cada request/response.
 * Usa el valor del header entrante si ya existe (trazas de upstream),
 * o genera uno nuevo. Esencial para correlacionar logs de ciclo con
 * tool calls de plugins en el mismo contexto.
 */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: FastifyRequest['raw'], res: FastifyReply['raw'], next: () => void) {
    const existing = (req.headers['x-correlation-id'] as string | undefined)?.slice(0, 64);
    const id = existing ?? uuidv4();
    req.headers['x-correlation-id'] = id;
    res.setHeader('X-Correlation-Id', id);
    next();
  }
}
