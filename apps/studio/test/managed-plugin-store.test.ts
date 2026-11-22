// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ManagedHeads,
  ManagedMutationResponse,
  ManagedReview,
} from '../src/features/plugins/managed-plugin-types.js';
import {
  createPluginCatalogStore,
  type PluginCatalogState,
} from '../src/features/plugins/plugin-catalog-store.js';
import {
  managedDecision,
  managedManifest,
  managedPluginId,
  managedPreview,
  secondDigest,
} from './support/managed-plugin-fixtures.js';

const initialHeads = { installSequence: 2, trustSequence: 4, operationSequence: 6 };
const advancedHeads = { installSequence: 2, trustSequence: 4, operationSequence: 8 };
const generation = { id: 7, acceptingRuns: true };
const managedBlock = {
  code: 'plugin-generation-blocked',
  message: 'New runs are blocked pending a compliant Generation.',
};
const local = {
  directory: '/plugins',
  exists: true,
  truncated: false,
  trustSequence: 1,
  generation: { ...generation, plugins: [] },
};
const importedReview = {
  kind: 'import',
  preview: { ...managedPreview, expectedInstallSequence: 2 },
} satisfies ManagedReview;
const selection = {
  pluginId: managedPluginId,
  expectedInstallSequence: 2,
  expectedTrustSequence: 4,
};
const activate = {
  kind: 'activate',
  ...selection,
  digest: secondDigest,
  manifest: managedManifest,
  previousSelection: null,
  intent: 'activate',
} satisfies ManagedReview;
const enable = {
  kind: 'enable',
  ...selection,
  selectedDigest: secondDigest,
} satisfies ManagedReview;
const disable = {
  kind: 'disable',
  ...selection,
  selectedDigest: secondDigest,
  immediate: false,
} satisfies ManagedReview;
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
const json = (body: unknown, status = 200) => Response.json(body, { status });
const error = (status: number, code: string) => json({ error: { code, message: code } }, status);
const disabledMcp = () => error(404, 'mcp-management-disabled');
const esm = (gen = generation) => json({ plugins: [], local, generation: gen });
const mcp = (gen = generation, authoritySequence = 5) =>
  json({ generation: gen, authoritySequence, servers: [] });
const managed = (heads: ManagedHeads = initialHeads, gen = generation) => ({
  heads,
  generation: gen,
  plugins: [],
});

function importReceipt(init: RequestInit, heads = advancedHeads) {
  const { requestId } = JSON.parse(String(init.body)) as { requestId: string };
  return json({
    kind: 'replayed',
    decision: {
      ...managedDecision({ kind: 'import', digest: secondDigest }),
      requestId,
      changed: false,
      selection: null,
      trust: null,
      installEventSequence: null,
      trustEventSequence: null,
    },
    current: managed(heads),
    application: { status: 'unknown' },
  } satisfies ManagedMutationResponse);
}

