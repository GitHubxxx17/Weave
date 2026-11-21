import { ExplicitLocalAuthorityError } from '@weave/plugin-host';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { McpAuthorityError } from '../src/mcp-errors.js';
import type {
  McpManagementSnapshot,
  McpMutationResult,
  ServerMcpManager,
} from '../src/mcp-management-types.js';

const config = {
  schemaVersion: 1 as const,
  id: 'calculator',
  label: 'Calculator',
  transport: 'stdio' as const,
  command: '/usr/bin/node',
  args: ['/workspace/server.mjs'],
  cwd: '/workspace',
  env: { SERVICE_TOKEN: { fromHostEnv: 'CALCULATOR_TOKEN' } },
};
const digest = 'a'.repeat(64);
const snapshot = (): McpManagementSnapshot => ({
  authoritySequence: 4,
  generation: { id: 3, acceptingRuns: true },
  servers: [
    {
      config,
      configDigest: digest,
      enabled: false,
      state: 'untrusted',
      stale: false,
      drainingGenerations: [],
      tools: [],
    },
  ],
});
const result = (): McpMutationResult => ({
  ...snapshot(),
  result: { decisionSequence: 4, applied: true, unchanged: false, failed: [] },
});
function manager(overrides: Partial<ServerMcpManager> = {}): ServerMcpManager {
  return {
    snapshot,
    configure: async () => result(),
    update: async () => result(),
    trust: async () => result(),
    enable: async () => result(),
    disable: async () => result(),
    revoke: async () => result(),
    remove: async () => result(),
    reload: async () => result(),
    ...overrides,
  };
}
const headers = { Host: 'localhost:4317', 'Content-Type': 'application/json' };
const appFor = (mcpManager?: ServerMcpManager, studioOrigin?: string) =>
  createApp({ status: 'running' } as never, { mcpManager, studioOrigin });

