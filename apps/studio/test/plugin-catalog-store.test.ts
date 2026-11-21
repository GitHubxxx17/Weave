// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { PluginApiError } from '../src/features/plugins/plugin-api.js';
import { createPluginCatalogStore } from '../src/features/plugins/plugin-catalog-store.js';

const digest = 'a'.repeat(64);
const row = {
  id: 'echo',
  name: 'Echo',
  version: '1.0.0',
  origin: 'local',
  host: 'in-process',
  state: 'pending-trust',
  capabilities: ['tool'],
  provides: {
    tools: [],
    providers: [],
    promptSections: [],
    events: [],
    commands: [],
    hooks: [],
    services: [],
  },
  local: { directory: '/plugins/echo', digest, enabled: false },
};
const catalog = { plugins: [row] };
const local = {
  directory: '/plugins',
  exists: true,
  truncated: false,
  trustSequence: 0,
  generation: { id: 1, acceptingRuns: true, plugins: [] },
};
const mutation = {
  plugins: [{ ...row, state: 'loaded', local: { ...row.local, enabled: true } }],
  local,
  result: { generation: 1, unchanged: false, failed: [] },
};

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installFetch(responses: Array<Response | Promise<Response>>) {
  const fetchMock = vi.fn();
  for (const item of responses) fetchMock.mockImplementationOnce(() => item);
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    String(input).endsWith('/mcp')
      ? Promise.resolve(
          response(
            {
              error: {
                code: 'mcp-management-disabled',
                message: 'MCP not enabled in legacy fixture',
              },
            },
            404,
          ),
        )
      : fetchMock(input, init),
  );
  return fetchMock;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('plugin catalog store', () => {
  it('deduplicates initial GET across repeated ensureLoaded and keeps stable snapshots', async () => {
    let resolve!: (r: Response) => void;
    const pending = new Promise<Response>((r) => {
      resolve = r;
    });
    const fetchMock = installFetch([pending]);
    const store = createPluginCatalogStore();
    const before = store.getSnapshot();
    const first = store.ensureLoaded();
    const second = store.ensureLoaded();
    expect(first).toBe(second);
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolve(response(catalog));
    await first;
    expect(store.getSnapshot().catalog).toEqual(catalog);
    expect(store.getSnapshot()).toBe(store.getSnapshot());
    expect(store.getSnapshot()).not.toBe(before);
  });

  it('waits for initial GET before a trust POST and rejects duplicate writes', async () => {
    let resolveGet!: (r: Response) => void;
    const get = new Promise<Response>((r) => {
      resolveGet = r;
    });
    let resolvePost!: (r: Response) => void;
    const post = new Promise<Response>((r) => {
      resolvePost = r;
    });
    const fetchMock = installFetch([get, post]);
    const store = createPluginCatalogStore();
    const trust = store.trust('echo', digest);
    expect(store.getSnapshot().pendingOperation).toEqual({ kind: 'trust', id: 'echo', digest });
    await expect(store.setEnabled('echo', true)).rejects.toMatchObject({
      code: 'plugin-operation-pending',
    });
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveGet(response(catalog));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    resolvePost(response(mutation));
    await trust;
    expect(store.getSnapshot().catalog).toEqual({ plugins: mutation.plugins, local });
    expect(store.getSnapshot().lastResult).toEqual(mutation.result);
    expect(store.getSnapshot().pendingOperation).toBeUndefined();
  });

  it('keeps a successful mutation catalog immutable like the initial cached GET', async () => {
    installFetch([response({ ...catalog, local }), response(mutation)]);
    const store = createPluginCatalogStore();
    await store.ensureLoaded();
    expect(Object.isFrozen(store.getSnapshot().catalog)).toBe(true);

    await store.trust('echo', digest);

    const state = store.getSnapshot();
    expect(Object.isFrozen(state.catalog)).toBe(true);
    expect(Object.isFrozen(state.catalog?.plugins)).toBe(true);
    expect(Object.isFrozen(state.catalog?.local)).toBe(true);
  });

  it('shares a concurrent reload and uses GET in read-only mode', async () => {
    let resolve!: (r: Response) => void;
    const pending = new Promise<Response>((r) => {
      resolve = r;
    });
    const fetchMock = installFetch([response(catalog), pending]);
    const store = createPluginCatalogStore();
    await store.ensureLoaded();
    const one = store.reload();
    const two = store.reload();
    expect(one).toBe(two);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    resolve(response(catalog));
    await one;
    expect(fetchMock.mock.calls[1][0]).toBe('/plugins');
  });

  it('reconciles a rejected write and preserves its original error when GET succeeds', async () => {
    const failed = new PluginApiError('plugin-digest-mismatch', 'stale digest', 409);
    const fetchMock = installFetch([
      response(catalog),
      response({ error: { code: failed.code, message: failed.message } }, 409),
      response({ plugins: [{ ...row, state: 'changed' }] }),
    ]);
    const store = createPluginCatalogStore();
    await store.ensureLoaded();
    await expect(store.trust('echo', digest)).rejects.toBeInstanceOf(PluginApiError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(store.getSnapshot().catalog?.plugins[0]?.state).toBe('changed');
    expect(store.getSnapshot().error?.code).toBe(failed.code);
  });

  it('keeps the previous catalog when reconciliation GET fails', async () => {
    installFetch([
      response(catalog),
      response({ error: { code: 'plugin-storage-failed', message: 'no' } }, 500),
      response('bad', 500),
    ]);
    const store = createPluginCatalogStore();
    await store.ensureLoaded();
    await expect(store.setEnabled('echo', false)).rejects.toMatchObject({
      code: 'plugin-storage-failed',
    });
    expect(store.getSnapshot().catalog).toEqual(catalog);
  });

  it('isolates separate factories', async () => {
    const fetchMock = installFetch([response(catalog), response({ plugins: [] })]);
    const first = createPluginCatalogStore();
    const second = createPluginCatalogStore();
    await first.ensureLoaded();
    await second.ensureLoaded();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(first.getSnapshot().catalog).not.toEqual(second.getSnapshot().catalog);
  });
});

describe('plugin catalog coordination under failures', () => {
  it('does not retry failed startup for remounted consumers and retries once on explicit reload', async () => {
    const fetchMock = installFetch([response({}, 503), response(catalog)]);
    const store = createPluginCatalogStore();
    const initial = store.ensureLoaded();
    await expect(initial).rejects.toMatchObject({ status: 503 });
    const remount = store.ensureLoaded();
    expect(remount).toBe(initial);
    await expect(remount).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await store.reload();
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
      ['/plugins', 'GET'],
      ['/plugins', 'GET'],
    ]);
    expect(store.getSnapshot().error).toBeUndefined();
    expect(store.getSnapshot().catalog).toEqual(catalog);
  });

  it('retries a failed initial GET before deciding to POST for managed reload', async () => {
    const fetchMock = installFetch([
      response({}, 500),
      response({ ...catalog, local }),
      response(mutation),
    ]);
    const store = createPluginCatalogStore();
    await expect(store.ensureLoaded()).rejects.toMatchObject({ status: 500 });
    const first = store.reload();
    expect(store.getSnapshot().pendingOperation).toEqual({ kind: 'reload' });
    expect(store.reload()).toBe(first);
    await first;
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
      ['/plugins', 'GET'],
      ['/plugins', 'GET'],
      ['/plugins/reload', 'POST'],
    ]);
    expect(store.getSnapshot().lastResult).toEqual(mutation.result);
  });

  it('keeps failed explicit read-only refresh read-only and retains prior rows', async () => {
    const fetchMock = installFetch([response(catalog), response({}, 500)]);
    const store = createPluginCatalogStore();
    await store.ensureLoaded();
    await expect(store.reload()).rejects.toMatchObject({ status: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().catalog).toEqual(catalog);
    expect(store.getSnapshot().pendingOperation).toBeUndefined();
  });

  it('keeps busy until rejected disable reconciliation publishes the durable state', async () => {
    let resolveRead!: (r: Response) => void;
    const fetchMock = installFetch([
      response({ ...catalog, local }),
      response({ error: { code: 'plugin-discovery-failed', message: 'decision persisted' } }, 500),
      new Promise<Response>((resolve) => {
        resolveRead = resolve;
      }),
    ]);
    const store = createPluginCatalogStore();
    await store.ensureLoaded();
    const operation = store.setEnabled('echo', false, true);
    const rejection = expect(operation).rejects.toMatchObject({ code: 'plugin-discovery-failed' });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(store.getSnapshot().pendingOperation).toEqual({ kind: 'disable', id: 'echo' });
    await expect(store.revoke('echo')).rejects.toMatchObject({ code: 'plugin-operation-pending' });
    const blocked = { code: 'plugin-generation-blocked', message: 'generation blocked' };
    resolveRead(
      response({
        plugins: [{ ...row, state: 'disabled' }],
        local: {
          ...local,
          trustSequence: 1,
          generation: { ...local.generation, acceptingRuns: false, blocked },
        },
      }),
    );
    await rejection;
    expect(store.getSnapshot().catalog?.plugins[0]?.state).toBe('disabled');
    expect(store.getSnapshot().catalog?.local?.generation).toMatchObject({
      acceptingRuns: false,
      blocked,
    });
    expect(store.getSnapshot().pendingOperation).toBeUndefined();
    expect(store.getSnapshot().error?.message).toBe('decision persisted');
    expect(fetchMock.mock.calls[1][0]).toBe('/plugins/echo/disable?immediate=true');
  });

  it('returns the exact original write error despite a failing reconciliation', async () => {
    const fetchMock = installFetch([response({ ...catalog, local })]);
    const store = createPluginCatalogStore();
    await store.ensureLoaded();
    const oldCatalog = store.getSnapshot().catalog;
    const original = new TypeError('transport closed');
    fetchMock.mockRejectedValueOnce(original);
    fetchMock.mockRejectedValueOnce(new TypeError('GET also down'));
    let rejected: unknown;
    try {
      await store.trust('echo', digest);
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBe(store.getSnapshot().error);
    expect(rejected).toMatchObject({ code: 'plugin-network', status: 0 });
    expect(store.getSnapshot().catalog).toBe(oldCatalog);
  });

  it('adopts a disabled management GET after 404 without probing another POST', async () => {
    const fetchMock = installFetch([
      response({ ...catalog, local }),
      response({ error: { code: 'plugin-management-disabled', message: 'disabled' } }, 404),
      response(catalog),
      response(catalog),
    ]);
    const store = createPluginCatalogStore();
    await store.ensureLoaded();
    await expect(store.reload()).rejects.toMatchObject({ code: 'plugin-management-disabled' });
    expect(store.getSnapshot().catalog?.local).toBeUndefined();
    await store.reload();
    expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual([
      'GET',
      'POST',
      'GET',
      'GET',
    ]);
  });

  it('does not disable management for a missing row and preserves a durable rebuild result', async () => {
    const issue = { code: 'plugin-generation-blocked', message: 'kept old generation' };
    const rebuilt = {
      ...mutation,
      result: {
        generation: 1,
        unchanged: false,
        failed: [{ id: 'echo', error: issue }],
        error: issue,
      },
    };
    const fetchMock = installFetch([
      response({ ...catalog, local }),
      response({ error: { code: 'plugin-not-found', message: 'missing row' } }, 404),
      response({ ...catalog, local }),
      response(rebuilt),
    ]);
    const store = createPluginCatalogStore();
    await store.ensureLoaded();
    await expect(store.revoke('echo')).rejects.toMatchObject({ code: 'plugin-not-found' });
    await store.reload();
    expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual([
      'GET',
      'DELETE',
      'GET',
      'POST',
    ]);
    expect(store.getSnapshot().lastResult).toEqual(rebuilt.result);
    expect(store.getSnapshot().error).toBeUndefined();
  });

  it('publishes successful catalog and result together and subscriptions own no requests', async () => {
    let resolvePost!: (r: Response) => void;
    const fetchMock = installFetch([
      response({ ...catalog, local }),
      new Promise<Response>((resolve) => {
        resolvePost = resolve;
      }),
    ]);
    const store = createPluginCatalogStore();
    await store.ensureLoaded();
    const observed: Array<{ state: string | undefined; generation: number | undefined }> = [];
    const unsubscribeOne = store.subscribe(() => {
      const state = store.getSnapshot();
      observed.push({
        state: state.catalog?.plugins[0]?.state,
        generation: state.lastResult?.generation,
      });
    });
    const listenerTwo = vi.fn();
    const unsubscribeTwo = store.subscribe(listenerTwo);
    const operation = store.setEnabled('echo', true);
    unsubscribeOne();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    resolvePost(response(mutation));
    await operation;
    expect(store.getSnapshot().catalog?.plugins[0]?.state).toBe('loaded');
    expect(listenerTwo).toHaveBeenCalled();
    expect(observed).toEqual([{ state: 'pending-trust', generation: undefined }]);
    expect(fetchMock.mock.calls.every(([, init]) => init.signal === undefined)).toBe(true);
    unsubscribeTwo();
  });
});