type Handler = (path: string, init: RequestInit) => Response | Promise<Response> | undefined;
function installFetch(handler: Handler = () => undefined) {
  const fetch = vi.fn((input: RequestInfo | URL, init: RequestInit) => {
    const path = String(input);
    const response = handler(path, init);
    if (response !== undefined) return response;
    if (init.method === 'GET') {
      if (path === '/plugins') return esm();
      if (path === '/mcp') return mcp();
      if (path === '/plugins/managed') return json(managed());
    }
    throw new Error(`Unexpected fetch ${init.method} ${path}`);
  });
  vi.stubGlobal('fetch', fetch);
  return {
    fetch,
    writes: () => fetch.mock.calls.filter(([, init]) => init.method !== 'GET'),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('complete catalog observations', () => {
  it('pairs managed blocked presence and allows its independent issue text', async () => {
    const blocked = {
      ...generation,
      acceptingRuns: false,
      blocked: { code: 'broken', message: 'ESM/MCP reason' },
    };
    let managedReads = 0;
    const fetch = installFetch((path) => {
      if (path === '/plugins') return esm(blocked);
      if (path === '/mcp') return mcp(blocked);
      return json(
        managed(
          initialHeads,
          ++managedReads === 1
            ? { ...generation, acceptingRuns: false }
            : { ...blocked, blocked: managedBlock },
        ),
      );
    });
    const store = createPluginCatalogStore();
    const published: PluginCatalogState[] = [];
    store.subscribe(() => {
      const state = store.getSnapshot();
      if (state.catalog !== undefined) published.push(state);
    });
    await store.ensureLoaded();
    expect(fetch.fetch.mock.calls.map(([path]) => path)).toEqual([
      '/plugins',
      '/mcp',
      '/plugins/managed',
      '/plugins',
      '/mcp',
      '/plugins/managed',
    ]);
    expect(published.length).toBeGreaterThan(0);
    for (const state of published) {
      expect(state.catalog?.generation).toEqual(blocked);
      expect(state.mcp?.generation).toEqual(blocked);
      expect(state.managed).toMatchObject({
        kind: 'enabled',
        catalog: { generation: { blocked: managedBlock } },
      });
    }
  });

  it('retains the complete catalog after three ESM/MCP block-detail mismatches', async () => {
    const blocked = {
      ...generation,
      acceptingRuns: false,
      blocked: { code: 'blocked', message: 'same' },
    };
    let mismatch = false;
    const { fetch } = installFetch((path) => {
      if (path === '/plugins') return esm(blocked);
      if (path === '/mcp')
        return mcp(
          mismatch ? { ...blocked, blocked: { code: 'blocked', message: 'different' } } : blocked,
        );
      return json(managed(initialHeads, { ...blocked, blocked: managedBlock }));
    });
    const store = createPluginCatalogStore();
    await store.ensureLoaded();
    const accepted = store.getSnapshot();
    mismatch = true;
    fetch.mockClear();
    await expect(store.refresh()).rejects.toMatchObject({ code: 'catalog-generation-mismatch' });
    expect(fetch).toHaveBeenCalledTimes(9);
    expect(store.getSnapshot().catalog).toBe(accepted.catalog);
    expect(store.getSnapshot().mcp).toBe(accepted.mcp);
    expect(store.getSnapshot().managed).toBe(accepted.managed);
    mismatch = false;
    await store.refresh();
    expect(store.getSnapshot().consistency.kind).toBe('ready');
  });

  it.each(['disabled', 'legacy'] as const)(
    'accepts initial %s, then treats its return after enablement as a protocol failure',
    async (kind) => {
      let enabled = false;
      installFetch((path) => {
        if (path === '/mcp') return disabledMcp();
        if (path !== '/plugins/managed') return enabled ? esm() : json({ plugins: [] });
        if (enabled) return json(managed());
        return kind === 'legacy'
          ? new Response('404 Not Found', { status: 404 })
          : error(404, 'plugin-installer-disabled');
      });
      const store = createPluginCatalogStore();
      await store.ensureLoaded();
      expect(store.getSnapshot().managed).toEqual({ kind });
      expect(store.getSnapshot().sharedManagementBlocked).toBe(false);
      enabled = true;
      await store.refresh();
      const accepted = store.getSnapshot();
      enabled = false;
      await expect(store.refresh()).rejects.toBeDefined();
      expect(store.getSnapshot().managed).toBe(accepted.managed);
      expect(store.getSnapshot().catalog).toBe(accepted.catalog);
      expect(store.getSnapshot().consistency).toEqual({ kind: 'unavailable', reason: 'protocol' });
    },
  );

  it.each([
    { installSequence: 1, trustSequence: 5, operationSequence: 9 },
    { installSequence: 3, trustSequence: 3, operationSequence: 9 },
    { installSequence: 3, trustSequence: 4, operationSequence: 7 },
  ])('confirms receipt heads and rejects any regressions in %o', async (regressed) => {
    let heads = initialHeads;
    installFetch((path, init) => {
      if (path === '/plugins/managed/import') return importReceipt(init);
      if (path === '/plugins/managed') return json(managed(heads));
      return undefined;
    });
    const store = createPluginCatalogStore();
    await store.ensureLoaded();
    const result = await store.submitManaged(importedReview);
    expect(result.kind).toBe('saved');
    if (result.kind !== 'saved') return;
    const accepted = store.getSnapshot();
    expect(accepted.managedLastResult?.decision.requestId).toBe(result.response.decision.requestId);
    expect(accepted.managed).toMatchObject({ catalog: { heads: advancedHeads } });
    heads = regressed;
    await expect(store.refresh()).rejects.toMatchObject({ code: 'catalog-managed-authority-lag' });
    expect(store.getSnapshot().managed).toBe(accepted.managed);
    expect(store.getSnapshot().consistency).toEqual({
      kind: 'unavailable',
      reason: 'managed-authority-lag',
    });
    heads = { ...advancedHeads, operationSequence: 9 };
    await store.refresh();
    expect(store.getSnapshot().managed).toMatchObject({ catalog: { heads } });
    expect(store.getSnapshot().reviewEpoch).toBe(accepted.reviewEpoch);
  });

  it('retains a receipt below the confirmed heads and replaces its seed with a real GET', async () => {
    const { fetch } = installFetch((path, init) => {
      if (path === '/plugins/managed/import') return importReceipt(init, initialHeads);
      if (path === '/plugins/managed') return json(managed(advancedHeads));
      return undefined;
    });
    const store = createPluginCatalogStore();
    await store.ensureLoaded();
    fetch.mockClear();
    const afterSubmit: Array<number | undefined> = [];
    store.subscribe(() => {
      const { managed } = store.getSnapshot();
      afterSubmit.push(
        managed?.kind === 'enabled' ? managed.catalog.heads.operationSequence : undefined,
      );
    });
    expect(await store.submitManaged(importedReview)).toMatchObject({
      kind: 'saved',
      response: { current: { heads: initialHeads } },
    });
    expect(store.getSnapshot().managedLastResult?.current.heads).toEqual(initialHeads);
    expect(store.getSnapshot().managed).toMatchObject({ catalog: { heads: advancedHeads } });
    expect(afterSubmit.every((sequence) => sequence === 8)).toBe(true);
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      '/plugins/managed/import',
      '/plugins',
      '/mcp',
      '/plugins',
      '/mcp',
      '/plugins/managed',
    ]);
  });

  it.each(['available', 'missing'] as const)(
    'replaces a legacy ESM write seed with a real GET whose generation is %s',
    async (freshGeneration) => {
      let written = false;
      const receipt = { generation: 7, unchanged: false, failed: [] };
      const { fetch } = installFetch((path) => {
        if (path === '/plugins/manual/trust') {
          written = true;
          return json({ plugins: [], local, result: receipt });
        }
        if (path === '/plugins' && (!written || freshGeneration === 'missing'))
          return json({ plugins: [], local });
        if (path === '/mcp' && !written) return disabledMcp();
        if (path === '/plugins/managed' && !written)
          return new Response('404 Not Found', { status: 404 });
        return undefined;
      });
      const store = createPluginCatalogStore();
      await store.ensureLoaded();
      const original = store.getSnapshot();
      fetch.mockClear();
      await store.trust('manual', secondDigest);
      expect(fetch.mock.calls.map(([path, init]) => [path, init.method])).toEqual([
        ['/plugins/manual/trust', 'POST'],
        ['/mcp', 'GET'],
        ['/plugins/managed', 'GET'],
        ['/plugins', 'GET'],
        ['/mcp', 'GET'],
        ['/plugins/managed', 'GET'],
      ]);
      const state = store.getSnapshot();
      expect(state.lastResult).toEqual(receipt);
      if (freshGeneration === 'available') {
        expect(state).toMatchObject({
          catalog: { generation },
          mcp: { generation },
          managed: { kind: 'enabled', catalog: { generation } },
          consistency: { kind: 'ready' },
          sharedManagementBlocked: false,
        });
      } else {
        expect(state.catalog).toBe(original.catalog);
        expect(state.managed).toBe(original.managed);
        expect(state).toMatchObject({
          error: { code: 'catalog-invalid-generation' },
          consistency: { kind: 'unavailable', reason: 'protocol' },
          sharedManagementBlocked: true,
        });
      }
    },
  );

  it.each(['/plugins', '/mcp'])(
    'classifies a 503 from %s using HTTP status even when its code matches local lag',
    async (failedPath) => {
      let fail = false;
      const code = 'catalog-managed-authority-lag';
      installFetch((path) => (fail && path === failedPath ? error(503, code) : undefined));
      const store = createPluginCatalogStore();
      await store.ensureLoaded();
      const original = store.getSnapshot();
      fail = true;
      await expect(store.refresh()).rejects.toMatchObject({ code, status: 503 });
      const state = store.getSnapshot();
      expect(state.catalog).toBe(original.catalog);
      expect(state.mcp).toBe(original.mcp);
      expect(state.managed).toBe(original.managed);
      expect(state).toMatchObject({
        error: { code, status: 503 },
        consistency: { kind: 'unavailable', reason: 'protocol' },
        canRecoverManagedLag: false,
      });
    },
  );
});

