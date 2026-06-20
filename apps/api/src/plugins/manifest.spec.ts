/**
 * manifest.spec.ts — Phase 1, Tasks 1.4-1.5 TDD RED→GREEN
 *
 * F5-s1: Tests for min_sdk_version optional field in PluginManifest.
 * AC-7: manifest with plugin.min_sdk_version parses and is accessible
 * AC-8: manifest without min_sdk_version leaves it undefined; validateManifest returns no errors
 */
import type { PluginManifest } from './manifest';
import { validateManifest } from './manifest';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMinimalManifest(
  overrides: Partial<PluginManifest['plugin']> = {},
): PluginManifest {
  return {
    plugin: {
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      type: 'skill',
      ...overrides,
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PluginManifest — min_sdk_version field (AC-7, AC-8)', () => {
  it('accepts min_sdk_version on the plugin object and exposes it as a string', () => {
    // AC-7: manifest with min_sdk_version parses cleanly and value is accessible
    const manifest = makeMinimalManifest({ min_sdk_version: '0.1.0' });
    expect(manifest.plugin.min_sdk_version).toBe('0.1.0');
  });

  it('allows min_sdk_version to be absent — field is undefined', () => {
    // AC-8: absent field → undefined (TypeScript optional field)
    const manifest = makeMinimalManifest();
    expect(manifest.plugin.min_sdk_version).toBeUndefined();
  });

  it('validateManifest does not error when min_sdk_version is present', () => {
    // AC-7: validateManifest must return empty errors when field is present
    const manifest = makeMinimalManifest({ min_sdk_version: '0.1.0' });
    const errors = validateManifest(manifest);
    expect(errors).toHaveLength(0);
  });

  it('validateManifest does not error when min_sdk_version is absent', () => {
    // AC-8: validateManifest must return empty errors when field is absent
    const manifest = makeMinimalManifest();
    const errors = validateManifest(manifest);
    expect(errors).toHaveLength(0);
  });

  it('min_sdk_version is typed as optional string — can be set to various semver strings', () => {
    // AC-7: the field must accept any semver-like string (format validation out of scope)
    const versions = ['0.1.0', '1.0.0', '2.3.4', '0.0.1'];
    for (const v of versions) {
      const manifest = makeMinimalManifest({ min_sdk_version: v });
      expect(manifest.plugin.min_sdk_version).toBe(v);
    }
  });
});
