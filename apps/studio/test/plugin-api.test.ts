// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { PluginApiError, fetchPlugins } from '../src/features/plugins/plugin-api.js';

const plugin = {
  id: 'server-echo',
  name: 'Server Echo',
  version: '1.2.3',
  origin: 'registered',
  host: 'in-process',
  capabilities: ['tool'],
  provides: { tools: ['echo'], providers: [], promptSections: [], services: [] },
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
  it('parses the plugin list at the browser boundary', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ plugins: [plugin] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchPlugins()).resolves.toEqual([plugin]);

    expect(fetchMock).toHaveBeenCalledWith('/plugins', { method: 'GET' });
  });

  it('keeps the optional manifest fields the Server sends', async () => {
    const detailed = {
      ...plugin,
      description: '回显文本',
      engines: { weave: '>=1.0.0' },
      contributes: { tools: ['echo'] },
      permissions: ['workspace:read', 'service:weave.session.store'],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ plugins: [detailed] })));

    await expect(fetchPlugins()).resolves.toEqual([detailed]);
  });

  it('shows values it does not know yet instead of rejecting the list', async () => {
    const future = { ...plugin, origin: 'marketplace', host: 'wasm', capabilities: ['command'] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ plugins: [future] })));

    await expect(fetchPlugins()).resolves.toEqual([future]);
  });

  it('calls the desktop Server when the bridge is present', async () => {
    window.weaveDesktop = { isDesktop: true, serverUrl: 'http://127.0.0.1:46321/' };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ plugins: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchPlugins();

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:46321/plugins', { method: 'GET' });
  });

  it('passes the abort signal on', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ plugins: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchPlugins(controller.signal);

    expect(fetchMock).toHaveBeenCalledWith('/plugins', {
      method: 'GET',
      signal: controller.signal,
    });
  });

  it('rejects a response that is not a plugin list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ plugins: [{ id: 1 }] })));

    await expect(fetchPlugins()).rejects.toMatchObject({ code: 'plugin-invalid-response' });
  });

  it('reports a failed request and an unreachable Server as typed errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 500)));
    await expect(fetchPlugins()).rejects.toMatchObject({
      code: 'plugin-request-failed',
      status: 500,
    });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down')));
    await expect(fetchPlugins()).rejects.toBeInstanceOf(PluginApiError);
    await expect(fetchPlugins()).rejects.toMatchObject({ code: 'plugin-network', status: 0 });
  });

  it('lets an aborted request surface as the abort it is', async () => {
    const controller = new AbortController();
    const abort = new DOMException('aborted', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abort));
    controller.abort();

    await expect(fetchPlugins(controller.signal)).rejects.toBe(abort);
  });
});
