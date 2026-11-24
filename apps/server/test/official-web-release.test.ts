import type { PluginManifest } from '@weave/plugin';
import { inspectPluginPayload } from '@weave/plugin-host';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { generateMarketplaceIndex } from '../src/marketplace-tooling.js';
import { assertOfficialMarketplaceEntry } from '../src/official-marketplace-releases.js';
import { createPluginMarketplaceManager } from '../src/plugin-marketplace-manager.js';
import {
  loadPluginMarketplaceCatalog,
  pluginMarketplaceIndexSchema,
  pluginMarketplaceResponseSchema,
  projectPluginMarketplace,
} from '../src/plugin-marketplace.js';
import { createServerRuntime } from '../src/runtime.js';
import {
  createInstallerHttpFixture,
  importBody,
} from './support/managed-plugin-installer-http-fixture.js';

const payload = fileURLToPath(new URL('../../../plugins/official/weave-web', import.meta.url));
const marketplace = fileURLToPath(new URL('../../../marketplace', import.meta.url));
// Independent literals: changing the production table must not change this expected identity.
const manifest: PluginManifest = {
  id: 'weave-web',
  name: 'Weave 联网',
  version: '0.1.0',
  apiVersion: '1.0.0',
  description: '经共享审批搜索公开网页并读取有来源的有限文本。',
  host: 'in-process',
  capabilities: ['tool'],
  contributes: { tools: ['web_search', 'web_fetch'] },
  permissions: ['network:request'],
};
const source = {
  repository: 'https://github.com/githubxxx17/weave',
  commit: 'ecfe2e889b9897ee6ea249b2ed7469585114ab2a',
  subdirectory: 'plugins/official/weave-web',
};
const display = {
  name: 'Weave 联网',
  description: '搜索公开网页与读取有来源的有限文本；搜索使用单独配置的 Tavily。',
  publisher: 'Weave',
  tags: ['Weave', '联网', '搜索'],
};

