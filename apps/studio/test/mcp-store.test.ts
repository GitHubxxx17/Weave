// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPluginCatalogStore } from '../src/features/plugins/plugin-catalog-store.js';
import { createMcpReview } from '../src/features/mcp/mcp-review.js';
const digest = 'a'.repeat(64);
const config = {
  schemaVersion: 1 as const,
  id: 'notes',
  label: 'Notes',
  transport: 'stdio' as const,
  command: '/node',
  args: [],
  cwd: '/workspace',
  env: {},
};
const gen = (id = 1, acceptingRuns = true) => ({ id, acceptingRuns });
const plugin = (generation = gen()) => ({ plugins: [], generation });
const mcp = (generation = gen(), authoritySequence = 1) => ({
  authoritySequence,
  generation,
  servers: [
    {
      config,
      configDigest: digest,
      enabled: false,
      state: 'untrusted' as const,
      stale: false,
      drainingGenerations: [],
      tools: [],
    },
  ],
});
const mutation = (generation = gen(2), authoritySequence = 2) => ({
  ...mcp(generation, authoritySequence),
  result: { decisionSequence: authoritySequence, applied: true, unchanged: false, failed: [] },
});
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function mock(handler: (path: string, init: RequestInit) => Response | Promise<Response>) {
  const fetchMock = vi.fn((input, init) => handler(String(input), init ?? {}));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('joint plugin and MCP catalog', () => {
  it('loads both endpoints concurrently and publishes only one coherent pair', async () => {
    let finish!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const fetchMock = mock((path) => (path === '/plugins' ? response(plugin()) : pending));
    const store = createPluginCatalogStore();
    const initial = store.ensureLoaded();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(store.getSnapshot().catalog).toBeUndefined();
    finish(response(mcp()));
    await initial;
    expect(store.getSnapshot()).toMatchObject({
      catalog: plugin(),
      mcp: mcp(),
      mcpAvailable: true,
      consistency: { kind: 'ready' },
    });
  });
  it('retries full generation mismatch including admission exactly three rounds', async () => {
    let reads = 0;
    const fetchMock = mock((path) => {
      reads++;
      return response(path === '/plugins' ? plugin(gen(1, true)) : mcp(gen(1, false)));
    });
    const store = createPluginCatalogStore();
    await expect(store.ensureLoaded()).rejects.toMatchObject({
      code: 'catalog-generation-mismatch',
    });
    expect(reads).toBe(6);
    expect(fetchMock.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
    expect(store.getSnapshot()).toMatchObject({
      consistency: { kind: 'unavailable', reason: 'generation-mismatch' },
    });
    expect(store.getSnapshot().catalog).toBeUndefined();
  });
  it('converges mismatched reads without publishing contradictory intermediate snapshots', async () => {
    let pluginReads = 0;
    mock((path) => response(path === '/plugins' ? plugin(gen(++pluginReads)) : mcp(gen(2))));
    const store = createPluginCatalogStore();
    const observed: number[] = [];
    store.subscribe(() => {
      const state = store.getSnapshot();
      if (state.catalog?.generation) observed.push(state.catalog.generation.id);
    });
    await store.ensureLoaded();
    expect(store.getSnapshot().catalog?.generation?.id).toBe(2);
    expect(observed.every((id) => id === 2)).toBe(true);
  });
  it('falls back only for explicit MCP management disabled 404', async () => {
    mock((path) =>
      path === '/plugins'
        ? response({ plugins: [] })
        : response({ error: { code: 'mcp-management-disabled', message: 'disabled' } }, 404),
    );
    const legacy = createPluginCatalogStore();
    await legacy.ensureLoaded();
    expect(legacy.getSnapshot().mcpAvailable).toBe(false);
    mock((path) =>
      path === '/plugins'
        ? response(plugin())
        : response({ error: { code: 'missing', message: 'missing' } }, 404),
    );
    await expect(createPluginCatalogStore().ensureLoaded()).rejects.toMatchObject({
      code: 'missing',
      status: 404,
    });
  });
  it('requires plugin top generation when MCP is available', async () => {
    const fetchMock = mock((path) => response(path === '/plugins' ? { plugins: [] } : mcp()));
    const store = createPluginCatalogStore();
    await expect(store.ensureLoaded()).rejects.toMatchObject({
      code: 'catalog-invalid-generation',
    });
    expect(store.getSnapshot().consistency).toEqual({ kind: 'unavailable', reason: 'protocol' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('uses MCP full reload without ESM and a single cross-source write gate', async () => {
    let finish!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    let writes = false;
    const fetchMock = mock((path, init) => {
      if (init.method === 'POST') {
        writes = true;
        return pending;
      }
      return response(path === '/plugins' ? plugin(gen(writes ? 2 : 1)) : mcp());
    });
    const store = createPluginCatalogStore();
    await store.ensureLoaded();
    const reload = store.reload();
    expect(store.reload()).toBe(reload);
    await expect(store.trust('esm', digest)).rejects.toMatchObject({
      code: 'plugin-operation-pending',
    });
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.some(([path]) => path === '/mcp/reload')).toBe(true),
    );
    finish(response(mutation()));
    await reload;
    expect(fetchMock.mock.calls.find(([path]) => path === '/mcp/reload')?.[1].body).toBe(
      '{"expectedSequence":1}',
    );
    expect(store.getSnapshot().catalog?.generation?.id).toBe(2);
  });
  it('retains durable result and actual generation if post-mutation pairing fails', async () => {
    let written = false;
    mock((path, init) => {
      if (init.method === 'POST') {
        written = true;
        return response({
          ...mutation(gen(4, false)),
          result: {
            decisionSequence: 2,
            applied: false,
            unchanged: false,
            failed: [],
            error: { code: 'mcp-rebuild-failed', message: 'failed' },
          },
        });
      }
      return response(
        path === '/plugins'
          ? plugin(gen(written ? 3 : 1))
          : mcp(gen(written ? 4 : 1), written ? 2 : 1),
      );
    });
    const store = createPluginCatalogStore();
    await store.ensureLoaded();
    await store.configureMcp(1, config);
    expect(store.getSnapshot()).toMatchObject({
      catalog: plugin(),
      mcp: mcp(),
      mcpLastGeneration: gen(4, false),
      mcpLastResult: { decisionSequence: 2, applied: false },
      consistency: { kind: 'unavailable' },
    });
  });
  it('invalidates every409 review and refreshes once without resubmitting trust', async () => {
    let conflict = false;
    const fetchMock = mock((path, init) => {
      if (init.method === 'POST') {
        conflict = true;
        return response({ error: { code: 'mcp-conflict', message: 'changed' } }, 409);
      }
      return response(path === '/plugins' ? plugin() : mcp(gen(), conflict ? 2 : 1));
    });
    const store = createPluginCatalogStore();
    await store.ensureLoaded();
    const review = createMcpReview(store.getSnapshot().mcp!.servers[0]!, 1, 0);
    await expect(store.trustMcp(review)).rejects.toMatchObject({ status: 409 });
    expect(store.getSnapshot()).toMatchObject({
      reviewEpoch: 1,
      mcp: { authoritySequence: 2 },
      consistency: { kind: 'ready' },
    });
    expect(fetchMock.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    await expect(store.trustMcp(review)).rejects.toMatchObject({ code: 'mcp-review-stale' });
    expect(fetchMock.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
  });
  it('waits for an older GET before writing and never lets it overwrite a mutation', async () => {
    let finish!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    let reads = 0;
    let written = false;
    mock((path, init) => {
      if (init.method === 'POST') {
        written = true;
        return response(mutation());
      }
      if (path === '/plugins' && ++reads === 2) return pending;
      return response(
        path === '/plugins' ? plugin(gen(written ? 2 : 1)) : mcp(gen(written ? 2 : 1)),
      );
    });
    const store = createPluginCatalogStore();
    await store.ensureLoaded();
    const reading = store.refresh();
    const write = store.configureMcp(1, config);
    await Promise.resolve();
    finish(response(plugin()));
    await reading;
    await write;
    expect(store.getSnapshot().catalog?.generation?.id).toBe(2);
  });
  it('lets explicit reload recover unavailable retained data before using fresh authority', async () => {
    let failed = false;
    let recovered = false;
    const fetchMock = mock((path, init) => {
      if (init.method === 'POST') return response(mutation(gen(3), 3));
      if (failed && !recovered) throw new Error('offline');
      return response(
        path === '/plugins'
          ? plugin(gen(recovered ? 3 : 1))
          : mcp(gen(recovered ? 3 : 1), recovered ? 2 : 1),
      );
    });
    const store = createPluginCatalogStore();
    await store.ensureLoaded();
    failed = true;
    await expect(store.refresh()).rejects.toMatchObject({ code: 'plugin-network' });
    expect(store.getSnapshot().consistency.kind).toBe('unavailable');
    await expect(store.configureMcp(1, config)).rejects.toMatchObject({
      code: 'catalog-unavailable',
    });
    recovered = true;
    await store.reload();
    const writes = fetchMock.mock.calls.filter(([, init]) => init.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[0]).toBe('/mcp/reload');
    expect(writes[0]?.[1].body).toBe('{"expectedSequence":2}');
    expect(store.getSnapshot()).toMatchObject({
      consistency: { kind: 'ready' },
      mcp: { authoritySequence: 3 },
    });
  });
  it.each(['configure', 'update', 'enable', 'disable', 'revoke', 'remove', 'reload'] as const)(
    'invalidates review on %s409 even when authority content looks unchanged',
    async (kind) => {
      const fetchMock = mock((path, init) =>
        init.method !== 'GET'
          ? response({ error: { code: 'mcp-conflict', message: 'changed elsewhere' } }, 409)
          : response(path === '/plugins' ? plugin() : mcp()),
      );
      const store = createPluginCatalogStore();
      await store.ensureLoaded();
      const operation = {
        configure: () => store.configureMcp(1, config),
        update: () => store.updateMcp('notes', 1, config),
        enable: () => store.enableMcp('notes', 1, digest),
        disable: () => store.disableMcp('notes', 1),
        revoke: () => store.revokeMcp('notes', 1),
        remove: () => store.removeMcp('notes', 1),
        reload: () => store.reload(),
      }[kind];
      await expect(operation()).rejects.toMatchObject({ code: 'mcp-conflict', status: 409 });
      expect(store.getSnapshot()).toMatchObject({
        reviewEpoch: 1,
        error: { code: 'mcp-conflict', status: 409 },
        consistency: { kind: 'ready' },
      });
      expect(fetchMock.mock.calls.filter(([, init]) => init.method !== 'GET')).toHaveLength(1);
      expect(fetchMock.mock.calls.filter(([, init]) => init.method === 'GET')).toHaveLength(4);
    },
  );
  it('retains plugin mutation generation as the seed for its paired MCP read', async () => {
    let written = false;
    const local = {
      directory: '/plugins',
      exists: true,
      truncated: false,
      trustSequence: 1,
      generation: { ...gen(2), plugins: [] },
    };
    const fetchMock = mock((path, init) => {
      if (init.method === 'POST') {
        written = true;
        return response({
          ...plugin(gen(2)),
          local,
          result: { generation: 2, unchanged: false, failed: [] },
        });
      }
      return response(path === '/plugins' ? plugin() : mcp(gen(written ? 2 : 1)));
    });
    const store = createPluginCatalogStore();
    await store.ensureLoaded();
    await store.trust('esm', digest);
    expect(store.getSnapshot()).toMatchObject({
      catalog: { generation: gen(2) },
      mcp: { generation: gen(2) },
      consistency: { kind: 'ready' },
    });
    expect(
      fetchMock.mock.calls.filter(([path, init]) => path === '/plugins' && init.method === 'GET'),
    ).toHaveLength(1);
  });
  it('preserves a durable mutation when the peer catalog read cannot connect', async () => {
    let written = false;
    mock((path, init) => {
      if (init.method === 'POST') {
        written = true;
        return response(mutation());
      }
      if (written && path === '/plugins') throw new Error('offline after commit');
      return response(path === '/plugins' ? plugin() : mcp());
    });
    const store = createPluginCatalogStore();
    await store.ensureLoaded();
    await store.configureMcp(1, config);
    expect(store.getSnapshot()).toMatchObject({
      catalog: plugin(),
      mcp: mcp(),
      mcpLastResult: { decisionSequence: 2, applied: true },
      mcpLastGeneration: gen(2),
      consistency: { kind: 'unavailable', reason: 'network' },
    });
  });
});
