import { appendFile, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createServerRuntime } from '../src/runtime.js';
import { createPluginMarketplaceManager } from '../src/plugin-marketplace-manager.js';
import { maxPluginMarketplaceBytes } from '../src/plugin-marketplace.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(fetch: typeof globalThis.fetch = vi.fn()) {
  const directory = await mkdtemp(join(tmpdir(), 'weave-market-sources-'));
  cleanups.push(() => rm(directory, { force: true, recursive: true }));
  const settingsFile = join(directory, 'sources.jsonl');
  const manager = await createPluginMarketplaceManager({
    settingsFile,
    builtinCatalogFile: false,
    fetch,
  });
  cleanups.push(async () => {
    manager.closeSync();
    await manager.drain();
  });
  return { manager, directory, settingsFile };
}
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
    await manager.add({ name: 'Weave', url: 'https://catalog.example/index.json' });
    const id = manager.listSources().sources[1]!.id;
    await manager.refresh(id);
    await manager.refresh(id);
    expect(manager.listSources().sources[1]).toMatchObject({
      status: 'unavailable',
      stale: true,
      errorCode: 'invalid-index',
    });
    expect(manager.catalog(id).catalog.plugins).toEqual([plugin]);
    await manager.add({ name: 'Weave future', url: 'https://catalog.example/future.json' });
    const futureId = manager.listSources().sources[2]!.id;
    await manager.refresh(futureId);
    expect(manager.listSources().sources[2]).toMatchObject({
      status: 'unavailable',
      stale: false,
      errorCode: 'invalid-index',
    });
    expect(manager.catalog(futureId).catalog.plugins).toEqual([]);
  });

  it('persists add/remove facts, canonicalizes GitHub URLs and never fetches on configuration or reads', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const { manager, settingsFile } = await fixture(fetch);
    expect(manager.listSources().sources[0]).toMatchObject({
      id: 'weave',
      kind: 'builtin',
      url: null,
      removable: false,
      status: 'ready',
    });
    await manager.add({
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
    await expect(manager.add({ name: 'Duplicate', url: source.url! })).rejects.toMatchObject({
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
    await restarted.remove(source.id);
    expect(restarted.listSources().sources).toHaveLength(1);
    const events = (await readFile(settingsFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events.map((event) => event.operation)).toEqual(['add', 'remove']);
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('publishes only valid bounded refreshes and retains the previous catalog as stale after errors', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(index()))
      .mockResolvedValueOnce(new Response('bad json'));
    const { manager } = await fixture(fetch);
    await manager.add({ name: 'Team', url: 'https://catalog.example/index.json' });
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
    await manager.add({ name: 'Team', url: 'https://catalog.example/index.json' });
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
    await manager.add({ name: 'Team', url: 'https://catalog.example/index.json' });
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
      await expect(manager.add({ name: 'Team', url })).rejects.toMatchObject({ status: 400 });
    }
    await expect(manager.remove('weave')).rejects.toMatchObject({ status: 400 });
    await expect(manager.refresh('missing')).rejects.toMatchObject({ status: 404 });
    for (let i = 0; i < 10; i++)
      await manager.add({ name: `Source ${i}`, url: `https://catalog.example/${i}.json` });
    await expect(
      manager.add({ name: 'Overflow', url: 'https://catalog.example/overflow.json' }),
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
      broken.add({ name: 'No', url: 'https://catalog.example/index.json' }),
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
      linked.add({ name: 'No', url: 'https://catalog.example/index.json' }),
    ).rejects.toMatchObject({ status: 503 });
    expect(await readFile(settingsFile, 'utf8')).toBe(malformed);
  });

  it('does not publish settings after an on-disk append conflict and blocks later writes', async () => {
    const { manager, settingsFile } = await fixture();
    await manager.add({ name: 'One', url: 'https://catalog.example/1' });
    await appendFile(settingsFile, 'unknown partial tail');
    await expect(
      manager.add({ name: 'Two', url: 'https://catalog.example/2' }),
    ).rejects.toMatchObject({ status: 503 });
    expect(manager.listSources().sources).toHaveLength(2);
    expect(manager.listSources().sources[0]).toMatchObject({ errorCode: 'settings-unavailable' });
    await expect(manager.remove(manager.listSources().sources[1]!.id)).rejects.toMatchObject({
      status: 503,
    });
    expect(await readFile(settingsFile, 'utf8')).toContain('unknown partial tail');
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
      manager.add({ name: 'One', url: 'https://catalog.example/1' }),
      manager.add({ name: 'Two', url: 'https://catalog.example/2' }),
    ]);
    const id = manager.listSources().sources[1]!.id;
    const active = manager.refresh(id);
    await entered.promise;
    const queued = manager.add({ name: 'Three', url: 'https://catalog.example/3' });
    const queuedResult = queued.catch((error: unknown) => error);
    manager.closeSync();
    await expect(manager.remove(id)).rejects.toMatchObject({ status: 503 });
    await active;
    expect(await queuedResult).toMatchObject({ status: 503 });
    await manager.drain();
    expect((await readFile(settingsFile, 'utf8')).trim().split('\n')).toHaveLength(2);
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
    ).toBe(200);
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
