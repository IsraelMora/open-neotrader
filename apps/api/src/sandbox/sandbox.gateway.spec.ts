/**
 * sandbox.gateway.spec.ts — Phase 4 TDD RED: SandboxGateway.analyzePlugin
 *
 * F3-s1: Static AST Analysis — gateway unit tests.
 * These tests run against the real SandboxGateway class with `call` stubbed.
 */
import { SandboxGateway } from './sandbox.gateway';
import type { ConfigService } from '@nestjs/config';
import type { SandboxResponse } from './sandbox.gateway';

function makeSandboxGateway(): { gateway: SandboxGateway; callSpy: jest.SpyInstance } {
  const cfg = {
    get: jest.fn((key: string, defaultVal?: unknown) => defaultVal),
  } as unknown as ConfigService;

  const gateway = new SandboxGateway(cfg);
  const callSpy = jest.spyOn(gateway, 'call').mockResolvedValue({
    ok: true,
    result: { findings: [], summary: { warn_count: 0 } },
  });

  return { gateway, callSpy };
}

describe('SandboxGateway.analyzePlugin', () => {
  beforeEach(() => jest.clearAllMocks());

  it('f3s1-4.1a — calls this.call with cmd=analyze_plugin and the given plugin_id', async () => {
    const { gateway, callSpy } = makeSandboxGateway();

    await gateway.analyzePlugin('my-plugin-id');

    expect(callSpy).toHaveBeenCalledTimes(1);
    expect(callSpy).toHaveBeenCalledWith({
      cmd: 'analyze_plugin',
      plugin_id: 'my-plugin-id',
    });
  });

  it('f3s1-4.1b — returns the SandboxResponse from call (pass-through)', async () => {
    const { gateway, callSpy } = makeSandboxGateway();
    const fakeResponse: SandboxResponse = {
      ok: true,
      result: {
        findings: [
          {
            severity: 'warning',
            category: 'risky_import',
            file: 'plugin.py',
            line: 1,
            message: 'subprocess',
          },
        ],
        summary: { warn_count: 1 },
      },
    };
    callSpy.mockResolvedValue(fakeResponse);

    const result = await gateway.analyzePlugin('plugin-with-findings');

    expect(result).toEqual(fakeResponse);
  });

  it('f3s1-4.1c — passes different plugin_ids through correctly', async () => {
    const { gateway, callSpy } = makeSandboxGateway();

    await gateway.analyzePlugin('alpha');
    await gateway.analyzePlugin('beta');

    expect(callSpy).toHaveBeenNthCalledWith(1, { cmd: 'analyze_plugin', plugin_id: 'alpha' });
    expect(callSpy).toHaveBeenNthCalledWith(2, { cmd: 'analyze_plugin', plugin_id: 'beta' });
  });
});
