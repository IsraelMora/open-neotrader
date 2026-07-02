/**
 * sandbox.gateway.netns.spec.ts — TDD RED first.
 *
 * Covers wiring of per-subprocess network-namespace isolation into
 * SandboxGateway: SANDBOX_NETNS_ISOLATION modes (auto/require/off),
 * spawn-command wrapping, fail-fast startup for `require`, and that the
 * timeout kill path stays correct (same-PID SIGKILL — unshare execs in
 * place, no fork, per netns-detect.ts).
 */
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import type { ConfigService } from '@nestjs/config';
import { SandboxGateway } from './sandbox.gateway';
import * as netnsDetect from './netns-detect';
import { resolveUnshareBinary } from './netns-detect';

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

jest.mock('./netns-detect', () => {
  const actual: object = jest.requireActual('./netns-detect');
  return {
    ...actual,
    detectNetnsIsolation: jest.fn(),
  };
});

const spawnMock = spawn as unknown as jest.Mock;
const detectNetnsIsolationMock = netnsDetect.detectNetnsIsolation as jest.Mock;

interface FakeProc extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: jest.Mock; end: jest.Mock };
  kill: jest.Mock;
  pid: number;
}

function makeFakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: jest.fn(), end: jest.fn() };
  proc.kill = jest.fn();
  proc.pid = 4242;
  return proc;
}

/** Wires spawnMock to return a proc that resolves successfully on the next tick. */
function spawnResolvesOk(): FakeProc {
  const proc = makeFakeProc();
  spawnMock.mockReturnValue(proc);
  setImmediate(() => {
    proc.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, result: 'done' })));
    proc.emit('close', 0);
  });
  return proc;
}

function makeCfg(overrides: Record<string, unknown> = {}): ConfigService {
  return {
    get: jest.fn((key: string, defaultVal?: unknown) =>
      key in overrides ? overrides[key] : defaultVal,
    ),
  } as unknown as ConfigService;
}

describe('SandboxGateway — netns isolation wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('auto + detected → wraps spawn with unshare -rn', async () => {
    detectNetnsIsolationMock.mockResolvedValue(true);
    const cfg = makeCfg({ SANDBOX_NETNS_ISOLATION: 'auto', PYTHON3_BIN: 'python3' });
    const gateway = new SandboxGateway(cfg);
    await gateway.onModuleInit();

    spawnResolvesOk();
    await gateway.call({ cmd: 'list_plugins', active_ids: [] });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args] = spawnMock.mock.calls[0] as [string, string[], unknown];
    expect(command).toBe(resolveUnshareBinary());
    expect(command.startsWith('/')).toBe(true);
    expect(args[0]).toBe('-rn');
    expect(args).toContain('python3');
  });

  it('auto + not detected → plain python spawn and a prominent log.warn about unenforced network isolation', async () => {
    detectNetnsIsolationMock.mockResolvedValue(false);
    const cfg = makeCfg({ SANDBOX_NETNS_ISOLATION: 'auto', PYTHON3_BIN: 'python3' });
    const gateway = new SandboxGateway(cfg);
    const warnSpy = jest.spyOn((gateway as unknown as { log: { warn: jest.Mock } }).log, 'warn');

    await gateway.onModuleInit();

    spawnResolvesOk();
    await gateway.call({ cmd: 'list_plugins', active_ids: [] });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args] = spawnMock.mock.calls[0] as [string, string[], unknown];
    expect(command).toBe('python3');
    expect(args).not.toContain('unshare');

    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/network|isolat/i));
    const warnedMessages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnedMessages.some((m) => /not enforced|not available|no está/i.test(m))).toBe(true);
  });

  it('require + not detected → onModuleInit rejects (fails fast at startup, not per-request)', async () => {
    detectNetnsIsolationMock.mockResolvedValue(false);
    const cfg = makeCfg({ SANDBOX_NETNS_ISOLATION: 'require', PYTHON3_BIN: 'python3' });
    const gateway = new SandboxGateway(cfg);

    await expect(gateway.onModuleInit()).rejects.toThrow(/netns|network.namespace|isolation/i);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('require + detected → onModuleInit resolves and spawn is netns-wrapped', async () => {
    detectNetnsIsolationMock.mockResolvedValue(true);
    const cfg = makeCfg({ SANDBOX_NETNS_ISOLATION: 'require', PYTHON3_BIN: 'python3' });
    const gateway = new SandboxGateway(cfg);

    await expect(gateway.onModuleInit()).resolves.not.toThrow();

    spawnResolvesOk();
    await gateway.call({ cmd: 'list_plugins', active_ids: [] });

    const [command] = spawnMock.mock.calls[0] as [string, string[], unknown];
    expect(command).toBe(resolveUnshareBinary());
    expect(command.startsWith('/')).toBe(true);
  });

  it('off → plain python spawn, no probing, and a visible log line that isolation is intentionally disabled', async () => {
    const cfg = makeCfg({ SANDBOX_NETNS_ISOLATION: 'off', PYTHON3_BIN: 'python3' });
    const gateway = new SandboxGateway(cfg);
    const warnSpy = jest.spyOn((gateway as unknown as { log: { warn: jest.Mock } }).log, 'warn');

    await gateway.onModuleInit();

    expect(detectNetnsIsolationMock).not.toHaveBeenCalled();

    spawnResolvesOk();
    await gateway.call({ cmd: 'list_plugins', active_ids: [] });

    const [command, args] = spawnMock.mock.calls[0] as [string, string[], unknown];
    expect(command).toBe('python3');
    expect(args).not.toContain('unshare');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/disabled|off|desactivada/i));
  });

  it('passes the exact same sandboxEnv object contents to spawn regardless of netns wrapping', async () => {
    detectNetnsIsolationMock.mockResolvedValue(true);
    const cfg = makeCfg({ SANDBOX_NETNS_ISOLATION: 'auto', PYTHON3_BIN: 'python3' });
    const gateway = new SandboxGateway(cfg);
    await gateway.onModuleInit();

    spawnResolvesOk();
    await gateway.call({ cmd: 'list_plugins', active_ids: [] });

    const [, , spawnOpts] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ];
    expect(typeof spawnOpts.env['PATH']).toBe('string');
    expect(typeof spawnOpts.env['PYTHONPATH']).toBe('string');
    expect(typeof spawnOpts.env['SANDBOX_STRICT']).toBe('string');
    expect(spawnOpts.env).not.toHaveProperty('unshare');
  });

  it('timeout still kills the same subprocess PID with SIGKILL when netns-wrapped (unshare execs in place, no fork)', async () => {
    jest.useFakeTimers();
    detectNetnsIsolationMock.mockResolvedValue(true);
    const cfg = makeCfg({
      SANDBOX_NETNS_ISOLATION: 'auto',
      PYTHON3_BIN: 'python3',
      SANDBOX_TIMEOUT_MS: 30_000,
    });
    const gateway = new SandboxGateway(cfg);
    await gateway.onModuleInit();

    const proc = makeFakeProc();
    spawnMock.mockReturnValue(proc);

    const callPromise = gateway.call({ cmd: 'list_plugins', active_ids: [] });

    jest.advanceTimersByTime(30_000);
    const result = await callPromise;

    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timeout/i);

    jest.useRealTimers();
  });
});
