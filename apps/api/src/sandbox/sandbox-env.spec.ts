import { buildSandboxEnv } from './sandbox.gateway';

describe('buildSandboxEnv', () => {
  const ALLOWED_KEYS = [
    'NEUROTRADER_PLUGINS_DIR',
    'PATH',
    'PYTHONDONTWRITEBYTECODE',
    'PYTHONPATH',
    'PYTHONUNBUFFERED',
    'SANDBOX_CPU_SECONDS',
    'SANDBOX_MEM_MB',
    'SANDBOX_STRICT',
  ] as const;

  const BASE_OPTS = {
    pluginsDir: '/opt/plugins',
    sdkPath: '/opt/sdk',
    cpuSeconds: 60,
    memMb: 512,
    sandboxStrict: true,
  };

  it('returns exactly the allowlist keys — no extras', () => {
    const env = buildSandboxEnv({}, BASE_OPTS);
    const keys = Object.keys(env);
    expect(new Set(keys)).toEqual(new Set(ALLOWED_KEYS));
    expect(keys).toHaveLength(ALLOWED_KEYS.length);
  });

  it('excludes ANTHROPIC_API_KEY even when present in processEnv', () => {
    const env = buildSandboxEnv({ ANTHROPIC_API_KEY: 'sk-secret' }, BASE_OPTS);
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('excludes DATABASE_URL even when present in processEnv', () => {
    const env = buildSandboxEnv({ DATABASE_URL: 'postgres://localhost/db' }, BASE_OPTS);
    expect(env).not.toHaveProperty('DATABASE_URL');
  });

  it('excludes JWT_SECRET even when present in processEnv', () => {
    const env = buildSandboxEnv({ JWT_SECRET: 'supersecret' }, BASE_OPTS);
    expect(env).not.toHaveProperty('JWT_SECRET');
  });

  it('excludes any *_SECRET key', () => {
    const env = buildSandboxEnv({ ALPACA_SECRET: 'abc', BINANCE_API_SECRET: 'xyz' }, BASE_OPTS);
    expect(env).not.toHaveProperty('ALPACA_SECRET');
    expect(env).not.toHaveProperty('BINANCE_API_SECRET');
  });

  it('propagates SANDBOX_STRICT=true when sandboxStrict is true', () => {
    const env = buildSandboxEnv({}, { ...BASE_OPTS, sandboxStrict: true });
    expect(env['SANDBOX_STRICT']).toBe('true');
  });

  it('propagates SANDBOX_STRICT=false when sandboxStrict is false', () => {
    const env = buildSandboxEnv({}, { ...BASE_OPTS, sandboxStrict: false });
    expect(env['SANDBOX_STRICT']).toBe('false');
  });

  it('uses only sdkPath as PYTHONPATH in strict mode (drops host PYTHONPATH)', () => {
    const env = buildSandboxEnv(
      { PYTHONPATH: '/host/site-packages' },
      { ...BASE_OPTS, sandboxStrict: true },
    );
    expect(env['PYTHONPATH']).toBe('/opt/sdk');
  });

  it('appends host PYTHONPATH to sdkPath in non-strict mode', () => {
    const env = buildSandboxEnv(
      { PYTHONPATH: '/host/site-packages' },
      { ...BASE_OPTS, sandboxStrict: false },
    );
    expect(env['PYTHONPATH']).toBe('/opt/sdk:/host/site-packages');
  });

  it('uses only sdkPath when no host PYTHONPATH exists in non-strict mode', () => {
    const env = buildSandboxEnv({}, { ...BASE_OPTS, sandboxStrict: false });
    expect(env['PYTHONPATH']).toBe('/opt/sdk');
  });

  it('sets fixed env control flags', () => {
    const env = buildSandboxEnv({}, BASE_OPTS);
    expect(env['PYTHONDONTWRITEBYTECODE']).toBe('1');
    expect(env['PYTHONUNBUFFERED']).toBe('1');
  });

  it('sets SANDBOX_CPU_SECONDS and SANDBOX_MEM_MB from opts', () => {
    const env = buildSandboxEnv({}, { ...BASE_OPTS, cpuSeconds: 30, memMb: 256 });
    expect(env['SANDBOX_CPU_SECONDS']).toBe('30');
    expect(env['SANDBOX_MEM_MB']).toBe('256');
  });

  it('sets NEUROTRADER_PLUGINS_DIR from opts (not from processEnv)', () => {
    const env = buildSandboxEnv({ NEUROTRADER_PLUGINS_DIR: '/should-be-ignored' }, BASE_OPTS);
    expect(env['NEUROTRADER_PLUGINS_DIR']).toBe('/opt/plugins');
  });
});
