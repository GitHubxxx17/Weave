import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { accessTokenCookie } from '../src/access-token.js';
import { createTrustedHost, isTrustedAuthority } from '../src/local-authority.js';
import { readHostSetting, resolveListenConfig } from '../src/listen-config.js';
import { studioContentSecurityPolicy } from '../src/studio-static.js';
import { startServer } from '../src/main.js';

const runtime = { status: 'running' } as never;
const token = 'test-token-0123456789abcdef';
const lanHost = '192.168.1.20:4317';
const lanOrigin = `http://${lanHost}`;
let directory: string;
let outside: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'weave-studio-'));
  outside = await mkdtemp(join(tmpdir(), 'weave-outside-'));
  await mkdir(join(directory, 'assets'));
  await writeFile(join(directory, 'index.html'), '<!doctype html><title>Weave</title>');
  await writeFile(join(directory, 'assets', 'app-abc.js'), 'console.log(1)');
  await writeFile(join(directory, 'assets', 'app-abc.css'), 'body{}');
  await writeFile(join(outside, 'secret.txt'), 'secret');
  await symlink(join(outside, 'secret.txt'), join(directory, 'leak.txt'));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const local = { Host: '127.0.0.1:4317' };

describe('Studio static hosting', () => {
  const app = () => createApp(runtime, { studioDirectory: directory });

  it('serves index.html at the root with CSP and nosniff', async () => {
    const response = await app().request('/', { headers: local });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<title>Weave</title>');
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('content-security-policy')).toBe(studioContentSecurityPolicy);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('no-cache');
  });

  it('serves hashed assets with their content type and long caching', async () => {
    const script = await app().request('/assets/app-abc.js', { headers: local });
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(script.headers.get('cache-control')).toContain('immutable');
    expect(script.headers.get('x-content-type-options')).toBe('nosniff');
    const style = await app().request('/assets/app-abc.css', { headers: local });
    expect(style.headers.get('content-type')).toBe('text/css; charset=utf-8');
  });

  it('falls back to index.html for unknown client routes', async () => {
    const response = await app().request('/projects/p1/sessions/s1/view', { headers: local });
    // `/projects/...` has no GET route of this shape, so the SPA fallback answers.
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<title>Weave</title>');
  });

  it('returns 404 for a missing asset instead of index.html', async () => {
    const response = await app().request('/assets/missing.js', { headers: local });
    expect(response.status).toBe(404);
    expect(response.headers.get('content-security-policy')).toBe(studioContentSecurityPolicy);
  });

  it('lets API routes win over the SPA fallback', async () => {
    const response = await app().request('/health', { headers: local });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', runtime: 'running' });
  });

  it('does not serve files outside the directory', async () => {
    for (const path of ['/leak.txt', '/..%2f..%2fetc%2fpasswd.txt', '/%2e%2e/secret.txt']) {
      const response = await app().request(path, { headers: local });
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('secret');
    }
  });

  it('rejects malformed escapes and keeps the local Host guard in front', async () => {
    expect((await app().request('/%E0%A4%A', { headers: local })).status).toBe(400);
    const rebinding = await app().request('/', { headers: { Host: 'evil.example:4317' } });
    expect(rebinding.status).toBe(403);
  });

  it('does not host Studio unless a directory is configured', async () => {
    const response = await createApp(runtime).request('/', { headers: local });
    expect(response.status).toBe(404);
  });
});

describe('access token on a non-loopback listener', () => {
  const app = () =>
    createApp(runtime, {
      studioDirectory: directory,
      trustedHost: createTrustedHost('192.168.1.20', 4317),
      accessToken: token,
    });
  const lan = { Host: lanHost };

  it('rejects requests without a token', async () => {
    for (const path of ['/', '/projects', '/assets/app-abc.js']) {
      const response = await app().request(path, { headers: lan });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: 'access-token-required' } });
    }
  });

  it('exchanges ?token= for an HttpOnly Strict cookie and redirects without the token', async () => {
    const response = await app().request(`/?token=${token}&x=1`, { headers: lan });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/?x=1');
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${accessTokenCookie}=${token}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\//);
  });

  it('serves pages and API with the cookie', async () => {
    const headers = { ...lan, Cookie: `${accessTokenCookie}=${token}` };
    const page = await app().request('/', { headers });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<title>Weave</title>');
    const health = await app().request('/projects', { headers });
    expect(health.status).not.toBe(401);
    expect(health.status).not.toBe(403);
  });

  it('accepts a Bearer token for the API', async () => {
    const response = await app().request('/projects', {
      headers: { ...lan, Authorization: `Bearer ${token}` },
    });
    expect(response.status).not.toBe(401);
    expect(response.status).not.toBe(403);
  });

  it('rejects wrong tokens in every position', async () => {
    const wrong = 'wrong-token-0123456789abcdef';
    for (const request of [
      app().request(`/?token=${wrong}`, { headers: lan }),
      app().request('/projects', { headers: { ...lan, Authorization: `Bearer ${wrong}` } }),
      app().request('/projects', { headers: { ...lan, Cookie: `${accessTokenCookie}=${wrong}` } }),
      app().request('/projects', { headers: { ...lan, Authorization: 'Bearer ' } }),
      app().request('/projects', { headers: { ...lan, Authorization: token } }),
    ]) {
      expect((await request).status).toBe(401);
    }
  });

  it('keeps /health open for liveness probes', async () => {
    expect((await app().request('/health', { headers: lan })).status).toBe(200);
  });

  it('admits the configured Host and same-origin Origin but not other authorities', async () => {
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const allowed = await app().request('/projects', {
      headers: { ...headers, Host: lanHost, Origin: lanOrigin },
    });
    expect(allowed.status).not.toBe(403);
    for (const forged of [
      { Host: 'evil.example:4317' },
      { Host: '192.168.1.20:9999' },
      { Host: lanHost, Origin: 'http://evil.example' },
      { Host: lanHost, Origin: 'http://192.168.1.21:4317' },
      { Host: lanHost, 'Sec-Fetch-Site': 'cross-site' },
    ]) {
      const response = await app().request('/projects', { headers: { ...headers, ...forged } });
      expect(response.status).toBe(403);
    }
  });

  it('applies the configured Host to the path guards too', async () => {
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Host: lanHost,
      Origin: lanOrigin,
    };
    for (const [method, path] of [
      ['POST', '/sessions/s1/executions'],
      ['POST', '/projects/p1/retrieval/search'],
      ['POST', '/projects/p1/sessions/s1/undo'],
      ['POST', '/plugins/p1/enable'],
      ['POST', '/mcp/servers'],
    ] as const) {
      const response = await app().request(path, { method, headers, body: '{}' });
      expect(response.status, `${method} ${path}`).not.toBe(403);
    }
  });

  it('trusts any hostname on the listening port for wildcard listeners', () => {
    const trusted = createTrustedHost('0.0.0.0', 4317);
    expect(isTrustedAuthority('192.168.1.20:4317', trusted)).toBe(true);
    expect(isTrustedAuthority('laptop.local:4317', trusted)).toBe(true);
    expect(isTrustedAuthority('laptop.local:4318', trusted)).toBe(false);
    expect(isTrustedAuthority('laptop.local', trusted)).toBe(false);
    expect(isTrustedAuthority('evil.example@x:4317', trusted)).toBe(false);
  });
});

