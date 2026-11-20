import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { ServerPluginManager } from '../src/plugin-management-types.js';

const manager = (): ServerPluginManager => ({
  snapshot: () => ({
    directory: '/p',
    exists: false,
    truncated: false,
    trustSequence: 0,
    plugins: [],
    generation: { id: 1, plugins: [], acceptingRuns: true },
  }),
  reload: async () => ({
    generation: 1,
    unchanged: true,
    failed: [],
    snapshot: manager().snapshot(),
  }),
  trust: async () => ({
    generation: 1,
    unchanged: true,
    failed: [],
    snapshot: manager().snapshot(),
  }),
  revoke: async () => ({
    generation: 1,
    unchanged: true,
    failed: [],
    snapshot: manager().snapshot(),
  }),
  setEnabled: async () => ({
    generation: 1,
    unchanged: true,
    failed: [],
    snapshot: manager().snapshot(),
  }),
});
const jsonHeaders = { Host: 'localhost', 'Content-Type': 'application/json' };
function app(studioOrigin?: string) {
  return createApp({ status: 'running' } as never, {
    pluginManager: manager(),
    ...(studioOrigin === undefined ? {} : { studioOrigin }),
  });
}

describe('plugin write guard', () => {
  it.each([
    ['POST', '/plugins/reload'],
    ['POST', '/plugins/local-kit/trust'],
    ['DELETE', '/plugins/local-kit/trust'],
    ['POST', '/plugins/local-kit/enable'],
    ['POST', '/plugins/local-kit/disable'],
  ])('guards %s %s before invoking plugin management', async (method, path) => {
    const response = await app().request(path, {
      method,
      headers: { ...jsonHeaders, 'Sec-Fetch-Site': 'cross-site' },
      body: '{}',
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: 'forbidden-origin', message: expect.any(String) },
    });
  });

  it.each([
    undefined,
    'example.com',
    'user@localhost',
    'localhost.evil.test',
    'localhost, evil.test',
    'localhost/path',
    'localhost\\path',
    'localhost:bad',
    'localhost:65536',
    'localhost:',
    'localhost.',
    'LOCALHOST',
    '127.1',
    '2130706433',
    '0x7f000001',
    '127.0.0.01',
    '[0:0:0:0:0:0:0:1]',
    '[::1]@evil.test',
    'http://localhost',
  ])('rejects noncanonical Host %s', async (host) => {
    const response = await app().request('/plugins/reload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(host === undefined ? {} : { Host: host }),
      },
      body: '{}',
    });
    expect(response.status).toBe(403);
  });

  it.each(['localhost', 'localhost:4321', '127.0.0.1', '127.0.0.1:65535', '[::1]', '[::1]:4321'])(
    'accepts canonical loopback Host %s',
    async (Host) => {
      const response = await app().request('/plugins/reload', {
        method: 'POST',
        headers: { ...jsonHeaders, Host },
        body: '{}',
      });
      expect(response.status).toBe(200);
    },
  );

  it.each([
    undefined,
    'text/plain',
    'application/x-www-form-urlencoded',
    'multipart/form-data',
    'application/jsonp',
    'application/json, text/plain',
  ])('requires JSON media type instead of %s', async (contentType) => {
    const response = await app().request('/plugins/reload', {
      method: 'POST',
      headers: {
        Host: 'localhost',
        ...(contentType === undefined ? {} : { 'Content-Type': contentType }),
      },
      body: '{}',
    });
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ error: { code: 'unsupported-media-type' } });
  });

  it('accepts JSON with a charset parameter', async () => {
    const response = await app().request('/plugins/reload', {
      method: 'POST',
      headers: { ...jsonHeaders, 'Content-Type': 'Application/JSON; charset=utf-8' },
      body: '{}',
    });
    expect(response.status).toBe(200);
  });

  it.each([
    'null',
    'file://local',
    'ftp://localhost',
    'https://evil.example',
    'http://user@localhost',
    'http://localhost/',
    'http://localhost/path',
    'http://localhost?query=1',
    'http://localhost#fragment',
    'http://localhost, http://127.0.0.1',
    'http://127.1',
    'http://localhost.evil.test',
  ])('rejects invalid or remote development Origin %s', async (Origin) => {
    const response = await app().request('/plugins/reload', {
      method: 'POST',
      headers: { ...jsonHeaders, Origin },
      body: '{}',
    });
    expect(response.status).toBe(403);
  });

  it.each(['http://localhost:5173', 'https://127.0.0.1:3210', 'http://[::1]:5173'])(
    'accepts development loopback Origin %s',
    async (Origin) => {
      const response = await app().request('/plugins/reload', {
        method: 'POST',
        headers: { ...jsonHeaders, Origin },
        body: '{}',
      });
      expect(response.status).toBe(200);
    },
  );

  it('requires the exact configured Studio origin while allowing nonbrowser requests', async () => {
    for (const [Origin, status] of [
      [undefined, 200],
      ['http://localhost:5173', 200],
      ['http://localhost:5174', 403],
      ['https://localhost:5173', 403],
    ] as const) {
      const response = await app('http://localhost:5173').request('/plugins/reload', {
        method: 'POST',
        headers: { ...jsonHeaders, ...(Origin === undefined ? {} : { Origin }) },
        body: '{}',
      });
      expect(response.status).toBe(status);
    }
  });

  it('checks JSON media type before host and origin restrictions', async () => {
    const response = await app().request('/plugins/reload', {
      method: 'POST',
      headers: {
        Host: 'evil.example',
        Origin: 'https://evil.example',
        'Content-Type': 'text/plain',
      },
      body: '{}',
    });
    expect(response.status).toBe(415);
  });

  it('trims Sec-Fetch-Site before rejecting cross-site requests', async () => {
    const response = await app().request('/plugins/reload', {
      method: 'POST',
      headers: { ...jsonHeaders, 'Sec-Fetch-Site': ' cross-site ' },
      body: '{}',
    });
    expect(response.status).toBe(403);
  });

  it('does not apply the plugin write guard to catalog reads or unrelated APIs', async () => {
    expect(
      (
        await app().request('/plugins', {
          headers: { Host: 'evil.example', Origin: 'https://evil.example' },
        })
      ).status,
    ).toBe(200);
    expect((await app().request('/health', { headers: { Host: 'evil.example' } })).status).toBe(
      200,
    );
  });
});
