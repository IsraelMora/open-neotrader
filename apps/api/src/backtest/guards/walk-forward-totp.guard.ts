import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import type { Request } from 'express';

interface WalkForwardRequest extends Request {
  user?: { totp_verified?: boolean };
  body: { strategy_row_id?: string };
}

/**
 * Guards POST /backtest/walk-forward. Persisting a walk-forward verdict onto a Strategy
 * row (StrategyService.recordWalkForward, triggered when `strategy_row_id` is present) is
 * the ONLY way to open/refresh the real-money gate (TradeIntentService._checkWalkForwardGate
 * requires a fresh ROBUSTO verdict) — so it's money-adjacent, same class as
 * PATCH /execution/config and trade approve/reject, which already require TOTP.
 *
 * Display-only walk-forward runs (no strategy_row_id — nothing is persisted) stay
 * TOTP-free: exploring/backtesting a strategy shouldn't require a second factor.
 */
@Injectable()
export class WalkForwardTotpGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<WalkForwardRequest>();
    if (!req.body?.strategy_row_id) return true;

    if (!req.user) throw new UnauthorizedException();
    if (!req.user.totp_verified) throw new ForbiddenException('Se requiere verificación TOTP');
    return true;
  }
}
