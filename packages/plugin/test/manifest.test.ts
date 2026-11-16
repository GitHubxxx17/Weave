import { describe, expect, it } from 'vitest';
import {
  PluginError,
  pluginApiVersion,
  pluginManifestSchema,
} from '../src/index.js';

const validManifest = {
  id: 'example-tools',
  name: 'Example Tools',
  version: '1.0.0',
  apiVersion: pluginApiVersion,
  capabilities: ['tool'],
} as const;

describe('Plugin Manifest', () => {
  it('accepts a valid manifest', () => {
    expect(pluginManifestSchema.parse(validManifest)).toEqual(validManifest);
  });

  it.each([
    { ...validManifest, id: 'Example Tools' },
    { ...validManifest, id: '-example-tools' },
    { ...validManifest, version: '1.0' },
    { ...validManifest, capabilities: [] },
    { ...validManifest, capabilities: ['tool', 'tool'] },
  ])('rejects an invalid manifest', (manifest) => {
    expect(pluginManifestSchema).toBeDefined();
    expect(() => pluginManifestSchema.parse(manifest)).toThrow();
  });

  it('rejects unknown manifest fields', () => {
    expect(pluginManifestSchema).toBeDefined();
    expect(() =>
      pluginManifestSchema.parse({ ...validManifest, entry: './dist/index.js' }),
    ).toThrow();
  });

  it('preserves a non-empty description', () => {
    expect(
      pluginManifestSchema.parse({
        ...validManifest,
        description: 'Useful tools for a Weave workspace',
      }),
    ).toMatchObject({
      description: 'Useful tools for a Weave workspace',
    });
  });

  it('rejects an empty description', () => {
    expect(pluginManifestSchema).toBeDefined();
    expect(() =>
      pluginManifestSchema.parse({ ...validManifest, description: '' }),
    ).toThrow();
  });
});

describe('PluginError', () => {
  it('keeps a stable name, code and cause', () => {
    const cause = new Error('invalid manifest');
    const error = new PluginError('plugin-invalid-manifest', 'Manifest is invalid', { cause });

    expect(error.name).toBe('PluginError');
    expect(error.code).toBe('plugin-invalid-manifest');
    expect(error.cause).toBe(cause);
  });
});
