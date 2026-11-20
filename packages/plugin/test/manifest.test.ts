import { describe, expect, it } from 'vitest';
import { PluginError, pluginApiVersion, pluginManifestSchema } from '../src/index.js';

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
    expect(() => pluginManifestSchema.parse({ ...validManifest, description: '' })).toThrow();
  });
});

describe('Plugin Manifest declarations', () => {
  const declared = {
    ...validManifest,
    capabilities: ['tool', 'llm-provider', 'prompt'],
    host: 'in-process',
    engines: { weave: '>=1.2.0 <2.0.0' },
    contributes: {
      tools: ['echo'],
      providers: ['local-model'],
      promptSections: ['style'],
      services: ['example.cache'],
    },
    permissions: [
      'workspace:read',
      'workspace:write',
      'process:spawn',
      'network:request',
      'service:weave.tools.registry',
    ],
  };

  it('accepts a manifest that declares every optional field', () => {
    expect(pluginManifestSchema.parse(declared)).toEqual(declared);
  });

  it('accepts empty declarations, which close the list instead of leaving it open', () => {
    const parsed = pluginManifestSchema.parse({
      ...validManifest,
      contributes: {},
      permissions: [],
    });

    expect(parsed.contributes).toEqual({});
    expect(parsed.permissions).toEqual([]);
  });

  it.each(['in-process', 'mcp', 'subprocess'])('accepts host %s', (host) => {
    expect(pluginManifestSchema.parse({ ...validManifest, host }).host).toBe(host);
  });

  it.each([
    ['an unknown host', { host: 'docker' }],
    ['an engines range outside the supported subset', { engines: { weave: '>=1.2' } }],
    ['an empty engines range', { engines: { weave: '' } }],
    ['an unknown engines field', { engines: { weave: '*', node: '>=20.0.0' } }],
    ['an unknown contributes kind', { contributes: { commands: ['review'] } }],
    ['an empty contributed name', { contributes: { tools: [''] } }],
    ['a duplicate contributed tool', { contributes: { tools: ['echo', 'echo'] } }],
    ['a malformed service id', { contributes: { services: ['Not A Service'] } }],
    ['an unknown permission', { permissions: ['workspace:delete'] }],
    ['a malformed service permission', { permissions: ['service:Not A Service'] }],
    ['a bare service permission', { permissions: ['service:'] }],
    ['a duplicate permission', { permissions: ['process:spawn', 'process:spawn'] }],
  ])('rejects %s', (_label, extra) => {
    expect(() => pluginManifestSchema.parse({ ...validManifest, ...extra })).toThrow();
  });

  it.each([
    ['tools', 'tool', 'prompt'],
    ['providers', 'llm-provider', 'tool'],
    ['promptSections', 'prompt', 'tool'],
  ])('requires the capability behind contributes.%s', (key, capability, other) => {
    const names = { [key]: ['x'] };

    const rejected = pluginManifestSchema.safeParse({
      ...validManifest,
      capabilities: [other],
      contributes: names,
    });
    expect(rejected.success).toBe(false);
    expect(rejected.error?.issues.map((issue) => issue.message)).toContain(
      `contributes.${key} requires the "${capability}" capability`,
    );
    expect(
      pluginManifestSchema.safeParse({
        ...validManifest,
        capabilities: [capability],
        contributes: names,
      }).success,
    ).toBe(true);
  });

  it('does not require a capability for a kind that lists no names', () => {
    expect(
      pluginManifestSchema.parse({
        ...validManifest,
        capabilities: ['prompt'],
        contributes: { tools: [] },
      }),
    ).toMatchObject({ contributes: { tools: [] } });
  });

  it('keeps accepting the original manifest shape unchanged', () => {
    const parsed = pluginManifestSchema.parse(validManifest);

    expect(parsed.host).toBeUndefined();
    expect(parsed.engines).toBeUndefined();
    expect(parsed.contributes).toBeUndefined();
    expect(parsed.permissions).toBeUndefined();
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
