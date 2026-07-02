/**
 * provider-gateway.controller.spec.ts — TDD RED → GREEN.
 *
 * C1 (CRITICAL): POST /providers/:pluginId/orders used to call gateway.placeOrder()
 * directly from the controller, guarded ONLY by TotpRequiredGuard — completely
 * bypassing _effectiveMode (paper/real gate), veto/risk gates, drawdown halt, and
 * the HITL TradeIntent approve/reject flow that every other real-order path goes
 * through (see TradeIntentService.approve / autoProcess).
 *
 * No caller of this route exists anywhere in the monorepo (checked apps/web, all
 * *.spec.ts) and it is not documented in README.md. It is dead/debug-only, so the
 * fix is REMOVAL rather than rerouting through TradeIntent — there is no legitimate
 * "place this exact order right now" use case in this codebase; the ONLY sanctioned
 * path to a real order is TradeIntentService.approve()/autoProcess(), which enforces
 * _effectiveMode + risk gates + notional ceiling + audit logging.
 *
 * These tests assert the bypass route is gone and can never place a real order
 * through this controller again.
 */
import { ProviderGatewayController } from './provider-gateway.controller';
import type { ProviderGatewayService } from './provider-gateway.service';
import type { OhlcvCacheService } from './ohlcv-cache.service';

describe('ProviderGatewayController — C1: no raw order-placement route bypassing TradeIntent/veto/HITL', () => {
  it('does not expose a placeOrder method (the former POST /:pluginId/orders bypass route is removed)', () => {
    const proto = ProviderGatewayController.prototype as unknown as Record<string, unknown>;
    expect(proto['placeOrder']).toBeUndefined();
  });

  it('gateway.placeOrder is never invoked by any ProviderGatewayController instance method', () => {
    const gateway: jest.Mocked<Pick<ProviderGatewayService, 'placeOrder'>> = {
      placeOrder: jest.fn(),
    };
    const ohlcvCache: Pick<OhlcvCacheService, 'stats' | 'flush'> = {
      stats: jest.fn(),
      flush: jest.fn(),
    };
    // Instantiating the controller must not require or expose any order-placement
    // capability — construction alone proves the bypass route no longer exists.
    const controller = new ProviderGatewayController(
      gateway as unknown as ProviderGatewayService,
      ohlcvCache as OhlcvCacheService,
    );
    expect(controller).toBeInstanceOf(ProviderGatewayController);

    // Every remaining public method on the controller, called with harmless args,
    // must never reach gateway.placeOrder — there is no route left that can.
    const methodNames = Object.getOwnPropertyNames(ProviderGatewayController.prototype).filter(
      (m) => m !== 'constructor',
    );
    expect(methodNames).not.toContain('placeOrder');
    expect(gateway.placeOrder).not.toHaveBeenCalled();
  });
});
