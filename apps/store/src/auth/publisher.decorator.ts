import { createParamDecorator, ExecutionContext } from '@nestjs/common';

interface AuthenticatedRequest {
  publisherId: string;
  publicKey: string;
}

export const Publisher = createParamDecorator(
  (
    _data: unknown,
    ctx: ExecutionContext,
  ): { id: string; publicKey: string } => {
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    return { id: req.publisherId, publicKey: req.publicKey };
  },
);