describe('managed request recovery', () => {
  it('retains a no-op import after a lost response and replays the same request after failed GET', async () => {
    let sends = 0;
    let offline = false;
    const uuid = vi.spyOn(crypto, 'randomUUID');
    const { fetch, writes } = installFetch((path, init) => {
      if (path === '/plugins/managed/import') {
        if (++sends === 1) throw new TypeError('lost after commit');
        return importReceipt(init);
      }
      if (offline) throw new TypeError('GET offline');
      return undefined;
    });
    const store = createPluginCatalogStore();
    const unmount = store.subscribe(() => {});
    await store.ensureLoaded();
    expect(await store.submitManaged(importedReview)).toMatchObject({
      kind: 'unresolved',
      pluginId: managedPluginId,
      target: { kind: 'import' },
      error: { code: 'plugin-network' },
    });
    unmount();
    const remount = store.subscribe(() => {});
    await store.ensureLoaded();
    await store.refresh();
    expect(store.getSnapshot()).toMatchObject({
      consistency: { kind: 'ready' },
      managedUnresolved: { pluginId: managedPluginId },
      sharedManagementBlocked: true,
    });
    const count = fetch.mock.calls.length;
    await expect(store.trust('manual', secondDigest)).rejects.toBeDefined();
    await expect(store.updateMcp('notes', 5, config)).rejects.toBeDefined();
    await expect(store.removeMcp('notes', 5)).rejects.toBeDefined();
    await expect(store.previewManaged('/missing-source')).rejects.toBeDefined();
    await expect(store.reload()).rejects.toBeDefined();
    expect(await store.submitManaged(importedReview)).toMatchObject({ kind: 'not-sent' });
    expect(fetch).toHaveBeenCalledTimes(count);
    offline = true;
    const read = expect(store.refresh()).rejects.toMatchObject({ code: 'plugin-network' });
    const retry = store.retryManaged();
    await read;
    const replay = await retry;
    expect(replay).toMatchObject({
      kind: 'saved',
      response: { kind: 'replayed', decision: { changed: false } },
    });
    expect(writes()).toHaveLength(2);
    expect(writes()[0]).toEqual(writes()[1]);
    expect(writes()[1]?.[1].signal).toBeUndefined();
    expect(uuid).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().managedUnresolved).toBeUndefined();
    expect(store.getSnapshot().managedLastResult).toMatchObject({ kind: 'replayed' });
    expect(store.getSnapshot().consistency).toEqual({ kind: 'unavailable', reason: 'network' });
    remount();
  });

  const rows = [
    [400, 'plugin-invalid-request', importedReview, 'none', undefined],
    [403, 'forbidden-origin', importedReview, 'none', undefined],
    [404, 'plugin-installer-disabled', importedReview, 'none', undefined],
    [413, 'plugin-request-too-large', importedReview, 'none', undefined],
    [415, 'unsupported-media-type', importedReview, 'none', undefined],
    [409, 'plugin-authority-request-conflict', importedReview, 'none', 'none'],
    [409, 'plugin-preview-stale', importedReview, 'preview', 'preview'],
    [409, 'plugin-managed-id-conflict', importedReview, 'preview', 'preview'],
    [409, 'plugin-managed-namespace-unavailable', importedReview, 'retry-review', 'retry-review'],
    [409, 'plugin-artifact-capacity', importedReview, 'retry-review', 'retry-review'],
    [409, 'plugin-authority-conflict', importedReview, undefined, undefined],
    [409, 'plugin-authority-conflict', activate, 'review', 'review'],
    [404, 'plugin-authority-not-found', disable, 'review', 'review'],
    [409, 'plugin-authority-activation-required', enable, 'activate', 'activate'],
    [409, 'plugin-artifact-unavailable', importedReview, 'preview', 'preview'],
    [409, 'plugin-artifact-unavailable', activate, 'review', 'review'],
    [409, 'plugin-artifact-unavailable', enable, 'review', 'review'],
    [409, 'plugin-artifact-unavailable', disable, undefined, undefined],
    [409, 'plugin-preview-stale', enable, undefined, undefined],
    [409, 'plugin-authority-activation-required', activate, undefined, undefined],
    [404, 'plugin-authority-not-found', importedReview, undefined, undefined],
    [500, 'plugin-management-failed', importedReview, undefined, undefined],
    [503, 'plugin-authority-busy', importedReview, undefined, undefined],
    [500, 'plugin-preview-stale', importedReview, undefined, undefined],
    [200, 'plugin-preview-stale', importedReview, undefined, undefined],
  ] as const;

  it.each(rows)(
    'classifies %i %s for %o on first send and retry',
    async (status, code, review, firstRecovery, retryRecovery) => {
      let transportLost = false;
      let sent = false;
      installFetch((path, init) => {
        if (init.method === 'POST') {
          sent = true;
          if (transportLost) throw new TypeError('lost');
          return error(status, code);
        }
        if (sent && path === '/plugins') return error(502, 'reconciliation-error');
        return undefined;
      });
      const expectedCode =
        status === 200
          ? 'plugin-invalid-response'
          : status === 500 && code === 'plugin-preview-stale'
            ? 'plugin-request-failed'
            : code;
      const outcome = (recovery: string | undefined) => ({
        kind: recovery === undefined ? 'unresolved' : 'rejected',
        pluginId: managedPluginId,
        target: { kind: review.kind },
        error: { code: expectedCode, status },
        ...(recovery === undefined ? {} : { recovery }),
      });
      const firstStore = createPluginCatalogStore();
      await firstStore.ensureLoaded();
      expect(await firstStore.submitManaged(review)).toMatchObject(outcome(firstRecovery));
      expect(firstStore.getSnapshot().error?.code).toBe('reconciliation-error');

      const retryStore = createPluginCatalogStore();
      sent = false;
      transportLost = true;
      await retryStore.ensureLoaded();
      expect(await retryStore.submitManaged(review)).toMatchObject({ kind: 'unresolved' });
      transportLost = false;
      const retried = await retryStore.retryManaged();
      expect(retried).toMatchObject(outcome(retryRecovery));
      if (retryRecovery === undefined) {
        expect(retryStore.getSnapshot().managedUnresolved?.error).toBe(
          retried.kind === 'unresolved' ? retried.error : undefined,
        );
      } else {
        expect(retryStore.getSnapshot().managedUnresolved).toBeUndefined();
        expect(retryStore.getSnapshot().managedLastRejection).toMatchObject({
          recovery: retryRecovery,
        });
      }
    },
  );

  it('checks only relevant review heads after an older in-flight GET', async () => {
    let pending: ((response: Response) => void) | undefined;
    let refresh = false;
    const { writes } = installFetch((path, init) => {
      if (path === '/plugins/managed/import')
        return importReceipt(init, { ...advancedHeads, trustSequence: 5 });
      if (path === '/plugins/managed' && refresh) {
        refresh = false;
        return new Promise<Response>((resolve) => {
          pending = resolve;
        });
      }
      return undefined;
    });
    const store = createPluginCatalogStore();
    await store.ensureLoaded();
    refresh = true;
    const read = store.refresh();
    const selectionAttempt = store.submitManaged(enable);
    await vi.waitFor(() => expect(pending).toBeDefined());
    expect(writes()).toHaveLength(0);
    pending?.(json(managed({ ...initialHeads, trustSequence: 5, operationSequence: 7 })));
    await read;
    expect(await selectionAttempt).toMatchObject({ kind: 'not-sent' });
    expect(writes()).toHaveLength(0);
    expect(await store.submitManaged(importedReview)).toMatchObject({ kind: 'saved' });
    expect(writes()).toHaveLength(1);
  });

  it('lets a dispatched preview finish independently with its caller signal', async () => {
    let finishPreview: ((response: Response) => void) | undefined;
    const { writes } = installFetch((path, init) => {
      if (path === '/plugins/managed/preview')
        return new Promise<Response>((resolve) => {
          finishPreview = resolve;
        });
      if (path === '/plugins/managed/import') return importReceipt(init, initialHeads);
      return undefined;
    });
    const store = createPluginCatalogStore();
    await store.ensureLoaded();
    const controller = new AbortController();
    const preview = store.previewManaged('/plugins/notes', controller.signal);
    expect(await store.submitManaged(importedReview)).toMatchObject({ kind: 'saved' });
    expect(writes().map(([path]) => path)).toEqual([
      '/plugins/managed/preview',
      '/plugins/managed/import',
    ]);
    expect(writes()[0]?.[1].signal).toBe(controller.signal);
    expect(writes()[1]?.[1].signal).toBeUndefined();
    finishPreview?.(json(managedPreview));
    await expect(preview).resolves.toEqual(managedPreview);
  });

  it('records the caller ID for managed legacy handoff across GET and clears it on a later attempt', async () => {
    const { writes } = installFetch((path) => {
      if (path === '/plugins/manual/trust') return error(409, 'plugin-managed-review-required');
      if (path === '/plugins/other/disable') return error(404, 'plugin-not-found');
      return undefined;
    });
    const store = createPluginCatalogStore();
    await store.ensureLoaded();
    await expect(store.trust('manual', secondDigest)).rejects.toMatchObject({
      code: 'plugin-managed-review-required',
    });
    await store.refresh();
    expect(store.getSnapshot().managedReviewRequiredId).toBe('manual');
    await expect(store.setEnabled('other', false)).rejects.toMatchObject({
      code: 'plugin-not-found',
    });
    expect(store.getSnapshot().managedReviewRequiredId).toBeUndefined();
    expect(writes()).toHaveLength(2);
  });

  it('defers reentrant public reads until a cold write and its reconciliation finish', async () => {
    let finishWrite: ((response: Response) => void) | undefined;
    const { fetch } = installFetch((path) => {
      if (path === '/plugins/managed/import')
        return new Promise<Response>((resolve) => {
          finishWrite = resolve;
        });
      return undefined;
    });
    const store = createPluginCatalogStore();
    let publicRead: Promise<void> | undefined;
    let publicRefresh: Promise<void> | undefined;
    let competing: Promise<void> | undefined;
    let readFinished = false;
    const unsubscribe = store.subscribe(() => {
      const state = store.getSnapshot();
      if (state.pendingOperation?.source !== 'managed' || publicRead !== undefined) return;
      publicRead = store.ensureLoaded().then(() => {
        readFinished = true;
      });
      publicRefresh = store.refresh();
      competing = expect(store.trust('manual', secondDigest)).rejects.toMatchObject({
        code: 'plugin-operation-pending',
      });
    });
    const write = store.submitManaged(importedReview);
    await vi.waitFor(() => expect(finishWrite).toBeDefined());
    expect(readFinished).toBe(false);
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      '/plugins',
      '/mcp',
      '/plugins/managed',
      '/plugins/managed/import',
    ]);
    expect(store.getSnapshot()).toMatchObject({
      sharedManagementBlocked: true,
      pendingOperation: { source: 'managed', id: managedPluginId, kind: 'import' },
    });
    finishWrite?.(importReceipt(fetch.mock.calls[3]![1], initialHeads));
    expect(await write).toMatchObject({ kind: 'saved' });
    await Promise.all([publicRead, publicRefresh, competing]);
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      '/plugins',
      '/mcp',
      '/plugins/managed',
      '/plugins/managed/import',
      '/plugins',
      '/mcp',
      '/plugins',
      '/mcp',
      '/plugins/managed',
    ]);
    unsubscribe();
  });

  it('reserves abandonment reconciliation before ordinary writes can reenter', async () => {
    let holdRead = false;
    let finishRead: ((response: Response) => void) | undefined;
    const { writes } = installFetch((path) => {
      if (path === '/plugins/managed/import') throw new TypeError('lost');
      if (path === '/plugins' && holdRead)
        return new Promise<Response>((resolve) => {
          finishRead = resolve;
        });
      return undefined;
    });
    const store = createPluginCatalogStore();
    await store.ensureLoaded();
    expect(await store.submitManaged(importedReview)).toMatchObject({ kind: 'unresolved' });
    let blocked: Promise<void> | undefined;
    const unsubscribe = store.subscribe(() => {
      const state = store.getSnapshot();
      if (state.managedUnresolved !== undefined || blocked !== undefined) return;
      expect(state.sharedManagementBlocked).toBe(true);
      blocked = expect(store.removeMcp('notes', 5)).rejects.toMatchObject({
        code: 'plugin-operation-pending',
      });
    });
    holdRead = true;
    const abandon = store.stopTrackingManaged();
    await vi.waitFor(() => expect(finishRead).toBeDefined());
    expect(store.getSnapshot().consistency.kind).toBe('refreshing');
    finishRead?.(esm());
    await abandon;
    await blocked;
    unsubscribe();
    expect(store.getSnapshot().managedLastResult).toBeUndefined();
    expect(store.getSnapshot().sharedManagementBlocked).toBe(false);
    expect(writes()).toHaveLength(1);
  });
});

