import { createParamDecorator, ExecutionContext } from '@nestjs/common';

interface AuthenticatedRequest {
  publisherId: string;
  publicKey: string;
}

/**
 * Decorador de parámetro que extrae el publisher autenticado de la petición.
 *
 * Solo es válido en rutas protegidas por `SignatureGuard`, que es quien
 * adjunta `publisherId` y `publicKey` al request tras verificar la firma.
 *
 * @example
 * ```ts
 * \@Post()
 * \@UseGuards(SignatureGuard)
 * create(\@Publisher() pub: { id: string; publicKey: string }) { ... }
 * ```
 */
export const Publisher = createParamDecorator(
  (
    _data: unknown,
    ctx: ExecutionContext,
  ): { id: string; publicKey: string } => {
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    return { id: req.publisherId, publicKey: req.publicKey };
  },
);