it('synchronously rejects a reentrant write triggered by the pending-operation notification', async () => {
  let resolvePost!: (value: Response) => void;
  const fetchMock = installFetch([
    response(catalog),
    new Promise<Response>((resolve) => {
      resolvePost = resolve;
    }),
  ]);
  const store = createPluginCatalogStore();
  await store.ensureLoaded();
  let reentrant: Promise<void> | undefined;
  const unsubscribe = store.subscribe(() => {
    if (store.getSnapshot().pendingOperation?.kind === 'trust' && reentrant === undefined) {
      reentrant = store.setEnabled('echo', true);
    }
  });
  const trust = store.trust('echo', digest);
  await expect(reentrant).rejects.toMatchObject({ code: 'plugin-operation-pending' });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  unsubscribe();
  resolvePost(response(mutation));
  await trust;
});

it('deduplicates ensureLoaded reentry during the loading-state notification', async () => {
  let resolve!: (value: Response) => void;
  const fetchMock = installFetch([
    new Promise<Response>((r) => {
      resolve = r;
    }),
  ]);
  const store = createPluginCatalogStore();
  let reentered: Promise<void> | undefined;
  const unsubscribe = store.subscribe(() => {
    if (store.getSnapshot().initialLoading && reentered === undefined) {
      reentered = store.ensureLoaded();
    }
  });
  const initial = store.ensureLoaded();
  expect(reentered).toBe(initial);
  await Promise.resolve();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  resolve(response(catalog));
  await initial;
  unsubscribe();
  expect(store.getSnapshot().catalog).toEqual(catalog);
});