describe('managed authority lag recovery', () => {
  it.each([
    ['mcp', '/mcp/reload', '{"expectedSequence":23}'],
    ['esm', '/plugins/reload', '{}'],
    ['mismatch', undefined, undefined],
    ['no-manager', undefined, undefined],
  ] as const)(
    'uses the fresh %s observation to decide whether and where to reload',
    async (mode, expectedPath, expectedBody) => {
      let phase = 'initial';
      let freshMcpReads = 0;
      const { writes } = installFetch((path, init) => {
        if (path === '/plugins/managed/import') return importReceipt(init);
        if (path === '/plugins/managed') {
          return json(managed(phase === 'applied' ? advancedHeads : initialHeads));
        }
        if (path === '/plugins' && phase === 'fresh' && mode === 'no-manager')
          return json({ plugins: [], generation });
        if (path === '/mcp' && (phase === 'initial' || mode === 'esm' || mode === 'no-manager'))
          return disabledMcp();
        if (path === '/mcp')
          return mcp(
            mode === 'mismatch' && ++freshMcpReads > 1 ? { ...generation, id: 9 } : generation,
            23,
          );
        if (path === '/mcp/reload' || path === '/plugins/reload') {
          phase = 'applied';
          const result =
            path === '/mcp/reload'
              ? {
                  authoritySequence: 24,
                  generation,
                  servers: [],
                  result: { decisionSequence: 24, applied: true, unchanged: false, failed: [] },
                }
              : {
                  plugins: [],
                  local,
                  generation,
                  result: { generation: 7, unchanged: false, failed: [] },
                };
          return json(result);
        }
        return undefined;
      });
      const store = createPluginCatalogStore();
      await store.ensureLoaded();
      expect(store.getSnapshot().mcpAvailable).toBe(false);
      expect(await store.submitManaged(importedReview)).toMatchObject({ kind: 'saved' });
      await expect(store.refresh()).rejects.toMatchObject({
        code: 'catalog-managed-authority-lag',
      });
      expect(store.getSnapshot().canRecoverManagedLag).toBe(true);
      phase = 'fresh';
      if (mode === 'mismatch') {
        await expect(store.reload()).rejects.toMatchObject({ code: 'catalog-generation-mismatch' });
      } else if (mode === 'no-manager') {
        await expect(store.reload()).rejects.toMatchObject({
          code: 'catalog-managed-authority-lag',
        });
        expect(store.getSnapshot().canRecoverManagedLag).toBe(false);
      } else {
        await store.reload();
        expect(store.getSnapshot().consistency.kind).toBe('ready');
      }
      expect(
        writes()
          .slice(1)
          .map(([path, init]) => [path, init.body]),
      ).toEqual(expectedPath === undefined ? [] : [[expectedPath, expectedBody]]);
    },
  );
});

