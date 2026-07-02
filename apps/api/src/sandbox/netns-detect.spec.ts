/**
 * netns-detect.spec.ts — TDD RED first.
 *
 * Covers:
 *  (a) buildSandboxSpawnCommand — pure spawn-command builder.
 *  (b) detectNetnsIsolation — memoized async probe with an injectable prober.
 */
import {
  buildSandboxSpawnCommand,
  detectNetnsIsolation,
  resetNetnsDetectionCache,
  resolveUnshareBinary,
} from './netns-detect';

describe('buildSandboxSpawnCommand', () => {
  it('wraps with the resolved absolute-path unshare binary (map-root-user + net) when netnsActive is true — never a bare $PATH lookup', () => {
    const result = buildSandboxSpawnCommand('python3', '/opt/sandbox/runner.py', true);

    expect(result).toEqual({
      command: resolveUnshareBinary(),
      args: ['-rn', 'python3', '/opt/sandbox/runner.py'],
    });
    expect(result.command).not.toBe('unshare');
    expect(result.command.startsWith('/')).toBe(true);
  });

  it('returns the plain python3 command with no wrapping when netnsActive is false', () => {
    const result = buildSandboxSpawnCommand('python3', '/opt/sandbox/runner.py', false);

    expect(result).toEqual({
      command: 'python3',
      args: ['/opt/sandbox/runner.py'],
    });
  });

  it('preserves a custom python3Bin override (e.g. PYTHON3_BIN=/usr/bin/python3.11)', () => {
    const result = buildSandboxSpawnCommand('/usr/bin/python3.11', '/opt/sandbox/runner.py', true);

    expect(result).toEqual({
      command: resolveUnshareBinary(),
      args: ['-rn', '/usr/bin/python3.11', '/opt/sandbox/runner.py'],
    });
  });
});

describe('detectNetnsIsolation', () => {
  beforeEach(() => {
    resetNetnsDetectionCache();
  });

  it('resolves true when the injected prober reports netns isolation is available', async () => {
    const prober = jest.fn().mockResolvedValue(true);

    const result = await detectNetnsIsolation(prober);

    expect(result).toBe(true);
    expect(prober).toHaveBeenCalledTimes(1);
  });

  it('resolves false when the injected prober reports netns isolation is unavailable', async () => {
    const prober = jest.fn().mockResolvedValue(false);

    const result = await detectNetnsIsolation(prober);

    expect(result).toBe(false);
    expect(prober).toHaveBeenCalledTimes(1);
  });

  it('memoizes the result — repeated calls do not re-invoke the prober', async () => {
    const prober = jest.fn().mockResolvedValue(true);

    await detectNetnsIsolation(prober);
    await detectNetnsIsolation(prober);
    await detectNetnsIsolation(prober);

    expect(prober).toHaveBeenCalledTimes(1);
  });

  it('re-probes after resetNetnsDetectionCache is called', async () => {
    const prober = jest.fn().mockResolvedValue(true);

    await detectNetnsIsolation(prober);
    resetNetnsDetectionCache();
    await detectNetnsIsolation(prober);

    expect(prober).toHaveBeenCalledTimes(2);
  });
});
