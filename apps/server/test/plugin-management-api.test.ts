import { describe, expect, it, vi } from 'vitest';
import { PluginHostError, type PluginHostSnapshot, type ReloadResult } from '@weave/plugin-host';
import { PluginTrustStoreError } from '../src/plugin-trust-store.js';
import { createApp } from '../src/app.js';
import type { ServerPluginManager } from '../src/plugin-management-types.js';

const snapshot = (generation = 3): PluginHostSnapshot => ({
  directory: '/plugins',
  exists: false,
  truncated: false,
  trustSequence: 0,
  plugins: [],
  generation: { id: generation, plugins: [], acceptingRuns: true },
});
const result = (): ReloadResult => ({
  generation: 3,
  unchanged: true,
  failed: [],
  snapshot: snapshot(),
});
function manager(overrides: Partial<ServerPluginManager> = {}): ServerPluginManager {
  return {
    snapshot,
    reload: async () => result(),
    trust: async () => result(),
    revoke: async () => result(),
    setEnabled: async () => result(),
    ...overrides,
  };
}
const headers = { Host: 'localhost:4312', 'Content-Type': 'application/json' };
const appFor = (pluginManager?: ServerPluginManager) =>
  createApp({ status: 'running' } as never, { pluginManager });

describe('local plugin HTTP management', () => {
  it('adds a public cached local summary only when management is enabled', async () => {
    const without = await appFor().request('/plugins');
    expect(await without.json()).toEqual({ plugins: [] });
    const response = await appFor(manager()).request('/plugins');
    expect(await response.json()).toEqual({
      plugins: [],
      local: {
        directory: '/plugins',
        exists: false,
        truncated: false,
        trustSequence: 0,
        generation: { id: 3, plugins: [], acceptingRuns: true },
      },
    });
  });

  it.each([
    ['POST', '/plugins/reload', undefined, 'reload'],
    ['POST', '/plugins/local-kit/trust', JSON.stringify({ digest: 'a'.repeat(64) }), 'trust'],
    ['DELETE', '/plugins/local-kit/trust?immediate=true', '{}', 'revoke'],
    ['POST', '/plugins/local-kit/enable', '{}', 'enable'],
    ['POST', '/plugins/local-kit/disable?immediate=false', '', 'disable'],
  ])(
    'executes %s %s through the manager and projects a public result',
    async (method, path, body, operation) => {
      const operations: unknown[] = [];
      const changed = manager({
        reload: async () => {
          operations.push('reload');
          return result();
        },
        trust: async (id, digest) => {
          operations.push(['trust', id, digest]);
          return result();
        },
        revoke: async (id, options) => {
          operations.push(['revoke', id, options]);
          return result();
        },
        setEnabled: async (id, enabled, options) => {
          operations.push([enabled ? 'enable' : 'disable', id, options]);
          return result();
        },
      });
      const response = await appFor(changed).request(path, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
      });
      expect(response.status).toBe(200);
      const value = await response.json();
      expect(value).toEqual({
        plugins: [],
        local: {
          directory: '/plugins',
          exists: false,
          truncated: false,
          trustSequence: 0,
          generation: { id: 3, plugins: [], acceptingRuns: true },
        },
        result: { generation: 3, unchanged: true, failed: [] },
      });
      expect(operations).toEqual([
        operation === 'reload'
          ? 'reload'
          : operation === 'trust'
            ? ['trust', 'local-kit', 'a'.repeat(64)]
            : operation === 'revoke'
              ? ['revoke', 'local-kit', { immediate: true }]
              : [
                  operation,
                  'local-kit',
                  operation === 'disable' ? { immediate: false } : undefined,
                ],
      ]);
    },
  );

  it('reads the current snapshot after a mutation instead of using its older snapshot', async () => {
    const current = manager({ snapshot: () => snapshot(4) });
    const response = await appFor(current).request('/plugins/reload', { method: 'POST', headers });
    expect(await response.json()).toMatchObject({
      local: { generation: { id: 4 } },
      result: { generation: 3 },
    });
  });

  it('pairs current cached state and current catalog after publication rather than a stale result snapshot', async () => {
    const manifest = {
      id: 'local-kit',
      name: 'Local Kit',
      version: '1.0.0',
      apiVersion: '1.0.0',
      capabilities: ['tool'] as const,
    };
    let published = false;
    const current: PluginHostSnapshot = {
      directory: '/plugins',
      exists: true,
      truncated: false,
      trustSequence: 1,
      plugins: [
        {
          id: 'local-kit',
          state: 'loaded',
          candidate: {
            id: 'local-kit',
            status: 'ready',
            directory: '/plugins/local-kit',
            entry: '/plugins/local-kit/index.mjs',
            digest: 'a'.repeat(64),
            manifest,
          },
          trusted: undefined,
          active: { generation: 4, digest: 'a'.repeat(64), manifest },
        },
      ],
      generation: {
        id: 4,
        plugins: [{ id: 'local-kit', digest: 'a'.repeat(64), manifest }],
        acceptingRuns: true,
      },
    };
    const response = await createApp({ status: 'running' } as never, {
      pluginManager: manager({
        snapshot: () => (published ? current : snapshot()),
        reload: async () => {
          published = true;
          return result();
        },
      }),
      pluginCatalog: () =>
        published
          ? [
              {
                id: 'local-kit',
                name: 'Local Kit',
                version: '1.0.0',
                origin: 'kernel',
                state: 'loaded',
                host: 'in-process',
                capabilities: ['tool'],
                provides: {
                  tools: ['published-tool'],
                  providers: [],
                  promptSections: [],
                  events: [],
                  commands: [],
                  hooks: [],
                  services: [],
                },
              },
            ]
          : [],
    }).request('/plugins/reload', { method: 'POST', headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      plugins: [
        {
          id: 'local-kit',
          origin: 'local',
          state: 'loaded',
          provides: { tools: ['published-tool'] },
        },
      ],
      local: { generation: { id: 4 } },
      result: { generation: 3 },
    });
  });

  it('validates positive generation numbers instead of serializing invalid host output', async () => {
    const response = await appFor(manager({ snapshot: () => snapshot(0) })).request('/plugins');
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: 'plugin-management-failed', message: expect.any(String) },
    });
  });

  it.each([
    ['/plugins/reload', '{', 400],
    ['/plugins/reload?immediate=true', '{}', 400],
    ['/plugins/local-kit/trust?immediate=false', JSON.stringify({ digest: 'a'.repeat(64) }), 400],
    ['/plugins/local-kit/enable?immediate=false', '{}', 400],
    ['/plugins/reload', '{"extra":true}', 400],
    ['/plugins/local-kit/trust', '{}', 400],
    ['/plugins/local-kit/trust', '{"digest":"bad"}', 400],
    ['/plugins/local-kit/trust', '{"digest":"' + 'a'.repeat(64) + '","extra":true}', 400],
    ['/plugins/local-kit/disable?immediate=1', '{}', 400],
    ['/plugins/local-kit/disable?immediate=true&immediate=false', '{}', 400],
    ['/plugins/UPPER/enable', '{}', 400],
  ])('rejects invalid mutation %s with body %s', async (path, body, status) => {
    const response = await appFor(manager()).request(path, { method: 'POST', headers, body });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code: 'plugin-invalid-request' } });
  });

  it('reports management disabled with a JSON 404', async () => {
    const response = await appFor().request('/plugins/reload', { method: 'POST', headers });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'plugin-management-disabled' } });
  });

  it.each([
    ['POST', '/plugins/sticky/trust', '{}'],
    ['POST', '/plugins/sticky/enable', '{"extra": true}'],
    ['POST', '/plugins/sticky/disable?immediate=1', '{}'],
    ['DELETE', '/plugins/sticky/trust?immediate=true&immediate=false', '{}'],
    ['POST', '/plugins/INVALID/enable', '{}'],
  ])(
    'validates disabled legacy %s %s before consulting sticky authority',
    async (method, path, body) => {
      const assertManualPluginIdSync = vi.fn();
      const app = createApp({ status: 'running' } as never, { assertManualPluginIdSync });
      const response = await app.request(path, { method, headers, body });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'plugin-invalid-request' } });
      expect(assertManualPluginIdSync).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['plugin-not-found', 404],
    ['plugin-not-trusted', 409],
    ['plugin-not-loadable', 409],
    ['plugin-digest-mismatch', 409],
    ['plugin-generation-blocked', 409],
    ['plugin-reload-failed', 500],
    ['plugin-host-disposed', 503],
    ['plugin-unreadable', 500],
  ] as const)('maps %s without exposing internal causes', async (code, status) => {
    const response = await appFor(
      manager({
        reload: async () => {
          throw new PluginHostError(code, 'Public error', { cause: new Error('private stack') });
        },
      }),
    ).request('/plugins/reload', { method: 'POST', headers });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code, message: 'Public error' } });
  });

  it.each([
    ['plugin-trust-invalid', 400],
    ['plugin-trust-closed', 503],
    ['plugin-trust-storage', 500],
    ['plugin-trust-protocol', 500],
  ] as const)('maps real trust-store error %s', async (code, status) => {
    const response = await appFor(
      manager({
        reload: async () => {
          throw new PluginTrustStoreError(code, 'Public storage failure', {
            cause: new Error('private connection'),
          });
        },
      }),
    ).request('/plugins/reload', { method: 'POST', headers });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code, message: 'Public storage failure' } });
  });

  it('does not treat arbitrary thrown objects as public host errors', async () => {
    const response = await appFor(
      manager({
        reload: async () => {
          throw { code: 'plugin-not-found', message: 'private exception', cause: 'private cause' };
        },
      }),
    ).request('/plugins/reload', { method: 'POST', headers });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: 'plugin-management-failed', message: expect.any(String) },
    });
  });

  it('sanitizes unknown failures', async () => {
    const response = await appFor(
      manager({
        reload: async () => {
          throw new Error('private database connection');
        },
      }),
    ).request('/plugins/reload', { method: 'POST', headers });
    expect(response.status).toBe(500);
    const value = await response.json();
    expect(value).toEqual({
      error: { code: 'plugin-management-failed', message: expect.any(String) },
    });
    expect(JSON.stringify(value)).not.toContain('private database');
  });

  it('returns rebuild failures as successful operation results without internal fields', async () => {
    const response = await appFor(
      manager({
        reload: async () => ({
          ...result(),
          error: { code: 'plugin-reload-failed', message: 'Assembly failed' },
          failed: [
            { id: 'local-kit', error: { code: 'plugin-load-failed', message: 'Setup failed' } },
          ],
        }),
      }),
    ).request('/plugins/reload', { method: 'POST', headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: {
        error: { code: 'plugin-reload-failed', message: 'Assembly failed' },
        failed: [
          { id: 'local-kit', error: { code: 'plugin-load-failed', message: 'Setup failed' } },
        ],
      },
    });
  });
});
