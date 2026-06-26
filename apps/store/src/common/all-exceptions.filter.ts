import {
  Catch,
  ExceptionFilter,
  ArgumentsHost,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

/**
 * Filtro global que captura todas las excepciones no manejadas.
 *
 * - `HttpException`: reenvía el status y la respuesta tal como los devuelve NestJS,
 *   preservando la forma `{ statusCode, message, ... }` que lee el frontend.
 * - Cualquier otro error: responde con 500 y registra el error en el logger.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      if (status >= 500) {
        this.logger.error(exception);
      }
      response.status(status).json(body);
      return;
    }

    this.logger.error(exception);
    response.status(500).json({ statusCode: 500, message: 'Error interno' });
  }
}
