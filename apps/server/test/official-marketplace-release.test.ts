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

const payload = fileURLToPath(
  new URL('../../../plugins/official/weave-official-skills', import.meta.url),
);
const marketplace = fileURLToPath(new URL('../../../marketplace', import.meta.url));
const manifest: PluginManifest = {
  id: 'weave-official-skills',
  name: 'Weave 官方使用与开发指南',
  version: '1.0.0',
  apiVersion: '1.0.0',
  description: 'Weave 产品使用、插件开发、Skills 创作与本地 MCP 的版本化指南。',
  host: 'declarative',
  capabilities: ['skill'],
  contributes: {
    skills: ['weave-guide', 'weave-plugin-author', 'weave-skill-author', 'weave-mcp-guide'],
  },
  permissions: [],
};
const source = {
  repository: 'https://github.com/githubxxx17/weave',
  commit: '5809b6a8fe2d987735a3dbd782df1bff1fd5af43',
  subdirectory: 'plugins/official/weave-official-skills',
};

function entry() {
  return {
    id: manifest.id,
    name: 'Mirror-supplied title',
    description: 'Mirror-supplied description',
    publisher: 'Independent mirror',
    tags: ['mirror'],
    releases: [{ manifest: structuredClone(manifest), source: { ...source } }],
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('published Weave official Skills release', () => {
  it('admits the actual schema-2 payload manifest and preserves its exact source in generated artifacts', async () => {
    const artifact = await inspectPluginPayload(payload);
    expect(artifact.kind).toBe('skills');
    expect(artifact.descriptor).toEqual({ schemaVersion: 2, kind: 'skills', manifest });
    expect(artifact).not.toHaveProperty('entry');
    expect(assertOfficialMarketplaceEntry(entry())).toMatchObject({ category: 'official' });

    const submission: unknown = JSON.parse(
      await readFile(join(marketplace, 'submissions', 'weave-official-skills.json'), 'utf8'),
    );
    const admitted = pluginMarketplaceIndexSchema.parse({
      schemaVersion: 1,
      plugins: [submission],
    }).plugins[0]!;
    expect(admitted.id).toBe('weave-official-skills');
    expect(admitted.releases).toEqual([{ manifest, source }]);
    const index = pluginMarketplaceIndexSchema.parse(
      JSON.parse(await readFile(join(marketplace, 'index.json'), 'utf8')),
    );
    expect(index.plugins.find(({ id }) => id === admitted.id)).toEqual(admitted);
    expect(
      await generateMarketplaceIndex({
        submissionsDirectory: join(marketplace, 'submissions'),
        outputFile: join(marketplace, 'index.json'),
        mode: 'check',
      }),
    ).toEqual({ plugins: index.plugins.length, changed: false });
  });

  it('loads the packaged official release as an installable GitHub entry by default', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'weave-official-release-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const manager = await createPluginMarketplaceManager({
      settingsFile: join(directory, 'sources.jsonl'),
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
    expect(body.entries.find(({ id }) => id === 'weave-official-skills')).toMatchObject({
      id: 'weave-official-skills',
      kind: 'github',
      category: 'official',
      publisher: 'Weave',
      releases: [
        {
          manifest: { version: '1.0.0', host: 'declarative', permissions: [] },
          source: {
            repository: 'https://github.com/githubxxx17/weave',
            commit: '5809b6a8fe2d987735a3dbd782df1bff1fd5af43',
            subdirectory: 'plugins/official/weave-official-skills',
          },
          compatibility: 'compatible',
        },
      ],
    });
    expect(runtime.status).toBe('created');
  });

  it.each([
    ['repository', (release) => (release.source.repository = 'https://github.com/other/weave')],
    ['commit', (release) => (release.source.commit = '6809b6a8fe2d987735a3dbd782df1bff1fd5af43')],
    ['subdirectory', (release) => (release.source.subdirectory = 'plugins/official/other')],
    ['future version', (release) => (release.manifest = { ...release.manifest, version: '1.0.1' })],
    [
      'manifest name',
      (release) => (release.manifest = { ...release.manifest, name: 'Changed content' }),
    ],
    ['manifest description', (release) => Reflect.deleteProperty(release.manifest, 'description')],
    [
      'manifest permissions',
      (release) => (release.manifest = { ...release.manifest, permissions: ['workspace:read'] }),
    ],
    [
      'manifest contributions',
      (release) => {
        release.manifest = { ...release.manifest, contributes: { skills: ['weave-guide'] } };
      },
    ],
  ] satisfies Array<[string, (release: ReturnType<typeof entry>['releases'][number]) => unknown]>)(
    'rejects a changed %s across policy and index admission, including mixed known releases',
    async (_name, mutate) => {
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
      const directory = await mkdtemp(join(tmpdir(), 'weave-official-rejected-'));
      cleanups.push(() => rm(directory, { recursive: true, force: true }));
      const file = join(directory, 'index.json');
      await writeFile(file, JSON.stringify({ schemaVersion: 1, plugins: [mixed] }));
      expect(await loadPluginMarketplaceCatalog(file)).toEqual({
        communityStatus: 'unavailable',
        plugins: [],
      });
    },
  );

  it('derives the official category while rejecting category claims and unknown response categories', () => {
    const index = { schemaVersion: 1, plugins: [entry()] };
    expect(pluginMarketplaceIndexSchema.safeParse(index).success).toBe(true);
    expect(
      pluginMarketplaceIndexSchema.safeParse({
        ...index,
        plugins: [{ ...entry(), category: 'official' }],
      }).success,
    ).toBe(false);
    const response = projectPluginMarketplace(
      { communityStatus: 'ready', plugins: [entry()] },
      [],
      '0.0.0',
    );
    expect(response.entries[0]).toMatchObject({
      name: 'Weave 官方技能',
      description: 'Weave 维护的使用指南、插件开发、技能创作与 MCP 配置技能。',
      publisher: 'Weave',
      tags: ['Weave', '技能', '开发指南'],
      kind: 'github',
      category: 'official',
    });
    expect(
      pluginMarketplaceResponseSchema.safeParse({
        ...response,
        entries: [{ ...response.entries[0], category: 'verified' }],
      }).success,
    ).toBe(false);
  });

  it('keeps exact mirrored content official with independent provenance and retains its last good snapshot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'weave-official-mirror-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const current = entry();
    const future = entry();
    future.releases[0]!.manifest = { ...future.releases[0]!.manifest, version: '1.0.1' };
    const replies = [
      { schemaVersion: 1, plugins: [current] },
      {
        schemaVersion: 1,
        plugins: [{ ...current, releases: [...current.releases, ...future.releases] }],
      },
      { schemaVersion: 1, plugins: [future] },
    ];
    const manager = await createPluginMarketplaceManager({
      settingsFile: join(directory, 'sources.jsonl'),
      fetch: async () => Response.json(replies.shift()),
    });
    cleanups.push(async () => {
      manager.closeSync();
      await manager.drain();
    });
    const added = await manager.add({
      name: 'Independent release mirror',
      url: 'https://catalog.example/official.json',
    });
    const remote = added.sources.find(({ kind }) => kind === 'remote')!;
    await manager.refresh(remote.id);
    const app = createApp(createServerRuntime(), { pluginMarketplaceManager: manager });
    const read = async (id: string) =>
      pluginMarketplaceResponseSchema.parse(
        await (await app.request(`/plugins/marketplace?sourceId=${id}`)).json(),
      );
    const first = await read(remote.id);
    expect(first.indexSource).toEqual({
      id: remote.id,
      name: 'Independent release mirror',
      url: 'https://catalog.example/official.json',
    });
    expect(first.entries).toMatchObject([
      {
        id: 'weave-official-skills',
        kind: 'github',
        category: 'official',
        name: 'Weave 官方技能',
        publisher: 'Weave',
        releases: [{ manifest, source }],
      },
    ]);
    await manager.refresh(remote.id);
    expect(manager.listSources().sources.find(({ id }) => id === remote.id)).toMatchObject({
      status: 'unavailable',
      stale: true,
      errorCode: 'invalid-index',
    });
    expect(await read(remote.id)).toEqual(first);
    const withFuture = await manager.add({
      name: 'Future release mirror',
      url: 'https://catalog.example/future.json',
    });
    const futureId = withFuture.sources.find(({ name }) => name === 'Future release mirror')!.id;
    await manager.refresh(futureId);
    expect(manager.listSources().sources.find(({ id }) => id === futureId)).toMatchObject({
      status: 'unavailable',
      stale: false,
      errorCode: 'invalid-index',
    });
    expect(await read(futureId)).toMatchObject({ communityStatus: 'unavailable', entries: [] });
  });

  it('allows explicit local import of the protected ID without granting trust, selection or activation', async () => {
    const f = await createInstallerHttpFixture(cleanups, []);
    await f.startUnbound({ skillsDirectory: false });
    const before = f.snapshot();
    const body = pluginMarketplaceResponseSchema.parse(await f.http('/plugins/marketplace'));
    expect(body.entries.find(({ id }) => id === manifest.id)).toMatchObject({
      kind: 'github',
      category: 'official',
    });
    expect((await f.catalog()).plugins).toEqual([]);
    expect(f.snapshot().heads).toEqual(before.heads);
    const preview = await f.preview(payload);
    expect(preview.candidate.manifest).toEqual(manifest);
    const imported = await f.import(importBody('official-local-import', preview));
    expect(imported).toMatchObject({
      kind: 'committed',
      decision: { pluginId: 'weave-official-skills', selection: null, trust: null },
      application: { status: 'not-required', active: null },
    });
    expect((await f.catalog()).plugins).toEqual([
      {
        pluginId: 'weave-official-skills',
        candidates: [expect.objectContaining({ manifest, provenance: 'local-directory' })],
        selection: null,
        trust: null,
        active: null,
      },
    ]);
    expect(f.snapshot().trustEvents).toEqual([]);
  });
});
