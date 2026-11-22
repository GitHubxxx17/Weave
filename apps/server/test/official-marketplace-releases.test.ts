import { describe, expect, it } from 'vitest';
import { createOfficialMarketplacePolicy } from '../src/official-marketplace-releases.js';
import {
  officialEntry,
  officialFamily,
  officialRelease,
} from './support/official-marketplace-fixture.js';

describe('exact official marketplace release policy', () => {
  it('matches full validated identities despite object property order and uses host display data', () => {
    const policy = createOfficialMarketplacePolicy([officialFamily()]);
    const entry = officialEntry();
    const first = entry.releases[0]!;
    first.manifest = {
      permissions: first.manifest.permissions,
      contributes: { commands: ['notes'], tools: ['read-note', 'write-note'] },
      engines: { weave: '>=1.0.0' },
      capabilities: ['tool', 'command'],
      description: 'A reviewed fixture manifest',
      apiVersion: '1.0.0',
      version: '1.0.0',
      name: 'Fixture payload',
      id: 'fixture-official-skills',
    };
    expect(policy.assertEntry(entry)).toEqual({
      category: 'official',
      display: {
        name: 'Host-owned Skills',
        description: 'Host-owned description',
        publisher: 'Weave',
        tags: ['host-owned'],
      },
    });
    expect(policy.assertEntry({ ...entry, releases: [first] }).category).toBe('official');
  });

  it.each([
    [
      'repository',
      (item: ReturnType<typeof officialRelease>) => {
        item.source.repository = 'https://github.com/other/official-skills';
      },
    ],
    [
      'commit',
      (item: ReturnType<typeof officialRelease>) => {
        item.source.commit = 'b'.repeat(40);
      },
    ],
    [
      'subdirectory',
      (item: ReturnType<typeof officialRelease>) => {
        item.source.subdirectory = 'plugins/other';
      },
    ],
    [
      'version',
      (item: ReturnType<typeof officialRelease>) => {
        item.manifest = { ...item.manifest, version: '3.0.0' };
      },
    ],
    [
      'manifest name',
      (item: ReturnType<typeof officialRelease>) => {
        item.manifest = { ...item.manifest, name: 'Changed payload' };
      },
    ],
    [
      'nested engine',
      (item: ReturnType<typeof officialRelease>) => {
        item.manifest = { ...item.manifest, engines: { weave: '>=2.0.0' } };
      },
    ],
    [
      'nested contribution',
      (item: ReturnType<typeof officialRelease>) => {
        item.manifest = {
          ...item.manifest,
          contributes: { ...item.manifest.contributes, tools: ['other'] },
        };
      },
    ],
    [
      'missing optional field',
      (item: ReturnType<typeof officialRelease>) => {
        Reflect.deleteProperty(item.manifest, 'description');
      },
    ],
    [
      'explicit default host',
      (item: ReturnType<typeof officialRelease>) => {
        item.manifest = { ...item.manifest, host: 'in-process' };
      },
    ],
    [
      'capability order',
      (item: ReturnType<typeof officialRelease>) => {
        item.manifest = { ...item.manifest, capabilities: ['command', 'tool'] };
      },
    ],
    [
      'permission order',
      (item: ReturnType<typeof officialRelease>) => {
        item.manifest = { ...item.manifest, permissions: ['workspace:write', 'workspace:read'] };
      },
    ],
    [
      'contribution order',
      (item: ReturnType<typeof officialRelease>) => {
        item.manifest = {
          ...item.manifest,
          contributes: { ...item.manifest.contributes, tools: ['write-note', 'read-note'] },
        };
      },
    ],
  ])('rejects a changed %s even when a known release is included', (_name, mutate) => {
    const policy = createOfficialMarketplacePolicy([officialFamily()]);
    const changed = officialRelease();
    mutate(changed);
    expect(() =>
      policy.assertEntry({ id: 'fixture-official-skills', releases: [changed] }),
    ).toThrow('Unrecognized official marketplace release');
    expect(() =>
      policy.assertEntry({
        id: 'fixture-official-skills',
        releases: [officialRelease('2.0.0'), changed],
      }),
    ).toThrow('Unrecognized official marketplace release');
  });

  it('protects an empty family without creating an installable entry', () => {
    const family = { ...officialFamily(), releases: [] };
    const policy = createOfficialMarketplacePolicy([family]);
    expect(() => policy.assertEntry(officialEntry())).toThrow(
      'Unrecognized official marketplace release',
    );
    expect(() => policy.assertEntry({ id: family.id, releases: [] })).toThrow();
  });

  it('never infers official status from names, publishers, prefixes or source text', () => {
    const policy = createOfficialMarketplacePolicy([officialFamily()]);
    const entry = officialEntry();
    const spoof = {
      ...entry,
      id: 'weave-community-skills',
      name: 'Weave',
      publisher: 'Weave',
      tags: ['official', 'Weave'],
      releases: entry.releases.map((item) => ({
        ...item,
        manifest: { ...item.manifest, id: 'weave-community-skills', name: 'Weave' },
      })),
    };
    expect(policy.assertEntry(spoof)).toEqual({ category: 'community' });
  });

  it('owns deeply frozen parsed copies so caller mutation cannot authorize or rename releases', () => {
    const family = officialFamily();
    const policy = createOfficialMarketplacePolicy([family]);
    family.name = 'Mutated';
    family.tags.push('mutated');
    family.releases[0]!.source.commit = 'c'.repeat(40);
    family.releases[0]!.manifest = { ...family.releases[0]!.manifest, name: 'Mutated' };
    const assertFrozen = (value: unknown): void => {
      if (value === null || typeof value !== 'object') return;
      expect(Object.isFrozen(value)).toBe(true);
      for (const child of Object.values(value)) assertFrozen(child);
    };
    assertFrozen(policy.families);
    expect(policy.assertEntry(officialEntry())).toMatchObject({
      category: 'official',
      display: { name: 'Host-owned Skills', tags: ['host-owned'] },
    });
    expect(() => policy.assertEntry({ id: family.id, releases: family.releases })).toThrow();
  });

  it.each([
    ['duplicate family', () => [officialFamily(), officialFamily()]],
    ['builtin family', () => [{ ...officialFamily(), id: 'tool-registry', releases: [] }]],
    ['manifest id mismatch', () => [{ ...officialFamily(), id: 'other-id' }]],
    [
      'duplicate version',
      () => [{ ...officialFamily(), releases: [officialRelease(), officialRelease()] }],
    ],
    [
      'missing declarations',
      () => [
        {
          ...officialFamily(),
          releases: [
            {
              ...officialRelease(),
              manifest: { ...officialRelease().manifest, contributes: undefined },
            },
          ],
        },
      ],
    ],
    [
      'uppercase repository',
      () => [
        {
          ...officialFamily(),
          releases: [
            {
              ...officialRelease(),
              source: {
                ...officialRelease().source,
                repository: 'https://github.com/Fixture/official-skills',
              },
            },
          ],
        },
      ],
    ],
    [
      'missing subdirectory',
      () => [
        {
          ...officialFamily(),
          releases: [
            {
              ...officialRelease(),
              source: { repository: officialRelease().source.repository, commit: 'a'.repeat(40) },
            },
          ],
        },
      ],
    ],
    [
      'mutable commit',
      () => [
        {
          ...officialFamily(),
          releases: [
            { ...officialRelease(), source: { ...officialRelease().source, commit: 'main' } },
          ],
        },
      ],
    ],
    [
      'unknown manifest field',
      () => [
        {
          ...officialFamily(),
          releases: [
            { ...officialRelease(), manifest: { ...officialRelease().manifest, author: 'Weave' } },
          ],
        },
      ],
    ],
    ['invalid publisher', () => [{ ...officialFamily(), publisher: 'Other' }]],
    ['oversized display name', () => [{ ...officialFamily(), name: 'x'.repeat(301) }]],
    ['oversized description', () => [{ ...officialFamily(), description: 'x'.repeat(2001) }]],
    [
      'too many display tags',
      () => [{ ...officialFamily(), tags: Array.from({ length: 11 }, () => 'tag') }],
    ],
    ['oversized display tag', () => [{ ...officialFamily(), tags: ['x'.repeat(41)] }]],
  ])('rejects invalid host configuration: %s', (_name, families) => {
    expect(() => createOfficialMarketplacePolicy(families())).toThrow();
  });
});