describe('GitHub previews use the shared management gate', () => {
  const source = {
    repository: 'https://github.com/weave/plugins',
    commit: 'a'.repeat(40),
    subdirectory: '',
  };
  it('rejects preview admission while a shared write is pending', async () => {
    let finish: ((response: Response) => void) | undefined;
    const { writes } = installFetch((path) => {
      if (path === '/mcp/servers')
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      return undefined;
    });
    const store = createPluginCatalogStore();
    await store.ensureLoaded();
    const writing = store.configureMcp(5, config).catch(() => undefined);
    await vi.waitFor(() => expect(finish).toBeDefined());
    await expect(store.previewGithubManaged(source)).rejects.toMatchObject({
      code: 'plugin-operation-pending',
    });
    expect(writes()).toHaveLength(1);
    finish?.(error(409, 'mcp-authority-conflict'));
    await writing;
  });

  it('forwards a caller-owned signal to GitHub preview without changing import replay', async () => {
    const { writes } = installFetch((path) =>
      path === '/plugins/managed/github/preview'
        ? json({ ...managedPreview, github: source })
        : undefined,
    );
    const store = createPluginCatalogStore();
    await store.ensureLoaded();
    const signal = new AbortController().signal;
    await expect(store.previewGithubManaged(source, signal)).resolves.toEqual({
      ...managedPreview,
      github: source,
    });
    expect(
      writes().map(([path, init]) => [path, init.signal, JSON.parse(String(init.body))]),
    ).toEqual([['/plugins/managed/github/preview', signal, source]]);
    expect(store.getSnapshot().sharedManagementBlocked).toBe(false);
  });
});

