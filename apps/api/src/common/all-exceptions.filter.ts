import { Catch, ExceptionFilter, ArgumentsHost, HttpException, Logger } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

/**
 * Filtro global de excepciones (manager de errores estandarizado del backend, gemelo del
 * de la tienda pero para Fastify).
 *
 * - Solo actúa sobre contexto HTTP; para WS/otros re-lanza para no interferir con su manejo.
 * - `HttpException`: reenvía status + cuerpo TAL CUAL los arma NestJS, preservando la forma
 *   `{ statusCode, message, ... }` que el frontend lee (api.ts unwrapJsonError).
 * - Cualquier otro error: 500 con cuerpo `{ statusCode, message }` y log a nivel error.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception;

    const reply = host.switchToHttp().getResponse<FastifyReply>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (status >= 500) this.logger.error(exception);
      void reply.status(status).send(exception.getResponse());
      return;
    }

    this.logger.error(exception);
    void reply.status(500).send({ statusCode: 500, message: 'Error interno' });
  }
}
