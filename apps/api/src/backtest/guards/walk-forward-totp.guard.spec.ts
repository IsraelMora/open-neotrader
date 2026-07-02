/**
 * walk-forward-totp.guard.spec.ts — TDD RED → GREEN.
 *
 * H (HIGH): POST /backtest/walk-forward with a `strategy_row_id` PERSISTS a ROBUSTO
 * verdict on the Strategy row (StrategyService.recordWalkForward) — the ONLY way to
 * open/refresh the real-money gate (TradeIntentService._checkWalkForwardGate). That
 * makes it money-adjacent, same class as PATCH /execution/config and trade approve/
 * reject, which already require TOTP.
 *
 * Display-only walk-forward runs (no strategy_row_id — nothing persisted) stay
 * TOTP-free so exploring a strategy isn't gated behind a second factor.
 */
import 'reflect-metadata';
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { WalkForwardTotpGuard } from './walk-forward-totp.guard';

function makeContext(body: Record<string, unknown>, user?: { totp_verified?: boolean }) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ body, user }),
    }),
  } as unknown as ExecutionContext;
}

describe('WalkForwardTotpGuard', () => {
  const guard = new WalkForwardTotpGuard();

  it('allows the request when strategy_row_id is absent (display-only, nothing persisted)', () => {
    expect(guard.canActivate(makeContext({}))).toBe(true);
  });

  it('allows the request when strategy_row_id is absent even with no user on the request', () => {
    expect(guard.canActivate(makeContext({ strategy: 'trend-following' }))).toBe(true);
  });

  it('rejects with 401 when strategy_row_id is present but there is no authenticated user', () => {
    expect(() => guard.canActivate(makeContext({ strategy_row_id: 's_1' }))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects with 403 when strategy_row_id is present and totp_verified is false', () => {
    expect(() =>
      guard.canActivate(makeContext({ strategy_row_id: 's_1' }, { totp_verified: false })),
    ).toThrow(ForbiddenException);
  });

  it('allows the request when strategy_row_id is present and totp_verified is true', () => {
    expect(
      guard.canActivate(makeContext({ strategy_row_id: 's_1' }, { totp_verified: true })),
    ).toBe(true);
  });
});
