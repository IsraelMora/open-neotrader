import { resolveCredentials } from './sandbox.gateway';
import type { PluginManifest } from '../plugins/manifest';

function makeManifest(credKeys: string[]): PluginManifest {
  const credentials: Record<string, { label: string }> = {};
  for (const k of credKeys) {
    credentials[k] = { label: k };
  }
  return {
    plugin: { id: 'test-plugin', name: 'Test', version: '1.0.0', type: 'provider' },
    credentials: credKeys.length > 0 ? credentials : undefined,
  } as unknown as PluginManifest;
}

describe('resolveCredentials', () => {
  it('returns only the declared credential keys resolved from processEnv', () => {
    const manifest = makeManifest(['ALPACA_API_KEY', 'ALPACA_API_SECRET']);
    const env = {
      ALPACA_API_KEY: 'key-value',
      ALPACA_API_SECRET: 'secret-value',
      ANTHROPIC_API_KEY: 'should-not-leak',
    };
    const result = resolveCredentials(manifest, env);
    expect(result).toEqual({
      ALPACA_API_KEY: 'key-value',
      ALPACA_API_SECRET: 'secret-value',
    });
  });

  it('excludes undeclared secrets even if present in processEnv', () => {
    const manifest = makeManifest(['ALPACA_API_KEY']);
    const env = {
      ALPACA_API_KEY: 'key-value',
      BINANCE_API_KEY: 'should-not-leak',
      DATABASE_URL: 'should-not-leak',
      JWT_SECRET: 'should-not-leak',
    };
    const result = resolveCredentials(manifest, env);
    expect(result).toEqual({ ALPACA_API_KEY: 'key-value' });
    expect(result).not.toHaveProperty('BINANCE_API_KEY');
    expect(result).not.toHaveProperty('DATABASE_URL');
    expect(result).not.toHaveProperty('JWT_SECRET');
  });

  it('returns empty object when manifest has no credentials section', () => {
    const manifest = makeManifest([]);
    const env = { ANTHROPIC_API_KEY: 'secret', DATABASE_URL: 'db' };
    const result = resolveCredentials(manifest, env);
    expect(result).toEqual({});
  });

  it('returns empty object when credentials section is undefined', () => {
    const manifest = {
      plugin: { id: 'no-creds', name: 'No Creds', version: '1.0.0', type: 'discipline' },
    } as unknown as PluginManifest;
    const env = { SOME_SECRET: 'value' };
    const result = resolveCredentials(manifest, env);
    expect(result).toEqual({});
  });

  it('returns empty string for a declared key not present in processEnv', () => {
    const manifest = makeManifest(['MISSING_KEY']);
    const env = {};
    const result = resolveCredentials(manifest, env);
    // declared but missing from env → empty string (not undefined, not leaked)
    expect(result).toHaveProperty('MISSING_KEY');
    expect(result['MISSING_KEY']).toBe('');
  });

  it('result is an object that can be safely placed in context.credentials', () => {
    const manifest = makeManifest(['MY_API_KEY']);
    const env = { MY_API_KEY: 'val' };
    const credentials = resolveCredentials(manifest, env);
    // Simulate wiring into a context object
    const context = { operator: 'test', credentials };
    expect(context.credentials).toEqual({ MY_API_KEY: 'val' });
  });
});
