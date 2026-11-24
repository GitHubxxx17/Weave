import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { GithubPluginAcquirer } from '@weave/plugin-host';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOfficialMarketplacePolicy } from '../src/official-marketplace-releases.js';
import {
  officialEntry,
  officialFamily,
  officialRelease,
} from './support/official-marketplace-fixture.js';

afterEach(() => {
  vi.doUnmock('../src/official-marketplace-releases.js');
  vi.resetModules();
});

describe('fixture official policy at real marketplace boundaries', () => {
  it('uses the same exact policy for fetched indexes, generation, writes and acquired descriptors', async () => {
    const policy = createOfficialMarketplacePolicy([officialFamily()]);
    vi.doMock('../src/official-marketplace-releases.js', async (original) => ({
      ...(await original<typeof import('../src/official-marketplace-releases.js')>()),
      assertOfficialMarketplaceEntry: policy.assertEntry,
    }));
    const { createPluginMarketplaceManager } = await import('../src/plugin-marketplace-manager.js');
    const { generateMarketplaceIndex, prepareMarketplaceSubmission, writeMarketplaceSubmission } =
      await import('../src/marketplace-tooling.js');
    const directory = await mkdtemp(join(tmpdir(), 'weave-official-boundaries-'));
    const entry = officialEntry();
    const mixed = officialEntry();
    mixed.releases.push(officialRelease('3.0.0'));
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ schemaVersion: 1, plugins: [entry] }))
      .mockResolvedValueOnce(Response.json({ schemaVersion: 1, plugins: [mixed] }));
    const manager = await createPluginMarketplaceManager({
      settingsFile: join(directory, 'settings.json'),
      builtinCatalogFile: false,
      fetch,
    });
    try {
      await manager.add(
        { name: 'Independent mirror', url: 'https://catalog.example/index.json' },
        manager.listSources().revision,
      );
      const id = manager.listSources().sources[1]!.id;
      await manager.refresh(id);
      expect(manager.catalog(id).catalog.plugins).toEqual([entry]);
      await manager.refresh(id);
      expect(manager.listSources().sources[1]).toMatchObject({
        status: 'unavailable',
        stale: true,
        errorCode: 'invalid-index',
      });
      expect(manager.catalog(id).catalog.plugins).toEqual([entry]);

      const submissionsDirectory = join(directory, 'submissions');
      await mkdir(submissionsDirectory);
      const submissionFile = join(submissionsDirectory, `${entry.id}.json`);
      await writeMarketplaceSubmission(submissionFile, entry);
      const options = { submissionsDirectory, outputFile: join(directory, 'index.json') };
      expect(await generateMarketplaceIndex({ ...options, mode: 'write' })).toEqual({
        plugins: 1,
        changed: true,
      });
      expect(await generateMarketplaceIndex({ ...options, mode: 'check' })).toEqual({
        plugins: 1,
        changed: false,
      });
      const previous = await readFile(options.outputFile, 'utf8');
      expect(
        JSON.parse(previous).plugins[0].releases.map(
          (release: { manifest: { version: string } }) => release.manifest.version,
        ),
      ).toEqual(['2.0.0', '1.0.0']);
      const rejectedFile = join(directory, 'rejected.json');
      await expect(writeMarketplaceSubmission(rejectedFile, mixed)).rejects.toThrow();
      await expect(readFile(rejectedFile)).rejects.toMatchObject({ code: 'ENOENT' });
      await writeFile(submissionFile, JSON.stringify(mixed));
      await expect(generateMarketplaceIndex({ ...options, mode: 'write' })).rejects.toThrow();
      expect(await readFile(options.outputFile, 'utf8')).toBe(previous);

      const payload = join(directory, 'payload');
      await mkdir(payload);
      await writeFile(
        join(payload, 'weave-plugin.json'),
        JSON.stringify({
          schemaVersion: 1,
          entry: 'index.mjs',
          manifest: officialRelease().manifest,
        }),
      );
      await writeFile(
        join(payload, 'index.mjs'),
        'throw new Error("official acquisition never executes code")',
      );
      let released = false;
      const acquirer: GithubPluginAcquirer = {
        async withSource(selected, use) {
          expect(selected).toEqual(officialRelease().source);
          try {
            return await use(payload, new AbortController().signal);
          } finally {
            released = true;
          }
        },
      };
      const request = {
        name: entry.name,
        description: entry.description,
        publisher: entry.publisher,
        tags: entry.tags,
        source: officialRelease().source,
      };
      expect(await prepareMarketplaceSubmission(request, { acquirer })).toEqual({
        ...entry,
        releases: [officialRelease()],
      });
      expect(released).toBe(true);
      await writeFile(
        join(payload, 'weave-plugin.json'),
        JSON.stringify({
          schemaVersion: 1,
          entry: 'index.mjs',
          manifest: { ...officialRelease().manifest, description: 'Changed after review' },
        }),
      );
      await expect(prepareMarketplaceSubmission(request, { acquirer })).rejects.toThrow();
    } finally {
      manager.closeSync();
      await manager.drain();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('admits exact mirrored releases, overrides all display fields and preserves custom index provenance', async () => {
    const policy = createOfficialMarketplacePolicy([officialFamily()]);
    vi.doMock('../src/official-marketplace-releases.js', async (original) => ({
      ...(await original<typeof import('../src/official-marketplace-releases.js')>()),
      assertOfficialMarketplaceEntry: policy.assertEntry,
    }));
    const {
      loadPluginMarketplaceCatalog,
      projectPluginMarketplace,
      pluginMarketplaceIndexSchema,
      pluginMarketplaceResponseSchema,
    } = await import('../src/plugin-marketplace.js');
    const { createApp } = await import('../src/app.js');
    const { createServerRuntime } = await import('../src/runtime.js');
    const { createPluginMarketplaceManager } = await import('../src/plugin-marketplace-manager.js');
    const directory = await mkdtemp(join(tmpdir(), 'weave-official-projection-'));
    const file = join(directory, 'catalog.json');
    const index = { schemaVersion: 1, plugins: [officialEntry()] };
    await writeFile(file, JSON.stringify(index));
    const manager = await createPluginMarketplaceManager({
      settingsFile: join(directory, 'settings.json'),
      builtinCatalogFile: false,
      operatorCatalogFile: file,
    });
    try {
      expect(pluginMarketplaceIndexSchema.safeParse(index).success).toBe(true);
      const catalog = await loadPluginMarketplaceCatalog(file);
      expect(catalog.communityStatus).toBe('ready');
      const app = createApp(createServerRuntime(), { pluginMarketplaceManager: manager });
      const body = await (await app.request('/plugins/marketplace')).json();
      expect(pluginMarketplaceResponseSchema.safeParse(body).success).toBe(true);
      expect(body.indexSource).toEqual({ id: 'operator', name: '本地插件目录', url: null });
      expect(body.entries).toEqual([
        {
          id: 'fixture-official-skills',
          kind: 'github',
          category: 'official',
          name: 'Host-owned Skills',
          description: 'Host-owned description',
          publisher: 'Weave',
          tags: ['host-owned'],
          releases: [
            { ...officialRelease('2.0.0'), compatibility: 'incompatible' },
            { ...officialRelease(), compatibility: 'incompatible' },
          ],
        },
      ]);
      const incompatible = projectPluginMarketplace(catalog, [], '0.0.0');
      expect(incompatible.entries[0]).toMatchObject({
        kind: 'github',
        category: 'official',
        releases: [{ compatibility: 'incompatible' }, { compatibility: 'incompatible' }],
      });
      expect(projectPluginMarketplace(catalog, [], '1.0.0').entries[0]).toMatchObject({
        category: 'official',
        releases: [{ compatibility: 'compatible' }, { compatibility: 'compatible' }],
      });
      const mixed = officialEntry();
      mixed.releases.push(officialRelease('3.0.0'));
      expect(
        pluginMarketplaceIndexSchema.safeParse({ schemaVersion: 1, plugins: [mixed] }).success,
      ).toBe(false);
      expect(() =>
        projectPluginMarketplace({ communityStatus: 'ready', plugins: [mixed] }, [], '1.0.0'),
      ).toThrow();
      const malformed = { ...officialEntry(), category: 'official' };
      expect(() =>
        projectPluginMarketplace({ communityStatus: 'ready', plugins: [malformed] }, [], '1.0.0'),
      ).toThrow();
    } finally {
      manager.closeSync();
      await manager.drain();
      await rm(directory, { force: true, recursive: true });
    }
  });
});
