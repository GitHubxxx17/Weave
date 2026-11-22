import { describe, expect, it } from 'vitest';

import {
  attributedSkillContributionSchema,
  createPluginKernel,
  createPluginSdk,
  pluginApiVersion,
  pluginManifestSchema,
  skillContributionSchema,
  skillsExtensionPoint,
  type AttributedSkillContribution,
  type KernelPlugin,
  type PluginManifest,
  type SkillContribution,
} from '../src/index.js';

const contribution: SkillContribution = {
  name: 'review-code',
  description: 'Review the current changes',
  instructions: ' Keep whitespace.\n',
  invocation: { user: true, model: false },
  resources: { 'references/checklist.md': 'Check error handling.\n' },
};

const manifest = (id: string, overrides: Partial<PluginManifest> = {}): PluginManifest => ({
  id,
  name: id,
  apiVersion: '1.0.0',
  version: '1.0.0',
  capabilities: ['skill'],
  contributes: { skills: ['review-code'] },
  permissions: [],
  ...overrides,
});

const plugin = (
  id: string,
  values: unknown[],
  overrides: Partial<PluginManifest> = {},
): KernelPlugin => ({
  manifest: manifest(id, overrides),
  setup(env) {
    env.contribute(skillsExtensionPoint, (api) => {
      for (const value of values) api.addSkill(value as SkillContribution);
    });
  },
});

describe('declarative Skill contributions', () => {
  it('extends API 1.0 additively and exposes the host seam through the SDK', () => {
    expect(pluginApiVersion).toBe('1.0.0');
    expect(createPluginSdk().skillsExtensionPoint).toBe(skillsExtensionPoint);
    expect(pluginManifestSchema.parse(manifest('reviewer')).contributes?.skills).toEqual([
      'review-code',
    ]);
    expect(
      pluginManifestSchema.safeParse(manifest('reviewer', { capabilities: ['tool'] })).success,
    ).toBe(false);
    expect(
      pluginManifestSchema.safeParse(
        manifest('reviewer', { contributes: { skills: ['Bad Name'] } }),
      ).success,
    ).toBe(false);
  });

  it('normalizes descriptions and instruction newlines, preserving body whitespace', () => {
    expect(
      skillContributionSchema.parse({
        ...contribution,
        description: ' Review\n  changes ',
        instructions: '\ufeff Keep\r\n',
      }),
    ).toMatchObject({
      description: 'Review changes',
      instructions: ' Keep\n',
    });
  });

  it.each([
    { name: 'Bad Name' },
    { name: 'a'.repeat(65) },
    { description: ' ' },
    { instructions: ' \n ' },
    { instructions: '中'.repeat(22_000) },
    { instructions: 'bad\0body' },
    { execute: () => undefined },
    { pluginId: 'spoofed' },
    { invocation: { user: true } },
    ...[
      '../outside',
      '/absolute',
      'a//b',
      './a',
      'C:/a',
      'a\\b',
      'https://a',
      'a/../b',
      '__proto__',
    ].map((key) => ({ resources: { [key]: 'bad' } })),
    { resources: { 'big.txt': 'x'.repeat(256 * 1024 + 1) } },
    { resources: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`r${i}`, 'x'])) },
    {
      resources: Object.fromEntries(
        Array.from({ length: 9 }, (_, i) => [`r${i}`, 'x'.repeat(256 * 1024)]),
      ),
    },
  ])('rejects invalid contribution %#', (overrides) => {
    expect(skillContributionSchema.safeParse({ ...contribution, ...overrides }).success).toBe(
      false,
    );
  });

  it('attributes, detaches and deeply freezes contributions before the collector sees them', async () => {
    const mutable = {
      ...contribution,
      invocation: { user: true, model: false },
      resources: { 'a.txt': 'original' },
    };
    const kernel = createPluginKernel();
    await kernel.register(plugin('reviewer', [mutable]));
    await kernel.seal();
    const received: AttributedSkillContribution[] = [];
    kernel.extensions.collect(skillsExtensionPoint, {
      addSkill: (skill) => received.push(attributedSkillContributionSchema.parse(skill)),
    });
    const frozen: unknown[] = [];
    kernel.extensions.collect(skillsExtensionPoint, { addSkill: (skill) => frozen.push(skill) });
    mutable.resources['a.txt'] = 'changed';
    mutable.invocation.model = true;
    expect(received[0]).toMatchObject({
      pluginId: 'reviewer',
      resources: { 'a.txt': 'original' },
      invocation: { model: false },
    });
    expect(Object.isFrozen(frozen[0])).toBe(true);
    expect(Object.isFrozen((frozen[0] as SkillContribution).resources)).toBe(true);
    expect(Object.isFrozen((frozen[0] as SkillContribution).invocation)).toBe(true);
    expect(kernel.plugins()[0]?.contributed.skills).toEqual(['review-code']);
    expect(Object.isFrozen(kernel.plugins()[0]?.contributed.skills)).toBe(true);
    await kernel.dispose();
  });

  it('rejects undeclared and malformed Skills with contributor attribution', async () => {
    for (const [values, overrides, code] of [
      [[contribution], { contributes: {} }, 'plugin-contributes-exceeds-manifest'],
      [[{ ...contribution, instructions: '' }], {}, 'plugin-invalid-definition'],
      [[{ ...contribution, pluginId: 'other' }], {}, 'plugin-invalid-definition'],
    ] as const) {
      const kernel = createPluginKernel();
      await kernel.register(plugin('reviewer', [...values], overrides));
      await kernel.seal();
      expect(() =>
        kernel.extensions.collect(skillsExtensionPoint, { addSkill: () => undefined }),
      ).toThrowError(expect.objectContaining({ code, pluginId: 'reviewer' }));
      await kernel.dispose();
    }
  });

  it('requires the skill capability even if contributes is omitted', async () => {
    const kernel = createPluginKernel();
    await expect(
      kernel.register(
        plugin('reviewer', [contribution], { capabilities: ['tool'], contributes: undefined }),
      ),
    ).rejects.toMatchObject({ code: 'plugin-capability-not-declared', pluginId: 'reviewer' });
    await kernel.dispose();
  });

  it('rejects same-owner duplicates across separate contribution callbacks, while allowing different owners', async () => {
    const kernel = createPluginKernel();
    await kernel.register({
      manifest: manifest('reviewer'),
      setup(env) {
        env.contribute(skillsExtensionPoint, (api) => api.addSkill(contribution));
        env.contribute(skillsExtensionPoint, (api) => api.addSkill(contribution));
      },
    });
    await kernel.seal();
    expect(() =>
      kernel.extensions.collect(skillsExtensionPoint, { addSkill: () => undefined }),
    ).toThrowError(
      expect.objectContaining({ code: 'plugin-invalid-definition', pluginId: 'reviewer' }),
    );
    await kernel.dispose();
    const another = createPluginKernel();
    await another.register(plugin('first', [contribution]));
    await another.register(plugin('second', [contribution]));
    await another.seal();
    const owners: string[] = [];
    another.extensions.collect(skillsExtensionPoint, {
      addSkill: (skill) => owners.push(attributedSkillContributionSchema.parse(skill).pluginId),
    });
    expect(owners).toEqual(['first', 'second']);
    await another.dispose();
  });
});
