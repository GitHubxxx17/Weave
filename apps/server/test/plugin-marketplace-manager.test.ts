import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createServerRuntime } from '../src/runtime.js';
import {
  createPluginMarketplaceManager,
  type PluginMarketplaceManager,
} from '../src/plugin-marketplace-manager.js';
import { marketplaceRemoteId } from '../src/plugin-marketplace-source-types.js';
import { maxPluginMarketplaceBytes } from '../src/plugin-marketplace.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(fetch: typeof globalThis.fetch = vi.fn()) {
  const directory = await mkdtemp(join(tmpdir(), 'weave-market-sources-'));
  cleanups.push(() => rm(directory, { force: true, recursive: true }));
  const settingsFile = join(directory, 'sources.json');
  const legacySettingsFile = join(directory, 'sources.jsonl');
  const manager = await createPluginMarketplaceManager({
    settingsFile,
    legacySettingsFile,
    builtinCatalogFile: false,
    fetch,
  });
  cleanups.push(async () => {
    manager.closeSync();
    await manager.drain();
  });
  return { manager, directory, settingsFile, legacySettingsFile };
}
const add = (
  manager: PluginMarketplaceManager,
  input: { readonly name: string; readonly url: string },
) => manager.add(input, manager.listSources().revision);
const remove = (manager: PluginMarketplaceManager, id: string) =>
  manager.remove(id, manager.listSources().revision);
