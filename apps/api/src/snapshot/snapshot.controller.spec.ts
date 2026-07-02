/**
 * real-money-accounting — SnapshotController.realEquityCurve
 *
 * Tests that:
 * - GET /snapshot/real-equity-curve calls svc.getRealEquityCurve with the parsed
 *   `limit` query param, defaulting to 252 (mirrors the existing equity-curve route).
 * - Returns whatever the service resolves to.
 *
 * Note: routes in this controller have no per-route @UseGuards decorator — auth is
 * enforced globally via APP_GUARD -> JwtAuthGuard (app.module.ts). This test does not
 * re-verify global guard wiring (no existing pattern for that in this repo); it only
 * asserts the controller class carries no local guard/bypass decorator, consistent
 * with its siblings.
 */
import 'reflect-metadata';
import { SnapshotController } from './snapshot.controller';
import type { SnapshotService } from './snapshot.service';
import { GUARDS_METADATA } from '@nestjs/common/constants';

function makeService(): jest.Mocked<Pick<SnapshotService, 'getRealEquityCurve'>> {
  return {
    getRealEquityCurve: jest
      .fn()
      .mockResolvedValue([{ ts: '2026-06-01T00:00:00.000Z', equity: 100, hwm: 100 }]),
  };
}

describe('SnapshotController.realEquityCurve', () => {
  it('calls svc.getRealEquityCurve with the parsed limit and returns its result', async () => {
    const svc = makeService();
    const controller = new SnapshotController(svc as unknown as SnapshotService);

    const result = await controller.realEquityCurve(100);

    expect(svc.getRealEquityCurve).toHaveBeenCalledWith(100);
    expect(result).toEqual([{ ts: '2026-06-01T00:00:00.000Z', equity: 100, hwm: 100 }]);
  });

  it('defaults limit to 252 via the route pipe default (controller method receives resolved value)', async () => {
    const svc = makeService();
    const controller = new SnapshotController(svc as unknown as SnapshotService);

    await controller.realEquityCurve(252);

    expect(svc.getRealEquityCurve).toHaveBeenCalledWith(252);
  });

  it('has no local @UseGuards decorator on the controller class (relies on global APP_GUARD)', () => {
    const guards: unknown = Reflect.getMetadata(GUARDS_METADATA, SnapshotController);
    expect(guards).toBeUndefined();
  });
});