function entry() {
  return {
    id: manifest.id,
    name: 'Independent mirror title',
    description: 'Independent mirror description',
    publisher: 'Independent mirror',
    tags: ['mirror'],
    releases: [{ manifest: structuredClone(manifest), source: { ...source } }],
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('published Weave web release', () => {
  it('keeps the actual ESM payload, reviewed release tuple, submission and generated index identical', async () => {
    const artifact = await inspectPluginPayload(payload);
    expect(artifact.kind).toBe('entry');
    expect(artifact.descriptor).toEqual({ schemaVersion: 1, entry: 'index.mjs', manifest });
    expect(await readFile(join(payload, 'index.mjs'), 'utf8')).not.toBe('');
    expect(assertOfficialMarketplaceEntry(entry())).toEqual({ category: 'official', display });

    const submission: unknown = JSON.parse(
      await readFile(join(marketplace, 'submissions', 'weave-web.json'), 'utf8'),
    );
    const admitted = pluginMarketplaceIndexSchema.parse({
      schemaVersion: 1,
      plugins: [submission],
    }).plugins[0]!;
    expect(admitted.id).toBe(manifest.id);
    expect(admitted.releases).toEqual([{ manifest, source }]);
    const index = pluginMarketplaceIndexSchema.parse(
      JSON.parse(await readFile(join(marketplace, 'index.json'), 'utf8')),
    );
    expect(index.plugins.find(({ id }) => id === manifest.id)).toEqual(admitted);
    expect(
      await generateMarketplaceIndex({
        submissionsDirectory: join(marketplace, 'submissions'),
        outputFile: join(marketplace, 'index.json'),
        mode: 'check',
      }),
    ).toEqual({ plugins: index.plugins.length, changed: false });
  });

  it('discovers the packaged web release by default without starting or trusting the runtime', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'weave-web-release-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const manager = await createPluginMarketplaceManager({
      settingsFile: join(directory, 'sources.json'),
    });
    cleanups.push(async () => {
      manager.closeSync();
      await manager.drain();
    });
    const runtime = createServerRuntime();
    const response = await createApp(runtime, { pluginMarketplaceManager: manager }).request(
      '/plugins/marketplace',
    );
    expect(response.status).toBe(200);
    const body = pluginMarketplaceResponseSchema.parse(await response.json());
    expect(body.indexSource).toEqual({ id: 'weave', name: 'Weave 插件目录', url: null });
    expect(body.communityStatus).toBe('ready');
    expect(body.entries.find(({ id }) => id === manifest.id)).toEqual({
      id: manifest.id,
      kind: 'github',
      category: 'official',
      ...display,
      releases: [{ manifest, source, compatibility: 'compatible' }],
    });
    expect(runtime.status).toBe('created');
  });

  it.each([
    ['repository', (release) => (release.source.repository = 'https://github.com/other/weave')],
    ['commit', (release) => (release.source.commit = 'fcfe2e889b9897ee6ea249b2ed7469585114ab2a')],
    [
      'author source directory',
      (release) => (release.source.subdirectory = 'plugins/official/weave-web-source'),
    ],
    ['future version', (release) => (release.manifest = { ...release.manifest, version: '0.1.1' })],
    [
      'execution host',
      (release) => (release.manifest = { ...release.manifest, host: 'declarative' }),
    ],
    [
      'network permission',
      (release) => (release.manifest = { ...release.manifest, permissions: [] }),
    ],
    [
      'tool contributions',
      (release) =>
        (release.manifest = { ...release.manifest, contributes: { tools: ['web_search'] } }),
    ],
    [
      'manifest description',
      (release) => (release.manifest = { ...release.manifest, description: 'Unreviewed content' }),
    ],
  ] satisfies Array<[string, (release: ReturnType<typeof entry>['releases'][number]) => unknown]>)(
    'rejects changed %s at policy, schema and projection boundaries, including mixed releases',
    (_name, mutate) => {
      const changed = entry();
      mutate(changed.releases[0]!);
      const mixed = { ...changed, releases: [entry().releases[0]!, ...changed.releases] };
      for (const invalid of [changed, mixed]) {
        expect(() => assertOfficialMarketplaceEntry(invalid)).toThrow(
          'Unrecognized official marketplace release',
        );
        expect(
          pluginMarketplaceIndexSchema.safeParse({ schemaVersion: 1, plugins: [invalid] }).success,
        ).toBe(false);
        expect(() =>
          projectPluginMarketplace({ communityStatus: 'ready', plugins: [invalid] }, [], '0.0.0'),
        ).toThrow();
      }
    },
  );

  it('makes a catalog containing a known release mixed with a wrong commit unavailable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'weave-web-release-rejected-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const changed = entry();
    changed.releases[0]!.source.commit = 'fcfe2e889b9897ee6ea249b2ed7469585114ab2a';
    const file = join(directory, 'index.json');
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        plugins: [{ ...entry(), releases: [...entry().releases, ...changed.releases] }],
      }),
    );
    expect(await loadPluginMarketplaceCatalog(file)).toEqual({
      communityStatus: 'unavailable',
      plugins: [],
    });
  });

  it('preserves independent mirror provenance and the last reviewed snapshot after invalid refresh', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'weave-web-release-mirror-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const current = entry();
    const future = entry();
    future.releases[0]!.manifest = { ...future.releases[0]!.manifest, version: '0.1.1' };
    const replies = [
      { schemaVersion: 1, plugins: [current] },
      {
        schemaVersion: 1,
        plugins: [{ ...current, releases: [...current.releases, ...future.releases] }],
      },
    ];
    const manager = await createPluginMarketplaceManager({
      settingsFile: join(directory, 'sources.json'),
      fetch: async () => Response.json(replies.shift()),
    });
    cleanups.push(async () => {
      manager.closeSync();
      await manager.drain();
    });
    const added = await manager.add(
      {
        name: 'Independent web mirror',
        url: 'https://catalog.example/web.json',
      },
      manager.listSources().revision,
    );
    const remote = added.sources.find(({ kind }) => kind === 'remote')!;
    await manager.refresh(remote.id);
    const app = createApp(createServerRuntime(), { pluginMarketplaceManager: manager });
    const read = async () => {
      const response = await app.request(`/plugins/marketplace?sourceId=${remote.id}`);
      expect(response.status).toBe(200);
      return pluginMarketplaceResponseSchema.parse(await response.json());
    };
    const first = await read();
    expect(first.indexSource).toEqual(
      {
        id: remote.id,
        name: 'Independent web mirror',
        url: 'https://catalog.example/web.json',
      },
      manager.listSources().revision,
    );
    expect(first.entries).toEqual([
      {
        id: manifest.id,
        kind: 'github',
        category: 'official',
        ...display,
        releases: [{ manifest, source, compatibility: 'compatible' }],
      },
    ]);
    await manager.refresh(remote.id);
    expect(manager.listSources().sources.find(({ id }) => id === remote.id)).toMatchObject({
      status: 'unavailable',
      stale: true,
      errorCode: 'invalid-index',
    });
    expect(await read()).toEqual(first);
  });

  it('does not promote official-looking names or admit an index-provided category claim', () => {
    const spoof = entry();
    spoof.id = 'weave-web-community';
    spoof.name = display.name;
    spoof.publisher = 'Weave';
    spoof.tags = ['official', 'Weave'];
    spoof.releases[0]!.manifest = {
      ...spoof.releases[0]!.manifest,
      id: 'weave-web-community',
    };
    expect(assertOfficialMarketplaceEntry(spoof)).toEqual({ category: 'community' });
    const projected = projectPluginMarketplace(
      { communityStatus: 'ready', plugins: [spoof] },
      [],
      '0.0.0',
    );
    expect(projected.entries).toMatchObject([
      { id: 'weave-web-community', kind: 'github', category: 'community', publisher: 'Weave' },
    ]);
    expect(
      pluginMarketplaceIndexSchema.safeParse({
        schemaVersion: 1,
        plugins: [{ ...entry(), category: 'official' }],
      }).success,
    ).toBe(false);
  });

  it('keeps default discovery and local ESM preview inert, then imports without selection or trust', async () => {
    const fixture = await createInstallerHttpFixture(cleanups, []);
    await fixture.startUnbound({ skillsDirectory: false });
    const before = fixture.snapshot();
    const catalogBefore = await fixture.catalog();
    expect(catalogBefore.plugins).toEqual([]);
    const discovered = pluginMarketplaceResponseSchema.parse(
      await fixture.http('/plugins/marketplace'),
    );
    expect(discovered.entries.find(({ id }) => id === manifest.id)).toMatchObject({
      kind: 'github',
      category: 'official',
      releases: [{ manifest, source }],
    });
    expect(fixture.snapshot()).toEqual(before);
    expect(await fixture.catalog()).toEqual(catalogBefore);

    const preview = await fixture.preview(payload);
    expect(preview.candidate.manifest).toEqual(manifest);
    expect(fixture.snapshot()).toEqual(before);
    expect(await fixture.catalog()).toEqual(catalogBefore);
    const imported = await fixture.import(importBody('web-release-local-import', preview));
    expect(imported).toMatchObject({
      kind: 'committed',
      decision: { pluginId: manifest.id, selection: null, trust: null },
      application: { status: 'not-required', active: null },
    });
    expect((await fixture.catalog()).plugins).toEqual([
      {
        pluginId: manifest.id,
        candidates: [expect.objectContaining({ manifest, provenance: 'local-directory' })],
        selection: null,
        trust: null,
        active: null,
      },
    ]);
    expect(fixture.snapshot().trustEvents).toEqual([]);
  });
});
