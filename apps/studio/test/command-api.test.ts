// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommandApiError, fetchCommands } from '../src/features/commands/command-api.js';

const command = {
  name: 'recap',
  title: '回顾进展',
  prompt: '请回顾目前的进展：\n$ARGUMENTS',
  pluginId: 'recap-kit',
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

describe('Command API client', () => {
  it('parses the command list at the browser boundary', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ commands: [command] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchCommands()).resolves.toEqual([command]);

    expect(fetchMock).toHaveBeenCalledWith('/commands', { method: 'GET' });
  });

  it('keeps the description the Server sends', async () => {
    const described = { ...command, description: '总结目前为止做了什么' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ commands: [described] })));

    await expect(fetchCommands()).resolves.toEqual([described]);
  });

  it('calls the desktop Server when the bridge is present', async () => {
    window.weaveDesktop = { isDesktop: true, serverUrl: 'http://127.0.0.1:46321/' };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ commands: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchCommands();

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:46321/commands', { method: 'GET' });
  });

  it('passes the abort signal on', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ commands: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchCommands(controller.signal);

    expect(fetchMock).toHaveBeenCalledWith('/commands', {
      method: 'GET',
      signal: controller.signal,
    });
  });

  it('rejects a response that is not a command list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ commands: [{ name: 1 }] })));

    await expect(fetchCommands()).rejects.toMatchObject({ code: 'command-invalid-response' });
  });

  it('reports a failed request and an unreachable Server as typed errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 404)));
    await expect(fetchCommands()).rejects.toMatchObject({
      code: 'command-request-failed',
      status: 404,
    });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down')));
    await expect(fetchCommands()).rejects.toBeInstanceOf(CommandApiError);
    await expect(fetchCommands()).rejects.toMatchObject({ code: 'command-network', status: 0 });
  });

  it('lets an aborted request surface as the abort it is', async () => {
    const controller = new AbortController();
    const abort = new DOMException('aborted', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abort));
    controller.abort();

    await expect(fetchCommands(controller.signal)).rejects.toBe(abort);
  });
});