async function reopen(settingsFile: string, legacySettingsFile?: string) {
  const manager = await createPluginMarketplaceManager({
    settingsFile,
    ...(legacySettingsFile === undefined ? {} : { legacySettingsFile }),
    builtinCatalogFile: false,
  });
  cleanups.push(async () => {
    manager.closeSync();
    await manager.drain();
  });
  return manager;
}
const remoteUrl = (n: number) => `https://catalog.example/${n}.json`;
const legacyAdd = (sequence: number, n: number) => ({
  sequence,
  operation: 'add',
  id: marketplaceRemoteId(remoteUrl(n)),
  name: `Source ${n}`,
  url: remoteUrl(n),
});
const legacyRemove = (sequence: number, n: number) => ({
  sequence,
  operation: 'remove',
  id: marketplaceRemoteId(remoteUrl(n)),
});
const jsonl = (events: readonly object[]) => events.map((e) => `${JSON.stringify(e)}\n`).join('');
const plugin = {
  id: 'community-notes',
  name: 'Notes',
  description: 'Workspace notes',
  publisher: 'A developer',
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
const index = () => ({ schemaVersion: 1, plugins: [plugin] });
const headers = { Host: 'localhost', 'Content-Type': 'application/json' };

describe('marketplace index sources', () => {
  it('rejects a future protected release as a whole index and retains only the last good snapshot', async () => {
    const protectedEntry = structuredClone(plugin);
    protectedEntry.id = protectedEntry.releases[0]!.manifest.id = 'weave-official-skills';
    protectedEntry.releases[0]!.manifest.version = '9999.0.0';
    const futureIndex = { schemaVersion: 1, plugins: [plugin, protectedEntry] };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(index()))
      .mockResolvedValueOnce(Response.json(futureIndex))
      .mockResolvedValueOnce(Response.json(futureIndex));
    const { manager } = await fixture(fetch);
    await add(manager, { name: 'Weave', url: 'https://catalog.example/index.json' });
    const id = manager.listSources().sources[1]!.id;
    await manager.refresh(id);
    await manager.refresh(id);
    expect(manager.listSources().sources[1]).toMatchObject({
      status: 'unavailable',
      stale: true,
      errorCode: 'invalid-index',
    });
    expect(manager.catalog(id).catalog.plugins).toEqual([plugin]);
    await add(manager, { name: 'Weave future', url: 'https://catalog.example/future.json' });
    const futureId = manager.listSources().sources[2]!.id;
    await manager.refresh(futureId);
    expect(manager.listSources().sources[2]).toMatchObject({
      status: 'unavailable',
      stale: false,
      errorCode: 'invalid-index',
    });
    expect(manager.catalog(futureId).catalog.plugins).toEqual([]);
  });

  it('persists the current source list, canonicalizes GitHub URLs and never fetches on configuration or reads', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const { manager, settingsFile } = await fixture(fetch);
    expect(manager.listSources().sources[0]).toMatchObject({
      id: 'weave',
      kind: 'builtin',
      url: null,
      removable: false,
      status: 'ready',
    });
    await add(manager, {
      name: 'Team',
      url: 'https://github.com/team/catalog/blob/main/index.json',
    });
    const source = manager.listSources().sources[1]!;
    expect(source).toMatchObject({
      kind: 'remote',
      status: 'unfetched',
      url: 'https://raw.githubusercontent.com/team/catalog/main/index.json',
    });
    expect(manager.catalog(source.id).catalog).toEqual({
      communityStatus: 'unconfigured',
      plugins: [],
    });
    expect(fetch).not.toHaveBeenCalled();
    await expect(add(manager, { name: 'Duplicate', url: source.url! })).rejects.toMatchObject({
      status: 409,
    });
    manager.closeSync();
    await manager.drain();
    const restarted = await createPluginMarketplaceManager({
      settingsFile,
      builtinCatalogFile: false,
      fetch,
    });
    cleanups.push(async () => {
      restarted.closeSync();
      await restarted.drain();
    });
    expect(restarted.listSources().sources[1]).toEqual(source);
    await remove(restarted, source.id);
    expect(restarted.listSources().sources).toHaveLength(1);
    expect(JSON.parse(await readFile(settingsFile, 'utf8'))).toEqual({
      version: 1,
      revision: 2,
      sources: [],
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('publishes only valid bounded refreshes and retains the previous catalog as stale after errors', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(index()))
      .mockResolvedValueOnce(new Response('bad json'));
    const { manager } = await fixture(fetch);
    await add(manager, { name: 'Team', url: 'https://catalog.example/index.json' });
    const id = manager.listSources().sources[1]!.id;
    await manager.refresh(id);
    expect(fetch).toHaveBeenCalledWith(
      'https://catalog.example/index.json',
      expect.objectContaining({ redirect: 'error', credentials: 'omit', method: 'GET' }),
    );
    expect(manager.catalog(id).catalog.plugins[0]).toEqual(plugin);
    expect(manager.listSources().sources[1]).toMatchObject({
      status: 'ready',
      stale: false,
      fetchedAt: expect.any(String),
    });
    await manager.refresh(id);
    expect(manager.listSources().sources[1]).toMatchObject({
      status: 'unavailable',
      stale: true,
      errorCode: 'invalid-index',
    });
    expect(manager.catalog(id).catalog.plugins[0]).toEqual(plugin);
  });

  it.each([
    [
      'redirect',
      () =>
        new Response('', { status: 302, headers: { Location: 'https://other.example/catalog' } }),
      'network',
    ],
    ['bad UTF-8', () => new Response(new Uint8Array([255])), 'invalid-index'],
    ['invalid schema', () => Response.json({ ...index(), verified: true }), 'invalid-index'],
    [
      'reserved ID',
      () => Response.json({ schemaVersion: 1, plugins: [{ ...plugin, id: 'tool-registry' }] }),
      'invalid-index',
    ],
    [
      'oversized stream',
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(maxPluginMarketplaceBytes + 1));
              c.close();
            },
          }),
        ),
      'too-large',
    ],
    [
      'oversized declared length',
      () =>
        new Response('{}', {
          headers: { 'Content-Length': String(maxPluginMarketplaceBytes + 1) },
        }),
      'too-large',
    ],
  ] as const)('rejects %s without poisoning its cache', async (_name, response, errorCode) => {
    const { manager } = await fixture(
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(response()),
    );
    await add(manager, { name: 'Team', url: 'https://catalog.example/index.json' });
    const id = manager.listSources().sources[1]!.id;
    await manager.refresh(id);
    expect(manager.listSources().sources[1]).toMatchObject({
      status: 'unavailable',
      stale: false,
      errorCode,
    });
    expect(manager.catalog(id).catalog.plugins).toEqual([]);
  });

  it('times out a stalled response body and cancels it', async () => {
    let cancelled = false;
    const { manager } = await fixture(
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        ),
      ),
    );
    await add(manager, { name: 'Team', url: 'https://catalog.example/index.json' });
    const id = manager.listSources().sources[1]!.id;
    vi.useFakeTimers();
    const operation = manager.refresh(id);
    await vi.advanceTimersByTimeAsync(15001);
    await operation;
    expect(manager.listSources().sources[1]).toMatchObject({ errorCode: 'timeout' });
    expect(cancelled).toBe(true);
  });

  it('rejects unsupported addresses, unknown/immutable sources and active-source overflow', async () => {
    const { manager } = await fixture();
    for (const url of [
      'http://catalog.example/index.json',
      'https://user:pass@catalog.example/index.json',
      'https://catalog.example/index.json#x',
      'file:///tmp/catalog.json',
    ]) {
      await expect(add(manager, { name: 'Team', url })).rejects.toMatchObject({ status: 400 });
    }
    await expect(remove(manager, 'weave')).rejects.toMatchObject({ status: 400 });
    await expect(manager.refresh('missing')).rejects.toMatchObject({ status: 404 });
    for (let i = 0; i < 10; i++)
      await add(manager, { name: `Source ${i}`, url: `https://catalog.example/${i}.json` });
    await expect(
      add(manager, { name: 'Overflow', url: 'https://catalog.example/overflow.json' }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('fails settings writes closed on malformed logs and symlinks while preserving builtins and file bytes', async () => {
    const { manager, settingsFile, directory } = await fixture();
    manager.closeSync();
    await manager.drain();
    const malformed = '{"operation":"add"}\n';
    await writeFile(settingsFile, malformed);
    const broken = await createPluginMarketplaceManager({
      settingsFile,
      builtinCatalogFile: false,
    });
    cleanups.push(async () => {
      broken.closeSync();
      await broken.drain();
    });
    expect(broken.listSources().sources).toHaveLength(1);
    await expect(
      add(broken, { name: 'No', url: 'https://catalog.example/index.json' }),
    ).rejects.toMatchObject({ status: 503 });
    expect(await readFile(settingsFile, 'utf8')).toBe(malformed);
    const link = join(directory, 'link.jsonl');
    await symlink(settingsFile, link);
    const linked = await createPluginMarketplaceManager({
      settingsFile: link,
      builtinCatalogFile: false,
    });
    cleanups.push(async () => {
      linked.closeSync();
      await linked.drain();
    });
    await expect(
      add(linked, { name: 'No', url: 'https://catalog.example/index.json' }),
    ).rejects.toMatchObject({ status: 503 });
    expect(await readFile(settingsFile, 'utf8')).toBe(malformed);
  });

  it('rejects a stale revision with 409 and leaves the stored list unchanged', async () => {
    const { manager, settingsFile } = await fixture();
    await manager.add({ name: 'One', url: remoteUrl(1) }, 0);
    expect(manager.listSources().revision).toBe(1);
    const before = await readFile(settingsFile, 'utf8');
    await expect(manager.add({ name: 'Two', url: remoteUrl(2) }, 0)).rejects.toMatchObject({
      status: 409,
      code: 'plugin-marketplace-revision-conflict',
    });
    await expect(manager.remove(manager.listSources().sources[1]!.id, 0)).rejects.toMatchObject({
      status: 409,
    });
    await expect(manager.reorder([manager.listSources().sources[1]!.id], 0)).rejects.toMatchObject({
      status: 409,
    });
    expect(await readFile(settingsFile, 'utf8')).toBe(before);
    expect(manager.listSources().sources).toHaveLength(2);
  });

  it('detects another writer that replaced the settings file', async () => {
    const { manager, settingsFile } = await fixture();
    await add(manager, { name: 'One', url: remoteUrl(1) });
    const other = JSON.parse(await readFile(settingsFile, 'utf8'));
    other.revision = 7;
    await writeFile(settingsFile, JSON.stringify(other));
    await expect(add(manager, { name: 'Two', url: remoteUrl(2) })).rejects.toMatchObject({
      status: 409,
    });
    expect(JSON.parse(await readFile(settingsFile, 'utf8')).revision).toBe(7);
  });

  it('reorders remote sources and keeps the order across restarts', async () => {
    const { manager, settingsFile } = await fixture();
    for (const n of [1, 2, 3]) await add(manager, { name: `Source ${n}`, url: remoteUrl(n) });
    const ids = manager
      .listSources()
      .sources.slice(1)
      .map(({ id }) => id);
    await expect(
      manager.reorder([ids[0]!, ids[1]!], manager.listSources().revision),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      manager.reorder([ids[0]!, ids[0]!, ids[1]!], manager.listSources().revision),
    ).rejects.toMatchObject({ status: 400 });
    const result = await manager.reorder(
      [ids[2]!, ids[0]!, ids[1]!],
      manager.listSources().revision,
    );
    expect(result.revision).toBe(4);
    expect(result.sources.map(({ id }) => id)).toEqual(['weave', ids[2], ids[0], ids[1]]);
    manager.closeSync();
    await manager.drain();
    const restarted = await reopen(settingsFile);
    expect(restarted.listSources().sources.map(({ id }) => id)).toEqual([
      'weave',
      ids[2],
      ids[0],
      ids[1],
    ]);
  });

  it('is not limited to 1024 operations', async () => {
    const { manager, settingsFile } = await fixture();
    for (let i = 0; i < 520; i++) {
      await add(manager, { name: 'Cycle', url: remoteUrl(i % 2) });
      await remove(manager, marketplaceRemoteId(remoteUrl(i % 2)));
    }
    expect(manager.listSources().revision).toBe(1040);
    await add(manager, { name: 'After', url: remoteUrl(5) });
    expect(JSON.parse(await readFile(settingsFile, 'utf8')).sources).toHaveLength(1);
  }, 60_000);

  it('ignores a half-written temporary file left by a crash', async () => {
    const { manager, settingsFile, directory } = await fixture();
    await add(manager, { name: 'One', url: remoteUrl(1) });
    manager.closeSync();
    await manager.drain();
    await writeFile(`${settingsFile}.123.abcdef.tmp`, '{"version":1,"revi');
    const restarted = await reopen(settingsFile);
    expect(restarted.listSources()).toMatchObject({ revision: 1 });
    expect(restarted.listSources().sources).toHaveLength(2);
    await add(restarted, { name: 'Two', url: remoteUrl(2) });
    expect(restarted.listSources().sources).toHaveLength(3);
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toHaveLength(1);
  });

  it('migrates the retired append-only log without touching it', async () => {
    const { manager, settingsFile, legacySettingsFile } = await fixture();
    manager.closeSync();
    await manager.drain();
    const legacy = jsonl([legacyAdd(1, 1), legacyAdd(2, 2), legacyAdd(3, 3), legacyRemove(4, 2)]);
    await writeFile(legacySettingsFile, legacy);
    const migrated = await reopen(settingsFile, legacySettingsFile);
    expect(migrated.listSources().sources.map(({ name }) => name)).toEqual([
      'Weave 插件目录',
      'Source 1',
      'Source 3',
    ]);
    expect(await readFile(legacySettingsFile, 'utf8')).toBe(legacy);
    expect(JSON.parse(await readFile(settingsFile, 'utf8'))).toMatchObject({
      version: 1,
      revision: 1,
    });
    await add(migrated, { name: 'New', url: remoteUrl(4) });
    expect(await readFile(legacySettingsFile, 'utf8')).toBe(legacy);
    migrated.closeSync();
    await migrated.drain();
    // The new file wins on restart, even though the old log is still present.
    const again = await reopen(settingsFile, legacySettingsFile);
    expect(again.listSources().sources).toHaveLength(4);
  });

  it('migrates a fully used legacy log into a writable list', async () => {
    const { manager, settingsFile, legacySettingsFile } = await fixture();
    manager.closeSync();
    await manager.drain();
    const events: object[] = [];
    for (let i = 0; i < 511; i++)
      events.push(legacyAdd(events.length + 1, 1), legacyRemove(events.length + 2, 1));
    events.push(legacyAdd(1023, 7), legacyAdd(1024, 8));
    const fixed = events.map((event, index) => ({ ...event, sequence: index + 1 }));
    expect(fixed).toHaveLength(1024);
    const legacy = jsonl(fixed);
    await writeFile(legacySettingsFile, legacy);
    const migrated = await reopen(settingsFile, legacySettingsFile);
    expect(migrated.listSources().sources.map(({ name }) => name)).toEqual([
      'Weave 插件目录',
      'Source 7',
      'Source 8',
    ]);
    await add(migrated, { name: 'Beyond', url: remoteUrl(9) });
    expect(migrated.listSources().sources).toHaveLength(4);
    expect(await readFile(legacySettingsFile, 'utf8')).toBe(legacy);
    expect(JSON.parse(await readFile(settingsFile, 'utf8')).revision).toBe(2);
  });

  it('keeps a corrupt legacy log untouched, reports unavailable settings and writes nothing', async () => {
    const { manager, settingsFile, legacySettingsFile } = await fixture();
    manager.closeSync();
    await manager.drain();
    const corrupt = `${jsonl([legacyAdd(1, 1)])}{"sequence":2,"operation":"add"\n`;
    await writeFile(legacySettingsFile, corrupt);
    const broken = await reopen(settingsFile, legacySettingsFile);
    expect(broken.listSources().sources).toHaveLength(1);
    expect(broken.listSources().sources[0]).toMatchObject({ errorCode: 'settings-unavailable' });
    await expect(add(broken, { name: 'No', url: remoteUrl(2) })).rejects.toMatchObject({
      status: 503,
    });
    expect(await readFile(legacySettingsFile, 'utf8')).toBe(corrupt);
    await expect(readFile(settingsFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps cached GETs available when an operator file disappears, and refreshes that file explicitly', async () => {
    const { settingsFile, directory } = await fixture();
    const file = join(directory, 'operator.json');
    await writeFile(file, JSON.stringify(index()));
    const manager = await createPluginMarketplaceManager({
      settingsFile,
      builtinCatalogFile: false,
      operatorCatalogFile: file,
    });
    cleanups.push(async () => {
      manager.closeSync();
      await manager.drain();
    });
    expect(manager.catalog().indexSource.id).toBe('operator');
    await rm(file);
    expect(manager.catalog().catalog.plugins).toHaveLength(1);
    await manager.refresh('operator');
    expect(manager.listSources().sources[1]).toMatchObject({
      status: 'unavailable',
      stale: true,
      errorCode: 'invalid-index',
    });
    expect(manager.catalog().catalog.plugins).toHaveLength(1);
  });

  it('serializes concurrent writes, aborts active work and rejects queued/new work during close', async () => {
    const entered = Promise.withResolvers<void>();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
      entered.resolve();
      return new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }),
      );
    });
    const { manager, settingsFile } = await fixture(fetch);
    await Promise.all([
      manager.add({ name: 'One', url: 'https://catalog.example/1' }, 0),
      manager.add({ name: 'Two', url: 'https://catalog.example/2' }, 1),
    ]);
    const id = manager.listSources().sources[1]!.id;
    const active = manager.refresh(id);
    await entered.promise;
    const queued = add(manager, { name: 'Three', url: 'https://catalog.example/3' });
    const queuedResult = queued.catch((error: unknown) => error);
    manager.closeSync();
    await expect(remove(manager, id)).rejects.toMatchObject({ status: 503 });
    await active;
    expect(await queuedResult).toMatchObject({ status: 503 });
    await manager.drain();
    expect(JSON.parse(await readFile(settingsFile, 'utf8'))).toMatchObject({ revision: 2 });
  });
});