describe('GitHub import keeps the durable retry independent of acquisition', () => {
  it('retries the exact frozen import body without fetching a source again', async () => {
    const github = {
      repository: 'https://github.com/weave/plugins',
      commit: 'a'.repeat(40),
      subdirectory: '',
    };
    let imports = 0;
    let acquisitions = 0;
    const network = installFetch((path, init) => {
      if (path === '/plugins/managed/github/preview') {
        acquisitions++;
        return json({ ...importedReview.preview, github });
      }
      if (path === '/plugins/managed/import') {
        if (++imports === 1) throw new TypeError('lost after decision');
        return importReceipt(init);
      }
      return undefined;
    });
    const store = createPluginCatalogStore();
    await store.ensureLoaded();
    const preview = await store.previewGithubManaged(github);
    expect(await store.submitManaged({ kind: 'import', preview })).toMatchObject({
      kind: 'unresolved',
    });
    const original = network.writes()[1]!;
    github.repository = 'https://github.com/changed/source';
    await expect(store.previewGithubManaged(github)).rejects.toMatchObject({
      code: 'plugin-managed-unresolved',
    });
    expect(await store.retryManaged()).toMatchObject({
      kind: 'saved',
      response: { kind: 'replayed' },
    });
    expect(acquisitions).toBe(1);
    expect(network.writes()[2]).toEqual(original);
    expect(JSON.parse(String(original[1].body))).toEqual({
      requestId: expect.any(String),
      previewId: 'preview-1',
      expectedInstallSequence: 2,
    });
  });
});