describe('MCP HTTP management', () => {
  it('reads a cached snapshot without invoking a mutation and strips private fields', async () => {
    const reload = vi.fn(async () => result());
    const response = await appFor(
      manager({
        snapshot: () => ({ ...snapshot(), resolvedEnv: { SERVICE_TOKEN: 'private-token' } }),
        reload,
      }),
    ).request('/mcp', { headers: { Host: 'remote.example' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(snapshot());
    expect(reload).not.toHaveBeenCalled();
  });

  it.each([
    ['POST', '/mcp/servers', { expectedSequence: 4, config }, 'configure', [4, config]],
    [
      'PUT',
      '/mcp/servers/calculator',
      { expectedSequence: 4, config },
      'update',
      ['calculator', 4, config],
    ],
    [
      'POST',
      '/mcp/servers/calculator/trust',
      { expectedSequence: 4, configDigest: digest },
      'trust',
      ['calculator', 4, digest],
    ],
    [
      'POST',
      '/mcp/servers/calculator/enable',
      { expectedSequence: 4, configDigest: digest },
      'enable',
      ['calculator', 4, digest],
    ],
    [
      'POST',
      '/mcp/servers/calculator/disable',
      { expectedSequence: 4, immediate: true },
      'disable',
      ['calculator', 4, { immediate: true }],
    ],
    [
      'POST',
      '/mcp/servers/calculator/revoke',
      { expectedSequence: 4 },
      'revoke',
      ['calculator', 4, undefined],
    ],
    [
      'POST',
      '/mcp/servers/calculator/remove',
      { expectedSequence: 4, immediate: false },
      'remove',
      ['calculator', 4, { immediate: false }],
    ],
    ['POST', '/mcp/reload', { expectedSequence: 4 }, 'reload', [4]],
  ] as const)(
    'executes %s %s through the narrow manager',
    async (method, path, body, operation, args) => {
      const called = vi.fn(async () => result());
      const response = await appFor(manager({ [operation]: called })).request(path, {
        method,
        headers,
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      expect(called).toHaveBeenCalledExactlyOnceWith(...args);
      expect(await response.json()).toEqual(result());
    },
  );

  it.each([
    ['POST', '/mcp/reload', '{}'],
    ['POST', '/mcp/reload', '{'],
    ['POST', '/mcp/reload', 'null'],
    ['POST', '/mcp/reload', '[]'],
    ['POST', '/mcp/reload', '{"expectedSequence":-1}'],
    ['POST', '/mcp/reload', '{"expectedSequence":1.5}'],
    ['POST', '/mcp/reload', '{"expectedSequence":9007199254740992}'],
    ['POST', '/mcp/reload', '{"expectedSequence":4,"immediate":true}'],
    ['POST', '/mcp/servers/calculator/trust', '{"expectedSequence":4,"configDigest":"wrong"}'],
    ['POST', '/mcp/servers/calculator/disable', '{"expectedSequence":4,"immediate":"true"}'],
    [
      'POST',
      '/mcp/servers/INVALID/enable',
      JSON.stringify({ expectedSequence: 4, configDigest: digest }),
    ],
    [
      'POST',
      `/mcp/servers/${'a'.repeat(25)}/enable`,
      JSON.stringify({ expectedSequence: 4, configDigest: digest }),
    ],
    ['PUT', '/mcp/servers/other', JSON.stringify({ expectedSequence: 4, config })],
    [
      'POST',
      '/mcp/servers',
      JSON.stringify({ expectedSequence: 4, config: { ...config, rawEnv: { TOKEN: 'private' } } }),
    ],
  ])('rejects invalid %s %s before mutation', async (method, path, body) => {
    const called = vi.fn(async () => result());
    const response = await appFor(
      manager({
        configure: called,
        update: called,
        reload: called,
        trust: called,
        enable: called,
        disable: called,
      }),
    ).request(path, { method, headers, body });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'mcp-invalid' } });
    expect(called).not.toHaveBeenCalled();
  });

  it.each([
    ['POST', '/mcp/servers'],
    ['PUT', '/mcp/servers/calculator'],
    ['POST', '/mcp/servers/calculator/trust'],
    ['POST', '/mcp/servers/calculator/enable'],
    ['POST', '/mcp/servers/calculator/disable'],
    ['POST', '/mcp/servers/calculator/revoke'],
    ['POST', '/mcp/servers/calculator/remove'],
    ['POST', '/mcp/reload'],
    ['POST', '/mcp'],
  ])('guards %s %s before management', async (method, path) => {
    const called = vi.fn(async () => result());
    const response = await appFor(manager({ reload: called, configure: called })).request(path, {
      method,
      headers: { ...headers, 'Sec-Fetch-Site': 'cross-site' },
      body: '{}',
    });
    expect(response.status).toBe(403);
    expect(called).not.toHaveBeenCalled();
  });

  it('requires JSON before checking origin and accepts the exact configured Studio origin', async () => {
    const app = appFor(manager(), 'http://localhost:5173');
    const invalid = await app.request('/mcp/reload', {
      method: 'POST',
      headers: { Host: 'remote.example', 'Content-Type': 'text/plain' },
      body: '{}',
    });
    expect(invalid.status).toBe(415);
    const allowed = await app.request('/mcp/reload', {
      method: 'POST',
      headers: { ...headers, Origin: 'http://localhost:5173' },
      body: JSON.stringify({ expectedSequence: 4 }),
    });
    expect(allowed.status).toBe(200);
    const denied = await app.request('/mcp/reload', {
      method: 'POST',
      headers: { ...headers, Origin: 'http://localhost:5174' },
      body: JSON.stringify({ expectedSequence: 4 }),
    });
    expect(denied.status).toBe(403);
  });

  it('supports PUT in the configured Studio CORS preflight', async () => {
    const response = await appFor(manager(), 'http://localhost:5173').request(
      '/mcp/servers/calculator',
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:5173',
          'Access-Control-Request-Method': 'PUT',
          'Access-Control-Request-Headers': 'Content-Type',
        },
      },
    );
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    expect(response.headers.get('Access-Control-Allow-Methods')?.split(',')).toContain('PUT');
  });

  it('returns persisted decisions with rebuild failures as HTTP 200', async () => {
    const failure = {
      ...result(),
      generation: { id: 3, acceptingRuns: false },
      result: {
        decisionSequence: 4,
        applied: false,
        unchanged: false,
        failed: [
          { id: 'calculator', error: { code: 'mcp-start-failed', message: 'MCP startup failed' } },
        ],
      },
    };
    const response = await appFor(manager({ reload: async () => failure })).request('/mcp/reload', {
      method: 'POST',
      headers,
      body: '{"expectedSequence":4}',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(failure);
  });

  it('sanitizes unknown failures and has a stable disabled response', async () => {
    const response = await appFor(
      manager({
        reload: async () => {
          throw new Error('private database');
        },
      }),
    ).request('/mcp/reload', { method: 'POST', headers, body: '{"expectedSequence":4}' });
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('private database');
    const disabled = await appFor().request('/mcp');
    expect(disabled.status).toBe(404);
    expect(await disabled.json()).toMatchObject({ error: { code: 'mcp-management-disabled' } });
  });

  it.each([
    ['mcp-invalid', 400],
    ['mcp-not-found', 404],
    ['mcp-conflict', 409],
    ['mcp-authority-protocol', 500],
    ['mcp-authority-storage', 500],
    ['mcp-closed', 500],
  ] as const)(
    'maps safe domain code %s without exposing arbitrary messages',
    async (code, status) => {
      const response = await appFor(
        manager({
          reload: async () => {
            throw new McpAuthorityError(code, 'private environment value');
          },
        }),
      ).request('/mcp/reload', { method: 'POST', headers, body: '{"expectedSequence":4}' });
      expect(response.status).toBe(status);
      const value = await response.json();
      expect(value).toMatchObject({ error: { code } });
      expect(JSON.stringify(value)).not.toContain('private environment value');
    },
  );

  it('does not accept thrown objects as trusted public errors', async () => {
    const response = await appFor(
      manager({
        reload: async () => {
          throw { code: 'mcp-not-found', message: 'private environment value' };
        },
      }),
    ).request('/mcp/reload', { method: 'POST', headers, body: '{"expectedSequence":4}' });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: 'mcp-management-failed' } });
  });

  it.each([
    [
      'an untyped marker cause',
      () =>
        new ExplicitLocalAuthorityError({
          code: 'mcp-authority-storage',
          message: 'private untyped authority failure',
        }),
    ],
    [
      'a nested marker cause',
      (cause: McpAuthorityError) =>
        new ExplicitLocalAuthorityError(new Error('private nested authority failure', { cause })),
    ],
    [
      'an aggregate marker cause',
      (cause: McpAuthorityError) =>
        new ExplicitLocalAuthorityError(
          new AggregateError([cause], 'private aggregate authority failure', { cause }),
        ),
    ],
    [
      'an unrelated wrapper',
      (cause: McpAuthorityError) => new Error('private wrapped authority failure', { cause }),
    ],
  ] as const)('returns a generic response for %s', async (_name, wrap) => {
    const response = await appFor(
      manager({
        reload: async () => {
          throw wrap(
            new McpAuthorityError('mcp-authority-storage', 'private MCP authority failure'),
          );
        },
      }),
    ).request('/mcp/reload', { method: 'POST', headers, body: '{"expectedSequence":4}' });

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toContain('private');
    expect(JSON.parse(body)).toEqual({
      error: { code: 'mcp-management-failed', message: 'MCP management is unavailable.' },
    });
  });

  it('preserves own JSON Schema keys in the public metadata projection', async () => {
    const inputSchema = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string"}}}',
    ) as Record<string, unknown>;
    const response = await appFor(
      manager({
        snapshot: () => ({
          ...snapshot(),
          servers: [
            {
              ...snapshot().servers[0]!,
              tools: [
                {
                  name: 'calculate',
                  toolName: 'mcp_calculator_calculate_hash',
                  description: 'Calculate',
                  inputSchema,
                },
              ],
            },
          ],
        }),
      }),
    ).request('/mcp');
    expect(response.status).toBe(200);
    const value = await response.json();
    expect(Object.hasOwn(value.servers[0].tools[0].inputSchema.properties, '__proto__')).toBe(true);
  });
});
