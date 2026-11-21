// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureMcpServer,
  disableMcpServer,
  enableMcpServer,
  fetchMcpCatalog,
  McpApiError,
  reloadMcpServers,
  removeMcpServer,
  revokeMcpServer,
  trustMcpServer,
  updateMcpServer,
} from '../src/features/mcp/mcp-api.js';
import {
  pluginCatalogSchema,
  pluginMutationResponseSchema,
} from '../src/features/plugins/plugin-types.js';
import { mcpServerConfigSchema } from '../src/features/mcp/mcp-types.js';

const config = {
  schemaVersion: 1 as const,
  id: 'notes',
  label: 'Notes',
  transport: 'stdio' as const,
  command: '/node',
  args: ['server.mjs', ''],
  cwd: '/workspace',
  env: { TOKEN: { fromHostEnv: 'HOST_TOKEN' } },
};
const generation = {
  id: 4,
  acceptingRuns: false,
  blocked: { code: 'plugin-generation-blocked', message: 'blocked' },
};
const snapshot = {
  authoritySequence: 7,
  generation,
  servers: [
    {
      config,
      configDigest: 'a'.repeat(64),
      enabled: false,
      state: 'untrusted',
      stale: false,
      drainingGenerations: [],
      tools: [],
    },
  ],
};
const mutation = {
  ...snapshot,
  result: {
    decisionSequence: 7,
    applied: false,
    unchanged: false,
    failed: [],
    error: { code: 'mcp-rebuild-failed', message: 'rebuild failed' },
  },
};
function reply(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('MCP browser HTTP client', () => {
  it('retains top-level generation on plugin reads and mutation parsing', () => {
    expect(pluginCatalogSchema.parse({ plugins: [], generation }).generation).toEqual(generation);
    const local = {
      directory: '/plugins',
      exists: true,
      truncated: false,
      trustSequence: 0,
      generation: { ...generation, plugins: [] },
    };
    expect(
      pluginMutationResponseSchema.parse({
        plugins: [],
        local,
        generation,
        result: { generation: 4, unchanged: false, failed: [] },
      }).generation,
    ).toEqual(generation);
  });
  it.each([
    [
      'configure',
      '/mcp/servers',
      'POST',
      { expectedSequence: 7, config },
      () => configureMcpServer(7, config),
    ],
    [
      'update',
      '/mcp/servers/notes',
      'PUT',
      { expectedSequence: 7, config },
      () => updateMcpServer('notes', 7, config),
    ],
    [
      'trust',
      '/mcp/servers/notes/trust',
      'POST',
      { expectedSequence: 7, configDigest: 'a'.repeat(64) },
      () => trustMcpServer('notes', 7, 'a'.repeat(64)),
    ],
    [
      'enable',
      '/mcp/servers/notes/enable',
      'POST',
      { expectedSequence: 7, configDigest: 'a'.repeat(64) },
      () => enableMcpServer('notes', 7, 'a'.repeat(64)),
    ],
    [
      'disable',
      '/mcp/servers/notes/disable',
      'POST',
      { expectedSequence: 7, immediate: true },
      () => disableMcpServer('notes', 7, { immediate: true }),
    ],
    [
      'revoke',
      '/mcp/servers/notes/revoke',
      'POST',
      { expectedSequence: 7 },
      () => revokeMcpServer('notes', 7),
    ],
    [
      'remove',
      '/mcp/servers/notes/remove',
      'POST',
      { expectedSequence: 7, immediate: false },
      () => removeMcpServer('notes', 7, { immediate: false }),
    ],
    ['reload', '/mcp/reload', 'POST', { expectedSequence: 7 }, () => reloadMcpServers(7)],
  ] as const)(
    'sends exact %s request and retains durable partial result',
    async (_kind, path, method, body, call) => {
      const fetchMock = vi.fn(async () => reply(mutation));
      vi.stubGlobal('fetch', fetchMock);
      expect(await call()).toEqual(mutation);
      expect(fetchMock).toHaveBeenCalledWith(
        path,
        expect.objectContaining({
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    },
  );
  it('uses desktop runtime base and preserves own JSON and environment keys', async () => {
    Object.defineProperty(window, 'weaveDesktop', {
      configurable: true,
      value: { isDesktop: true, serverUrl: 'http://127.0.0.1:9999/' },
    });
    const env = JSON.parse('{"__proto__":{"fromHostEnv":"TOKEN"}}');
    const inputSchema = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string"}}}',
    );
    const fetchMock = vi.fn(async () =>
      reply({
        ...snapshot,
        servers: [
          {
            ...snapshot.servers[0],
            config: { ...config, env },
            tools: [
              {
                name: 'echo',
                toolName: 'mcp_notes_echo_hash',
                description: '',
                inputSchema,
                annotations: JSON.parse('{"__proto__":"metadata"}'),
              },
            ],
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await fetchMcpCatalog();
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:9999/mcp',
        expect.objectContaining({ method: 'GET' }),
      );
      expect(Object.keys(result.servers[0]!.config.env)).toEqual(['__proto__']);
      expect(Object.keys(result.servers[0]!.tools[0]!.inputSchema.properties as object)).toEqual([
        '__proto__',
      ]);
      expect(Object.keys(result.servers[0]!.tools[0]!.annotations!)).toEqual(['__proto__']);
      expect(Object.isFrozen(result.servers[0]!.config.env)).toBe(true);
    } finally {
      Reflect.deleteProperty(window, 'weaveDesktop');
    }
  });
  it('preserves typed 409 and only explicit disabled 404 errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        reply({ error: { code: 'mcp-conflict', message: 'authority changed' } }, 409),
      ),
    );
    await expect(trustMcpServer('notes', 7, 'a'.repeat(64))).rejects.toMatchObject({
      code: 'mcp-conflict',
      status: 409,
    });
  });
  it('retains and freezes deep legal annotation JSON without a schema-depth limit', async () => {
    const annotations: Record<string, unknown> = {};
    let leaf = annotations;
    for (let depth = 0; depth < 256; depth++) {
      const next: Record<string, unknown> = {};
      leaf.child = next;
      leaf = next;
    }
    leaf.value = 'metadata';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        reply({
          ...snapshot,
          servers: [
            {
              ...snapshot.servers[0],
              tools: [
                {
                  name: 'echo',
                  toolName: 'mcp_notes_echo_hash',
                  description: '',
                  inputSchema: {},
                  annotations,
                },
              ],
            },
          ],
        }),
      ),
    );
    const result = await fetchMcpCatalog();
    let parsed = result.servers[0]!.tools[0]!.annotations!;
    for (let depth = 0; depth < 256; depth++) {
      expect(Object.isFrozen(parsed)).toBe(true);
      parsed = parsed.child as Readonly<Record<string, unknown>>;
    }
    expect(parsed.value).toBe('metadata');
    expect(Object.isFrozen(parsed)).toBe(true);
  });
  it('retains wide legal annotation arrays within the server catalog bound', async () => {
    const annotations = { values: Array.from({ length: 125_000 }, () => 0) };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        reply({
          ...snapshot,
          servers: [
            {
              ...snapshot.servers[0],
              tools: [
                {
                  name: 'echo',
                  toolName: 'mcp_notes_echo_hash',
                  description: '',
                  inputSchema: {},
                  annotations,
                },
              ],
            },
          ],
        }),
      ),
    );
    const result = await fetchMcpCatalog();
    const values = result.servers[0]!.tools[0]!.annotations!.values;
    expect(values).toHaveLength(125_000);
    expect(Object.isFrozen(values)).toBe(true);
  });
  it.each([
    ['command', { command: '/node\0' }],
    ['cwd', { cwd: '/workspace\0' }],
    ['argument', { args: ['server\0.mjs'] }],
  ])('rejects NUL in %s before a form can submit invalid launch text', (_field, input) => {
    expect(mcpServerConfigSchema.safeParse({ ...config, ...input }).success).toBe(false);
  });
  it('rejects malformed successful DTOs and safely classifies network failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply({ ...snapshot, generation: { id: 1 } })),
    );
    await expect(fetchMcpCatalog()).rejects.toMatchObject({
      code: 'mcp-invalid-response',
      status: 200,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('private network text');
      }),
    );
    await expect(fetchMcpCatalog()).rejects.toMatchObject({ code: 'mcp-network', status: 0 });
    await expect(fetchMcpCatalog()).rejects.toBeInstanceOf(McpApiError);
  });
  it('passes AbortError through without wrapping it', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw abort;
      }),
    );
    await expect(fetchMcpCatalog()).rejects.toBe(abort);
  });
  it('classifies invalid JSON and preserves aborts while reading the response body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('invalid JSON', { status: 200 })),
    );
    await expect(fetchMcpCatalog()).rejects.toMatchObject({
      code: 'mcp-invalid-response',
      status: 200,
    });
    const abort = new DOMException('body aborted', 'AbortError');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw abort;
        },
      })),
    );
    await expect(fetchMcpCatalog()).rejects.toBe(abort);
  });
});
