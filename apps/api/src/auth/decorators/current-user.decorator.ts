import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { User } from '@prisma/client';

interface AuthenticatedRequest extends Request {
  user: User & { totp_verified: boolean };
}

/** Decorador de parámetro que inyecta el usuario autenticado desde el request. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) =>
    ctx.switchToHttp().getRequest<AuthenticatedRequest>().user,
);
