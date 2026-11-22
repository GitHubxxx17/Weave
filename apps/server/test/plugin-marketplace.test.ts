import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import {
  createServerAgentRunner,
  createServerRuntime,
  disposeServerPlugins,
  listServerPlugins,
} from '../src/runtime.js';
import {
  loadPluginMarketplaceCatalog,
  maxPluginMarketplaceBytes,
  projectPluginMarketplace,
  pluginMarketplaceIndexSchema,
  pluginMarketplaceResponseSchema,
} from '../src/plugin-marketplace.js';
import { writeDeclarativeSkillFixture } from './support/declarative-skill-fixture.js';
import { startServer } from '../src/main.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
async function fileFixture(value: unknown) {
  const directory = await mkdtemp(join(tmpdir(), 'weave-marketplace-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'catalog.json');
  await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
  return { directory, file };
}
function plugin() {
  return {
    id: 'community-notes',
    name: 'Notes',
    description: 'Workspace notes',
    publisher: 'Independent developer',
    tags: ['notes'],
    releases: [
      {
        manifest: {
          id: 'community-notes',
          name: 'Notes',
          version: '1.0.0',
          apiVersion: '1.0.0',
          capabilities: ['tool'],
          contributes: { tools: ['note'] },
          permissions: ['workspace:read'],
        },
        source: {
          repository: 'https://github.com/developer/notes',
          commit: 'a'.repeat(40),
          subdirectory: 'plugin',
        },
      },
    ],
  };
}
const index = () => ({ schemaVersion: 1, plugins: [plugin()] });

describe('GET /plugins/marketplace', () => {
  it('keeps schema-1 discovery and reports a declarative Skill release as compatible', async () => {
    const { directory } = await fileFixture('{}');
    const manifest = await writeDeclarativeSkillFixture(join(directory, 'payload'), {
      id: 'community-notes',
    });
    const value = index();
    Object.assign(value.plugins[0]!.releases[0]!, { manifest });
    const { file } = await fileFixture(value);
    const response = projectPluginMarketplace(
      await loadPluginMarketplaceCatalog(file),
      [],
      '1.0.0',
    );
    expect(response.schemaVersion).toBe(1);
    expect(response.entries).toMatchObject([
      { releases: [{ manifest, compatibility: 'compatible' }] },
    ]);
  });

  it('returns a read-only empty marketplace when no discovery catalog is configured', async () => {
    const runtime = createServerRuntime();
    const response = await createApp(runtime).request('/plugins/marketplace');

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      schemaVersion: 1,
      hostVersion: '0.0.0',
      communityStatus: 'unconfigured',
      entries: [],
    });
    expect(runtime.status).toBe('created');
  });

  it('projects only code-owned actual builtin identities as official', async () => {
    const runtime = createServerRuntime();
    await runtime.start();
    cleanup.push(() => runtime.stop());
    cleanup.push(() => disposeServerPlugins(runtime));
    await createServerAgentRunner(runtime);
    const actual = listServerPlugins(runtime);
    const app = createApp(runtime, { pluginCatalog: () => actual });
    const response = await app.request('/plugins/marketplace');
    const body = await response.json();
    expect(
      body.entries.map((entry: { id: string; category: string }) => [entry.id, entry.category]),
    ).toEqual([
      ['tool-registry', 'official'],
      ['provider-registry', 'official'],
      ['event-registry', 'official'],
      ['host-services', 'official'],
      ['server-tool-host', 'official'],
    ]);
    expect(
      body.entries.every(
        (entry: { publisher: string; kind: string }) =>
          entry.publisher === 'Weave' && entry.kind === 'builtin',
      ),
    ).toBe(true);
    const spoof = actual.map((item) => ({ ...item, origin: 'kernel' as const }));
    expect(
      projectPluginMarketplace({ communityStatus: 'unconfigured', plugins: [] }, spoof, '0.0.0')
        .entries,
    ).toEqual([]);
    const unlisted = actual.map((item) => ({ ...item, id: 'unlisted-official' }));
    expect(
      projectPluginMarketplace({ communityStatus: 'unconfigured', plugins: [] }, unlisted, '0.0.0')
        .entries,
    ).toEqual([]);
  });

  it('serves the loaded snapshot after the file is removed and exposes no mutation endpoint', async () => {
    const { file } = await fileFixture(index());
    const catalog = await loadPluginMarketplaceCatalog(file);
    await rm(file);
    const runtime = createServerRuntime();
    const app = createApp(runtime, { pluginMarketplace: catalog });
    const first = await app.request('/plugins/marketplace');
    const body = await first.json();
    expect(body.communityStatus).toBe('ready');
    expect(body.entries[0]).toMatchObject({
      kind: 'github',
      category: 'community',
      publisher: 'Independent developer',
    });
    expect(JSON.stringify(body)).not.toContain(file);
    expect(await (await app.request('/plugins/marketplace')).json()).toEqual(body);
    expect(
      (
        await app.request('http://localhost/plugins/marketplace', {
          method: 'POST',
          headers: { Host: 'localhost', 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(404);
    expect(runtime.status).toBe('created');
  });
});

describe('static community marketplace', () => {
  it('rejects an unrecognized protected release across schema, local load and typed projection', async () => {
    const entry = plugin();
    entry.id = entry.releases[0]!.manifest.id = 'weave-official-skills';
    const value = { schemaVersion: 1, plugins: [entry] };
    expect(pluginMarketplaceIndexSchema.safeParse(value).success).toBe(false);
    const { file } = await fileFixture(value);
    expect(await loadPluginMarketplaceCatalog(file)).toEqual({
      communityStatus: 'unavailable',
      plugins: [],
    });
    expect(() =>
      projectPluginMarketplace({ communityStatus: 'ready', plugins: [entry] }, [], '1.0.0'),
    ).toThrow();
  });

  it('keeps Weave display claims community and validates official GitHub response publishers', () => {
    const entry = plugin();
    entry.id = entry.releases[0]!.manifest.id = 'weave-community-skills';
    entry.name = entry.publisher = entry.releases[0]!.manifest.name = 'Weave';
    const response = projectPluginMarketplace(
      { communityStatus: 'ready', plugins: [entry] },
      [],
      '1.0.0',
    );
    expect(response.entries[0]).toMatchObject({
      kind: 'github',
      category: 'community',
      publisher: 'Weave',
    });
    const official = {
      ...response,
      entries: [{ ...response.entries[0]!, category: 'official', publisher: 'Weave' }],
    };
    expect(pluginMarketplaceResponseSchema.safeParse(official).success).toBe(true);
    expect(
      pluginMarketplaceResponseSchema.safeParse({
        ...official,
        entries: [{ ...official.entries[0], publisher: 'Other' }],
      }).success,
    ).toBe(false);
    expect(
      pluginMarketplaceResponseSchema.safeParse({
        ...official,
        entries: [{ ...official.entries[0], category: 'verified' }],
      }).success,
    ).toBe(false);
  });

  it('sorts fixed releases numerically and checks engine, API and host compatibility', async () => {
    const entry = plugin();
    const base = entry.releases[0]!;
    entry.releases = [
      { ...base, manifest: { ...base.manifest, version: '1.9.0' } },
      { ...base, manifest: { ...base.manifest, version: '1.10.0' } },
    ];
    const value = { schemaVersion: 1, plugins: [entry] };
    const { file } = await fileFixture(value);
    const catalog = await loadPluginMarketplaceCatalog(file);
    const projected = projectPluginMarketplace(catalog, [], '0.0.0');
    expect(projected.entries[0]).toMatchObject({
      releases: [
        { manifest: { version: '1.10.0' }, compatibility: 'compatible' },
        { manifest: { version: '1.9.0' }, compatibility: 'compatible' },
      ],
    });
    for (const manifestPatch of [
      { engines: { weave: '>=1.0.0' } },
      { apiVersion: '2.0.0' },
      { host: 'mcp' },
    ]) {
      const next = index();
      Object.assign(next.plugins[0]!.releases[0]!.manifest, manifestPatch);
      await writeFile(file, JSON.stringify(next));
      const result = projectPluginMarketplace(
        await loadPluginMarketplaceCatalog(file),
        [],
        '0.0.0',
      );
      expect(result.entries[0]).toMatchObject({ releases: [{ compatibility: 'incompatible' }] });
    }
  });

  it.each([
    ['duplicate plugin ids', (value: ReturnType<typeof index>) => value.plugins.push(plugin())],
    [
      'duplicate release versions',
      (value: ReturnType<typeof index>) => value.plugins[0]!.releases.push(plugin().releases[0]!),
    ],
    [
      'manifest identity mismatch',
      (value: ReturnType<typeof index>) => {
        value.plugins[0]!.releases[0]!.manifest.id = 'different-plugin';
      },
    ],
    [
      'missing declarations',
      (value: ReturnType<typeof index>) => {
        Reflect.deleteProperty(value.plugins[0]!.releases[0]!.manifest, 'permissions');
      },
    ],
    [
      'fake official classification',
      (value: ReturnType<typeof index>) => {
        Object.assign(value.plugins[0]!, { category: 'official' });
      },
    ],
    [
      'fake compatibility',
      (value: ReturnType<typeof index>) => {
        Object.assign(value.plugins[0]!.releases[0]!, { compatibility: 'compatible' });
      },
    ],
    [
      'moving reference',
      (value: ReturnType<typeof index>) => {
        value.plugins[0]!.releases[0]!.source.commit = 'main';
      },
    ],
    [
      'unknown manifest property',
      (value: ReturnType<typeof index>) => {
        Object.assign(value.plugins[0]!.releases[0]!.manifest, { verified: true });
      },
    ],
    [
      'undeclared tool capability',
      (value: ReturnType<typeof index>) => {
        value.plugins[0]!.releases[0]!.manifest.capabilities = ['prompt'];
      },
    ],
    [
      'noncanonical repository',
      (value: ReturnType<typeof index>) => {
        value.plugins[0]!.releases[0]!.source.repository = 'https://github.com/Developer/notes';
      },
    ],
    [
      'unsafe path',
      (value: ReturnType<typeof index>) => {
        value.plugins[0]!.releases[0]!.source.subdirectory = '../plugin';
      },
    ],
    [
      'too many plugins',
      (value: ReturnType<typeof index>) => {
        value.plugins = Array.from({ length: 101 }, () => plugin());
      },
    ],
    [
      'too many releases',
      (value: ReturnType<typeof index>) => {
        value.plugins[0]!.releases = Array.from({ length: 21 }, () => plugin().releases[0]!);
      },
    ],
    [
      'too many tags',
      (value: ReturnType<typeof index>) => {
        value.plugins[0]!.tags = Array.from({ length: 11 }, () => 'tag');
      },
    ],
    [
      'oversized text',
      (value: ReturnType<typeof index>) => {
        value.plugins[0]!.name = 'x'.repeat(301);
      },
    ],
  ])('isolates %s', async (_name, mutate) => {
    const value = index();
    mutate(value);
    const { file } = await fileFixture(value);
    expect(await loadPluginMarketplaceCatalog(file)).toEqual({
      communityStatus: 'unavailable',
      plugins: [],
    });
  });

  it('rejects every curated builtin id and additional reserved host ids even when absent', async () => {
    const { file } = await fileFixture(index());
    for (const id of [
      'host-services',
      'tool-registry',
      'provider-registry',
      'event-registry',
      'server-tool-host',
      'registered-host',
    ]) {
      const value = index();
      value.plugins[0]!.id = id;
      value.plugins[0]!.releases[0]!.manifest.id = id;
      await writeFile(file, JSON.stringify(value));
      expect(await loadPluginMarketplaceCatalog(file, ['registered-host'])).toEqual({
        communityStatus: 'unavailable',
        plugins: [],
      });
    }
  });

  it('isolates missing, relative, malformed, invalid UTF-8, oversized and nonregular files', async () => {
    const { file, directory } = await fileFixture(index());
    const unavailable = { communityStatus: 'unavailable', plugins: [] };
    expect(await loadPluginMarketplaceCatalog(join(directory, 'missing'))).toEqual(unavailable);
    expect(await loadPluginMarketplaceCatalog('catalog.json')).toEqual(unavailable);
    expect(await loadPluginMarketplaceCatalog(directory)).toEqual(unavailable);
    await writeFile(file, '{');
    expect(await loadPluginMarketplaceCatalog(file)).toEqual(unavailable);
    await writeFile(file, Buffer.from([0xff]));
    expect(await loadPluginMarketplaceCatalog(file)).toEqual(unavailable);
    await writeFile(file, ' '.repeat(maxPluginMarketplaceBytes + 1));
    expect(await loadPluginMarketplaceCatalog(file)).toEqual(unavailable);
    const link = join(directory, 'linked');
    await symlink(file, link);
    expect(await loadPluginMarketplaceCatalog(link)).toEqual(unavailable);
    expect(await loadPluginMarketplaceCatalog(false)).toEqual({
      communityStatus: 'unconfigured',
      plugins: [],
    });
    expect(await loadPluginMarketplaceCatalog(undefined)).toEqual({
      communityStatus: 'unconfigured',
      plugins: [],
    });
  });

  it('reads startup environment configuration once and lets false explicitly disable it', async () => {
    const { file, directory } = await fileFixture(index());
    const server = await startServer(0, {
      dataDirectory: directory,
      pluginsDirectory: false,
      environment: { WEAVE_PLUGIN_MARKETPLACE_CATALOG: file },
    });
    try {
      const address = server.server.address();
      if (typeof address !== 'object' || address === null)
        throw new Error('Missing loopback address');
      const url = `http://127.0.0.1:${String(address.port)}/plugins/marketplace`;
      const initial = await (await fetch(url)).json();
      expect(initial.communityStatus).toBe('ready');
      expect(
        initial.entries.filter((entry: { kind: string }) => entry.kind === 'builtin'),
      ).toHaveLength(5);
      await writeFile(file, 'invalid now');
      expect((await (await fetch(url)).json()).communityStatus).toBe('ready');
    } finally {
      await server.stop();
    }
    const disabled = await startServer(0, {
      dataDirectory: directory,
      pluginsDirectory: false,
      environment: { WEAVE_PLUGIN_MARKETPLACE_CATALOG: file },
      pluginMarketplaceCatalogFile: false,
    });
    try {
      const address = disabled.server.address();
      if (typeof address !== 'object' || address === null)
        throw new Error('Missing loopback address');
      const response = await fetch(`http://127.0.0.1:${String(address.port)}/plugins/marketplace`);
      const body = await response.json();
      expect(body.communityStatus).toBe('ready');
      expect(body.indexSource.id).toBe('weave');
      expect(
        body.entries.filter((entry: { kind: string }) => entry.kind === 'github'),
      ).toMatchObject([{ id: 'weave-official-skills', category: 'official', kind: 'github' }]);
      expect(body.entries.some((entry: { id: string }) => entry.id === 'community-notes')).toBe(
        false,
      );
    } finally {
      await disabled.stop();
    }
  });

  it('keeps server health and bundled discovery available when the configured file is invalid', async () => {
    const { file, directory } = await fileFixture('invalid');
    const server = await startServer(0, {
      dataDirectory: directory,
      pluginsDirectory: false,
      environment: {},
      pluginMarketplaceCatalogFile: file,
    });
    try {
      const address = server.server.address();
      if (typeof address !== 'object' || address === null)
        throw new Error('Missing loopback address');
      const origin = `http://127.0.0.1:${String(address.port)}`;
      expect((await fetch(`${origin}/health`)).status).toBe(200);
      const response = await fetch(`${origin}/plugins/marketplace`);
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.communityStatus).toBe('unavailable');
      expect(body.entries).toHaveLength(5);
      expect(JSON.stringify(body)).not.toContain(file);
    } finally {
      await server.stop();
    }
  });
});