describe('loopback listener', () => {
  it('needs no token and keeps the existing guard behavior', async () => {
    const app = createApp(runtime, { studioDirectory: directory });
    expect((await app.request('/', { headers: local })).status).toBe(200);
    expect((await app.request('/projects', { headers: local })).status).not.toBe(401);
    expect((await app.request('/projects', { headers: { Host: lanHost } })).status).toBe(403);
    const crossOrigin = await app.request('/projects', {
      headers: { ...local, Origin: 'http://evil.example' },
    });
    expect(crossOrigin.status).toBe(403);
  });

  it('does not generate a token for loopback addresses', () => {
    for (const host of [undefined, '127.0.0.1', 'localhost', '::1']) {
      expect(resolveListenConfig({ host, environment: {} })).toMatchObject({ exposed: false });
      expect(resolveListenConfig({ host, environment: {} }).accessToken).toBeUndefined();
    }
  });
});

describe('listen configuration', () => {
  it('generates a 32-byte base64url token for non-loopback hosts', () => {
    const config = resolveListenConfig({ host: '0.0.0.0', environment: {} });
    expect(config.exposed).toBe(true);
    expect(config.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(resolveListenConfig({ host: '0.0.0.0', environment: {} }).accessToken).not.toBe(
      config.accessToken,
    );
  });

  it('uses WEAVE_ACCESS_TOKEN and rejects malformed values without echoing them', () => {
    expect(
      resolveListenConfig({ host: '0.0.0.0', environment: { WEAVE_ACCESS_TOKEN: token } })
        .accessToken,
    ).toBe(token);
    expect(() =>
      resolveListenConfig({ host: '0.0.0.0', environment: { WEAVE_ACCESS_TOKEN: 'short' } }),
    ).toThrow(/WEAVE_ACCESS_TOKEN/);
  });

  it('reads --host and WEAVE_HOST', () => {
    expect(readHostSetting(['--host', '0.0.0.0'], {})).toBe('0.0.0.0');
    expect(readHostSetting(['--host=10.0.0.5'], { WEAVE_HOST: '0.0.0.0' })).toBe('10.0.0.5');
    expect(readHostSetting([], { WEAVE_HOST: '10.0.0.6' })).toBe('10.0.0.6');
    expect(readHostSetting([], {})).toBeUndefined();
    expect(() => readHostSetting(['--host'], {})).toThrow(/--host/);
  });

  it('rejects a malformed host', () => {
    expect(() => resolveListenConfig({ host: 'a b' })).toThrow();
  });
});

describe('startServer with a non-loopback host', () => {
  it('requires the token, announces the URL and hosts Studio', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'weave-hosting-data-'));
    const announced: string[] = [];
    const server = await startServer(0, {
      dataDirectory,
      environment: {},
      host: '0.0.0.0',
      accessToken: token,
      studioDirectory: directory,
      announce: (line) => announced.push(line),
    });
    try {
      expect(server.accessToken).toBe(token);
      expect(announced).toHaveLength(1);
      expect(announced[0]).toMatch(
        new RegExp(`^Weave Studio \\(LAN\\): http://[^/]+:${server.port}/\\?token=${token}$`),
      );
      const base = `http://127.0.0.1:${server.port}`;
      expect((await fetch(`${base}/`)).status).toBe(401);
      const page = await fetch(`${base}/`, { headers: { Authorization: `Bearer ${token}` } });
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('<title>Weave</title>');
      expect((await fetch(`${base}/health`)).status).toBe(200);
    } finally {
      await server.stop();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it('keeps the default loopback listener tokenless', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'weave-hosting-data-'));
    const announced: string[] = [];
    const server = await startServer(0, {
      dataDirectory,
      environment: {},
      studioDirectory: directory,
      announce: (line) => announced.push(line),
    });
    try {
      expect(server.accessToken).toBeUndefined();
      expect(announced).toEqual([]);
      const response = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-security-policy')).toBe(studioContentSecurityPolicy);
    } finally {
      await server.stop();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });
});
