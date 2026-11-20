// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PluginApiError,
  fetchPluginCatalog,
  fetchPlugins,
  reloadPlugins,
  revokePluginTrust,
  setPluginEnabled,
  trustPlugin,
} from '../src/features/plugins/plugin-api.js';

const digest = 'a'.repeat(64);
const manifest = {
  id: 'server-echo',
  name: 'Server Echo',
  version: 'not-semver',
  apiVersion: 'future',
  host: 'in-process',
  capabilities: ['tool', 'future-capability'],
};
const plugin = {
  id: 'server-echo',
  name: 'Server Echo',
  version: '1.2.3',
  origin: 'registered',
  host: 'in-process',
  capabilities: ['tool'],
  provides: {
    tools: ['echo'],
    providers: [],
    promptSections: [],
    events: [],
    commands: [],
    hooks: [],
    services: [],
  },
};
const loadedPlugin = { ...plugin, state: 'loaded' };
const local = {
  directory: '/plugins',
  exists: true,
  truncated: false,
  trustSequence: 0,
  generation: { id: 2, acceptingRuns: true, plugins: [{ id: manifest.id, digest, manifest }] },
};
const mutation = {
  plugins: [loadedPlugin],
  local,
  result: { generation: 1, unchanged: false, failed: [] },
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  delete window.weaveDesktop;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Plugin API client', () => {
  it('parses the legacy plugin list and defaults its absent state', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ plugins: [plugin] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchPlugins()).resolves.toEqual([loadedPlugin]);

    expect(fetchMock).toHaveBeenCalledWith('/plugins', { method: 'GET' });
  });

  it('keeps the optional manifest fields and cached local metadata the Server sends', async () => {
    const detailed = {
      ...loadedPlugin,
      origin: 'local',
      state: 'changed',
      description: '回显文本',
      engines: { weave: '>=1.0.0' },
      contributes: { tools: ['echo'], hooks: ['weave.tools.policy'] },
      permissions: ['workspace:read', 'future-permission'],
      local: {
        directory: '/plugins/server-echo',
        digest,
        enabled: true,
        manifest,
        trusted: { digest, trustedAt: 'server-string', manifest },
        active: { generation: 1, digest, manifest },
      },
      error: { code: 'plugin-future', message: 'future issue' },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ plugins: [detailed], local })));

    await expect(fetchPluginCatalog()).resolves.toEqual({ plugins: [detailed], local });
  });

  it('shows future origin, host, capability and state strings', async () => {
    const future = {
      ...loadedPlugin,
      origin: 'marketplace',
      host: 'wasm',
      capabilities: ['future-command'],
      state: 'future-state',
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ plugins: [future] })));

    await expect(fetchPlugins()).resolves.toEqual([future]);
  });

  it('reads a list from a Server that predates plugin events, commands and hooks', async () => {
    const older = {
      ...plugin,
      provides: { tools: ['echo'], providers: [], promptSections: [], services: [] },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ plugins: [older] })));

    await expect(fetchPlugins()).resolves.toEqual([loadedPlugin]);
  });

  it('keeps defaulted legacy contribution arrays immutable like supplied arrays', async () => {
    const older = {
      ...plugin,
      provides: { tools: ['echo'], providers: [], promptSections: [], services: [] },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ plugins: [older] })));
    const catalog = await fetchPluginCatalog();
    const provides = catalog.plugins[0]?.provides;
    expect(Object.isFrozen(provides?.events)).toBe(true);
    expect(Object.isFrozen(provides?.commands)).toBe(true);
    expect(Object.isFrozen(provides?.hooks)).toBe(true);
  });

  it('resolves both reads and writes against the desktop Server URL', async () => {
    window.weaveDesktop = { isDesktop: true, serverUrl: 'http://127.0.0.1:46321/' };
    const fetchMock = vi
      .fn()
      .mockImplementation((_url, init: RequestInit) =>
        Promise.resolve(jsonResponse(init.method === 'GET' ? { plugins: [] } : mutation)),
      );
    vi.stubGlobal('fetch', fetchMock);

    await fetchPlugins();
    await reloadPlugins();

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:46321/plugins',
      'http://127.0.0.1:46321/plugins/reload',
    ]);
  });

  it.each([
    ['reload', () => reloadPlugins(), '/plugins/reload', 'POST', '{}'],
    [
      'trust',
      () => trustPlugin('id /?#', digest),
      '/plugins/id%20%2F%3F%23/trust',
      'POST',
      JSON.stringify({ digest }),
    ],
    [
      'enable',
      () => setPluginEnabled('id /?#', true),
      '/plugins/id%20%2F%3F%23/enable',
      'POST',
      '{}',
    ],
    [
      'disable',
      () => setPluginEnabled('id /?#', false),
      '/plugins/id%20%2F%3F%23/disable',
      'POST',
      '{}',
    ],
    ['revoke', () => revokePluginTrust('id /?#'), '/plugins/id%20%2F%3F%23/trust', 'DELETE', '{}'],
  ] as const)(
    'sends the exact %s write contract with only JSON headers',
    async (_name, invoke, url, method, body) => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(mutation));
      vi.stubGlobal('fetch', fetchMock);

      await expect(invoke()).resolves.toEqual(mutation);

      expect(fetchMock).toHaveBeenCalledWith(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    },
  );

  it('only appends immediate=true to explicitly requested disable or revoke', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(mutation)));
    vi.stubGlobal('fetch', fetchMock);

    await setPluginEnabled('echo', false, { immediate: true });
    await revokePluginTrust('echo', { immediate: true });
    await setPluginEnabled('echo', false, { immediate: false });
    await revokePluginTrust('echo', { immediate: false });
    await expect(setPluginEnabled('echo', true, { immediate: true })).rejects.toMatchObject({
      code: 'plugin-invalid-request',
    });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/plugins/echo/disable?immediate=true',
      '/plugins/echo/trust?immediate=true',
      '/plugins/echo/disable',
      '/plugins/echo/trust',
    ]);
  });

  it('passes abort signals through every operation', async () => {
    const controller = new AbortController();
    const fetchMock = vi
      .fn()
      .mockImplementation((_url, init: RequestInit) =>
        Promise.resolve(jsonResponse(init.method === 'GET' ? { plugins: [] } : mutation)),
      );
    vi.stubGlobal('fetch', fetchMock);

    await fetchPluginCatalog(controller.signal);
    await fetchPlugins(controller.signal);
    await reloadPlugins(controller.signal);
    await trustPlugin('echo', digest, controller.signal);
    await setPluginEnabled('echo', true, { signal: controller.signal });
    await revokePluginTrust('echo', { signal: controller.signal });

    expect(fetchMock.mock.calls).toHaveLength(6);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.signal).toBe(controller.signal);
    }
  });

  it('preserves a successful durable decision with rebuild failures and distinct current generation', async () => {
    const failure = { code: 'plugin-generation-blocked', message: 'retained generation' };
    const blocked = {
      ...mutation,
      result: {
        generation: 1,
        unchanged: false,
        failed: [{ id: 'echo', error: failure }],
        error: failure,
      },
      local: {
        ...local,
        generation: { ...local.generation, id: 3, acceptingRuns: false, blocked: failure },
        error: failure,
      },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(blocked)));

    await expect(trustPlugin('echo', digest)).resolves.toEqual(blocked);
  });

  it.each([
    { plugins: [{ id: 1 }] },
    { plugins: [{ ...loadedPlugin, provides: undefined }] },
    {
      plugins: [
        {
          ...loadedPlugin,
          local: { directory: '/plugins/echo', enabled: true, digest: 'A'.repeat(64) },
        },
      ],
    },
    {
      plugins: [
        {
          ...loadedPlugin,
          local: { directory: '/plugins/echo', enabled: true, digest: 'a'.repeat(63) },
        },
      ],
    },
    { plugins: [], local: { ...local, trustSequence: -1 } },
    { plugins: [], local: { ...local, generation: { ...local.generation, id: 0 } } },
    {
      plugins: [
        {
          ...loadedPlugin,
          local: {
            directory: '/plugins/echo',
            enabled: true,
            active: { digest, manifest, generation: 1.5 },
          },
        },
      ],
    },
  ])('rejects malformed cached catalog data %#', async (payload) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(payload)));

    await expect(fetchPluginCatalog()).rejects.toMatchObject({
      code: 'plugin-invalid-response',
      status: 200,
    });
  });

  it.each([
    { plugins: [] },
    { ...mutation, local: undefined },
    { ...mutation, result: { ...mutation.result, generation: 0 } },
  ])('rejects malformed successful mutation data %#', async (payload) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(payload)));

    await expect(reloadPlugins()).rejects.toMatchObject({ code: 'plugin-invalid-response' });
  });

  it.each([
    [400, 'invalid-trust'],
    [403, 'forbidden-origin'],
    [404, 'plugin-management-disabled'],
    [404, 'plugin-not-found'],
    [409, 'plugin-digest-mismatch'],
    [415, 'unsupported-media-type'],
    [503, 'plugin-host-closed'],
    [500, 'plugin-storage-failed'],
  ])('decodes typed Server errors for status %s and code %s', async (status, code) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ error: { code, message: 'safe server message' } }, status),
        ),
    );

    await expect(reloadPlugins()).rejects.toMatchObject({
      code,
      message: 'safe server message',
      status,
    });
  });

  it.each([{}, { error: { code: 3, message: '<unsafe>' } }, { error: 'bad' }])(
    'uses a safe fallback for malformed error bodies %#',
    async (payload) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(payload, 500)));

      await expect(fetchPlugins()).rejects.toMatchObject({
        code: 'plugin-request-failed',
        status: 500,
      });
    },
  );

  it('uses a safe fallback for non-JSON success and error bodies', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad', { status: 200 })));
    await expect(reloadPlugins()).rejects.toMatchObject({ code: 'plugin-invalid-response' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad', { status: 500 })));
    await expect(reloadPlugins()).rejects.toMatchObject({
      code: 'plugin-request-failed',
      status: 500,
    });
  });

  it('reports an unreachable Server as a typed network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down')));

    await expect(fetchPlugins()).rejects.toBeInstanceOf(PluginApiError);
    await expect(reloadPlugins()).rejects.toMatchObject({ code: 'plugin-network', status: 0 });
  });

  it('preserves AbortError from fetch even before the signal reports aborted', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abort));

    await expect(fetchPlugins()).rejects.toBe(abort);
    await expect(reloadPlugins()).rejects.toBe(abort);
  });

  it('preserves AbortError while reading the response body', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    const response = jsonResponse(mutation);
    vi.spyOn(response, 'json').mockRejectedValue(abort);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    await expect(reloadPlugins()).rejects.toBe(abort);
  });
});
