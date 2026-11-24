import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  addPluginMarketplaceSource,
  fetchPluginMarketplace,
  fetchPluginMarketplaceSources,
  refreshPluginMarketplaceSource,
  removePluginMarketplaceSource,
} from '../src/features/plugins/plugin-marketplace-api.js';
import { pluginMarketplaceSchema } from '../src/features/plugins/plugin-marketplace-types.js';
import { firstCandidate } from './support/managed-plugin-fixtures.js';

const source = {
  repository: 'https://github.com/developer/plugin',
  commit: 'a'.repeat(40),
  subdirectory: 'plugin',
};
const entry = {
  kind: 'github',
  category: 'community',
  id: firstCandidate.manifest.id,
  name: 'Community plugin',
  description: 'A published plugin',
  publisher: 'Developer',
  tags: ['Tools'],
  releases: [{ manifest: firstCandidate.manifest, source, compatibility: 'compatible' }],
};
const catalog = {
  schemaVersion: 1,
  hostVersion: '0.0.0',
  communityStatus: 'ready',
  entries: [entry],
};

afterEach(() => vi.unstubAllGlobals());

describe('marketplace discovery client', () => {
  const sources = {
    schemaVersion: 1,
    revision: 4,
    sources: [
      {
        id: 'weave',
        name: 'Weave',
        url: null,
        kind: 'builtin',
        status: 'ready',
        stale: false,
        removable: false,
      },
    ],
  };

  it('reads explicit sources and sends only requested source management actions', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(Response.json(sources)));
    vi.stubGlobal('fetch', fetch);
    expect(await fetchPluginMarketplaceSources()).toEqual(sources);
    await addPluginMarketplaceSource({ name: 'Team', url: 'https://example.com/index.json' }, 4);
    await refreshPluginMarketplaceSource('remote-team');
    await removePluginMarketplaceSource('remote-team', 5);
    expect(fetch.mock.calls.map(([path, init]) => [path, init.method, init.body])).toEqual([
      ['/plugins/marketplace/sources', 'GET', undefined],
      [
        '/plugins/marketplace/sources/add',
        'POST',
        JSON.stringify({ name: 'Team', url: 'https://example.com/index.json', revision: 4 }),
      ],
      ['/plugins/marketplace/refresh', 'POST', JSON.stringify({ sourceId: 'remote-team' })],
      [
        '/plugins/marketplace/sources/remove',
        'POST',
        JSON.stringify({ id: 'remote-team', revision: 5 }),
      ],
    ]);
    expect(fetch.mock.calls[1]![1].headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('encodes source selection and validates attribution rather than trusting arbitrary links', async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        ...catalog,
        indexSource: { id: 'team', name: 'Team', url: 'https://example.com/index.json' },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(fetchPluginMarketplace(undefined, 'team/a')).resolves.toMatchObject({
      indexSource: { id: 'team' },
    });
    expect(fetch.mock.calls[0]![0]).toBe('/plugins/marketplace?sourceId=team%2Fa');
    fetch.mockResolvedValue(
      Response.json({
        ...sources,
        sources: [
          {
            ...sources.sources[0],
            id: 'remote',
            kind: 'remote',
            url: 'javascript:alert(1)',
            removable: true,
          },
        ],
      }),
    );
    await expect(fetchPluginMarketplaceSources()).rejects.toMatchObject({
      code: 'plugin-invalid-response',
    });
  });

  it('surfaces safe service errors and preserves aborted source requests', async () => {
    const controller = new AbortController();
    const abort = new DOMException('Aborted', 'AbortError');
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: 'settings-unavailable', message: 'Settings unavailable' } },
          { status: 503 },
        ),
      )
      .mockImplementationOnce(() => {
        controller.abort();
        return Promise.reject(abort);
      });
    vi.stubGlobal('fetch', fetch);
    await expect(
      addPluginMarketplaceSource({ name: 'Team', url: 'https://example.com/index.json' }, 4),
    ).rejects.toMatchObject({ code: 'settings-unavailable', status: 503 });
    await expect(fetchPluginMarketplaceSources(controller.signal)).rejects.toBe(abort);
  });
  it('reads a validated discovery snapshot without management writes', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(catalog));
    vi.stubGlobal('fetch', fetch);
    expect(await fetchPluginMarketplace()).toEqual(catalog);
    expect(fetch).toHaveBeenCalledWith(
      '/plugins/marketplace',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('accepts host-attributed official GitHub releases while preserving custom index provenance', async () => {
    const official = {
      ...entry,
      category: 'official',
      publisher: 'Weave',
    };
    const discovery = {
      ...catalog,
      indexSource: { id: 'team', name: 'Team mirror', url: 'https://example.com/index.json' },
      entries: [official],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(discovery)));
    const result = await fetchPluginMarketplace(undefined, 'team');
    expect(result.entries[0]).toEqual(official);
    expect(result.entries[0]?.kind).toBe('github');
    expect(result.indexSource).toEqual({
      id: 'team',
      name: 'Team mirror',
      url: 'https://example.com/index.json',
    });
  });

  it('keeps community attribution when display metadata names Weave', () => {
    const result = pluginMarketplaceSchema.parse({
      ...catalog,
      entries: [{ ...entry, publisher: 'Weave', name: 'Weave maintained plugin' }],
    });
    expect(result.entries[0]?.category).toBe('community');
  });

  it('preserves the closed builtin entry contract', () => {
    const builtin = {
      kind: 'builtin',
      category: 'official',
      id: 'tool-registry',
      name: 'Tools',
      description: 'Builtin tools',
      publisher: 'Weave',
      tags: ['Tools'],
      version: '1.0.0',
    };
    expect(pluginMarketplaceSchema.parse({ ...catalog, entries: [builtin] }).entries).toEqual([
      builtin,
    ]);
    for (const invalid of [
      { ...builtin, category: 'community' },
      { ...builtin, publisher: 'Developer' },
      { ...builtin, releases: entry.releases },
    ]) {
      expect(pluginMarketplaceSchema.safeParse({ ...catalog, entries: [invalid] }).success).toBe(
        false,
      );
    }
  });

  it.each([
    { ...entry, category: 'official' },
    { ...entry, category: 'verified', publisher: 'Weave' },
    { ...entry, category: 'official', publisher: 'Weave', verified: true },
    { ...entry, category: 'official', publisher: 'Weave', version: '1.0.0' },
    { ...entry, id: 'another-plugin' },
    { ...entry, releases: [entry.releases[0], entry.releases[0]] },
    { ...entry, releases: [{ ...entry.releases[0], source: { ...source, commit: 'main' } }] },
    { ...entry, verified: true },
  ])('rejects invalid publisher, identity, version and source claims', (invalid) => {
    expect(pluginMarketplaceSchema.safeParse({ ...catalog, entries: [invalid] }).success).toBe(
      false,
    );
  });

  it('rejects an invalid successful response and isolates an unavailable endpoint', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ ...catalog, entries: [{ ...entry, category: 'official' }] }),
        )
        .mockResolvedValueOnce(new Response('Not found', { status: 404 })),
    );
    await expect(fetchPluginMarketplace()).rejects.toMatchObject({
      code: 'plugin-invalid-response',
    });
    await expect(fetchPluginMarketplace()).rejects.toMatchObject({
      code: 'plugin-marketplace-unavailable',
    });
  });
});