describe('marketplace source HTTP', () => {
  it('bounds a stalled JSON request body and cancels its stream', async () => {
    const { manager } = await fixture();
    const app = createApp(createServerRuntime(), { pluginMarketplaceManager: manager });
    let cancelled = false;
    vi.useFakeTimers();
    const request = new Request('http://localhost/plugins/marketplace/sources/add', {
      method: 'POST',
      headers,
      body: new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      duplex: 'half',
    } as RequestInit);
    const response = app.request(request);
    await vi.advanceTimersByTimeAsync(15_001);
    expect((await response).status).toBe(400);
    expect(cancelled).toBe(true);
    expect(manager.listSources().sources).toHaveLength(1);
  });

  it('guards writes, validates bounded JSON and serves reads without acquiring anything', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const { manager } = await fixture(fetch);
    const runtime = createServerRuntime();
    const app = createApp(runtime, { pluginMarketplaceManager: manager });
    expect((await app.request('/plugins/marketplace/sources')).status).toBe(200);
    expect((await app.request('/plugins/marketplace?sourceId=weave')).status).toBe(200);
    expect((await app.request('/plugins/marketplace?sourceId=missing')).status).toBe(404);
    const post = (body: string, moreHeaders = {}) =>
      app.request('http://localhost/plugins/marketplace/sources/add', {
        method: 'POST',
        headers: { ...headers, ...moreHeaders },
        body,
      });
    expect((await post('{}', { Host: 'remote.example' })).status).toBe(403);
    expect((await post('{}', { Origin: 'https://remote.example' })).status).toBe(403);
    expect((await post('{}', { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await post('{}', { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await post(' '.repeat(9000))).status).toBe(400);
    expect((await post('{')).status).toBe(400);
    expect(
      (await post(JSON.stringify({ name: 'Team', url: 'https://catalog.example/index.json' })))
        .status,
    ).toBe(400);
    const stale = await post(
      JSON.stringify({ name: 'Other', url: 'https://catalog.example/other.json', revision: 5 }),
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: { code: 'plugin-marketplace-revision-conflict' },
    });
    expect(
      (
        await post(
          JSON.stringify({
            name: 'Team',
            url: 'https://catalog.example/index.json',
            revision: 0,
          }),
        )
      ).status,
    ).toBe(200);
    expect((await app.request('/plugins/marketplace/sources')).status).toBe(200);
    expect(manager.listSources().revision).toBe(1);
    const source = manager.listSources().sources[1]!;
    const response = await app.request(`/plugins/marketplace?sourceId=${source.id}`);
    expect(await response.json()).toMatchObject({
      indexSource: { id: source.id, name: 'Team', url: source.url },
      communityStatus: 'unconfigured',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(runtime.status).toBe('created');
  });
});
