import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const app = (studioOrigin?: string) =>
  createApp({ status: 'running' } as never, studioOrigin === undefined ? {} : { studioOrigin });

const loopbackHost = '127.0.0.1:4317';

const reads = [
  '/projects',
  '/projects/p1/file?path=a.txt',
  '/projects/p1/tree',
  '/projects/p1/sessions',
  '/approvals',
  '/approvals/a1',
  '/settings/providers',
  '/sessions/s1',
  '/sessions/s1/skills',
] as const;

const writes = [
  ['POST', '/agent/runs/stream'],
  ['POST', '/projects'],
  ['PATCH', '/projects/p1'],
  ['POST', '/projects/p1/sessions'],
  ['POST', '/approvals/a1/approve'],
  ['POST', '/approvals/a1/deny'],
  ['POST', '/settings/providers'],
  ['PATCH', '/settings/providers/x'],
  ['DELETE', '/settings/providers/x'],
  ['PATCH', '/sessions/s1'],
  ['POST', '/sessions/s1/archive'],
  ['DELETE', '/sessions/s1'],
] as const;

const forged: readonly (readonly [string, Record<string, string>])[] = [
  ['rebinding Host', { Host: 'evil.example:4317' }],
  [
    'rebinding Host with same-origin Origin',
    { Host: 'evil.example:4317', Origin: 'http://evil.example:4317' },
  ],
  [
    'cross-site Origin',
    { Host: loopbackHost, Origin: 'http://evil.example', 'Sec-Fetch-Site': 'cross-site' },
  ],
  [
    'cross-site fetch metadata without Origin',
    { Host: loopbackHost, 'Sec-Fetch-Site': 'cross-site' },
  ],
  ['non-loopback Origin', { Host: loopbackHost, Origin: 'http://evil.example' }],
];

async function expectCode(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error: { code } });
}

describe('global local request guard', () => {
  describe.each(forged)('%s', (_name, headers) => {
    it.each(reads)('rejects GET %s', async (path) => {
      await expectCode(await app().request(path, { headers }), 403, 'local-request-forbidden');
    });

    it.each(writes)('rejects %s %s', async (method, path) => {
      await expectCode(
        await app().request(path, {
          method,
          headers: { ...headers, 'Content-Type': 'text/plain' },
          body: '{}',
        }),
        403,
        'local-request-forbidden',
      );
    });
  });

  it.each(writes)('rejects non-JSON %s %s bodies with 415', async (method, path) => {
    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded']) {
      await expectCode(
        await app().request(path, {
          method,
          headers: { Host: loopbackHost, 'Content-Type': contentType },
          body: '{}',
        }),
        415,
        'local-request-unsupported-media-type',
      );
    }
  });

  it('rejects a body without a Content-Type', async () => {
    await expectCode(
      await app().request('/projects', {
        method: 'POST',
        headers: { Host: loopbackHost, 'Content-Length': '2' },
        body: '{}',
      }),
      415,
      'local-request-unsupported-media-type',
    );
  });

  it('compares Origin exactly with the configured Studio origin', async () => {
    const configured = app('http://localhost:5173');
    await expectCode(
      await configured.request('/projects', {
        headers: { Host: loopbackHost, Origin: 'http://localhost:5174' },
      }),
      403,
      'local-request-forbidden',
    );
    const allowed = await configured.request('/projects', {
      headers: { Host: loopbackHost, Origin: 'http://localhost:5173' },
    });
    expect(allowed.status).not.toBe(403);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });

  it('does not let preflight bypass admission', async () => {
    const configured = app('http://localhost:5173');
    for (const route of ['/projects', '/settings/providers', '/approvals/a1/approve']) {
      expect(
        (
          await configured.request(route, {
            method: 'OPTIONS',
            headers: {
              Host: 'evil.example',
              Origin: 'http://localhost:5173',
              'Access-Control-Request-Method': 'POST',
            },
          })
        ).status,
      ).toBe(403);
    }
  });

  it('keeps loopback requests working', async () => {
    for (const headers of [
      { Host: loopbackHost },
      { Host: 'localhost:4317', Origin: 'http://localhost:5173' },
      { Host: '[::1]:4317', Origin: 'http://127.0.0.1:5173' },
    ]) {
      for (const path of reads) {
        const response = await app().request(path, { headers });
        expect(response.status, path).not.toBe(403);
        expect(response.status, path).not.toBe(415);
      }
    }
    for (const [method, path] of writes) {
      const response = await app().request(path, {
        method,
        headers: { Host: loopbackHost, 'Content-Type': 'application/json; charset=utf-8' },
        body: '{}',
      });
      const body = (await response.json().catch(() => null)) as {
        error?: { code?: string };
      } | null;
      expect(body?.error?.code ?? '', `${method} ${path}`).not.toMatch(/^local-request-/);
      expect(response.status, `${method} ${path}`).not.toBe(415);
    }
    // Header-less in-memory requests fall back to the URL host, and bodyless
    // writes need no Content-Type.
    expect((await app().request('/projects')).status).not.toBe(403);
    expect((await app().request('/approvals/a1/approve', { method: 'POST' })).status).not.toBe(415);
  });

  it('never trusts the URL host over an explicit non-loopback Host header', async () => {
    await expectCode(
      await app().request('http://localhost/projects', { headers: { Host: 'evil.example' } }),
      403,
      'local-request-forbidden',
    );
  });

  it('leaves /health open for liveness probes', async () => {
    const response = await app().request('/health', { headers: { Host: 'evil.example' } });
    expect(response.status).toBe(200);
  });
});
