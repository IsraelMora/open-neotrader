import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import type { Request } from 'express';

interface AuthenticatedRequest extends Request {
  user?: { totp_verified?: boolean };
}

/** Guard que exige que el JWT tenga totp_verified=true; bloquea con 403 si no se ha completado el segundo factor. */
@Injectable()
export class TotpRequiredGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!req.user) throw new UnauthorizedException();
    if (!req.user.totp_verified) throw new ForbiddenException('Se requiere verificación TOTP');
    return true;
  }
}
