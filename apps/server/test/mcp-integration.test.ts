import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { startServer } from '../src/main.js';
import { createSqliteMcpAuthorityStore } from '../src/mcp-authority-store.js';
import { computeDirectoryDigest } from '@weave/plugin-host';
import { getServerSessionStore } from '../src/runtime.js';
import { createSqlitePluginAuthorityDatabase } from '../src/plugin-authority-store.js';
import { createSqlitePluginTrustStore } from '../src/plugin-trust-store.js';
import { artifact, importInput } from './support/plugin-authority-fixtures.js';
import { z } from 'zod';

const headers = { 'Content-Type': 'application/json' };

function fixtureConfig(directory: string, id = 'fixture') {
  return {
    schemaVersion: 1 as const,
    id,
    label: 'Fixture',
    transport: 'stdio' as const,
    command: process.execPath,
    args: [],
    cwd: directory,
    env: {},
  };
}

function importFixture(
  authority: ReturnType<typeof createSqlitePluginAuthorityDatabase>,
  digest?: string,
) {
  const identity = artifact(digest);
  authority.commitSync(
    importInput('import-mcp-fixture', 0, {
      ...identity,
      pluginId: 'mcp-fixture',
      manifest: { ...identity.manifest, id: 'mcp-fixture' },
    }),
  );
}

describe('MCP Server composition', () => {
  it.each(['enabled', 'disabled'] as const)(
    'reserves an imported-only managed ID without creating an artifact root with ESM %s',
    async (esm) => {
      const directory = await mkdtemp(join(tmpdir(), 'weave-mcp-sticky-'));
      const filename = join(directory, 'weave.sqlite');
      const authority = createSqlitePluginAuthorityDatabase({ filename });
      const store = createSqliteMcpAuthorityStore({ filename });
      const mutate = vi.spyOn(store, 'mutate');
      let server: Awaited<ReturnType<typeof startServer>> | undefined;
      try {
        importFixture(authority);
        await authority.close();
        server = await startServer(0, {
          dataDirectory: directory,
          environment: {},
          mcpAuthorityStore: store,
          ...(esm === 'disabled' ? { pluginsDirectory: false } : {}),
        });
        expect(server.pluginHost !== undefined).toBe(esm === 'enabled');
        const request = await fetch(`http://127.0.0.1:${server.port}/mcp/servers`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ expectedSequence: 0, config: fixtureConfig(directory) }),
        });
        expect(request.status).toBe(409);
        expect(await request.json()).toMatchObject({ error: { code: 'mcp-conflict' } });
        expect(mutate).not.toHaveBeenCalled();
        expect((await store.read()).events).toEqual([]);
        await expect(access(join(directory, 'plugins', '.weave-store'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } finally {
        await server?.stop();
        await store.close();
        await authority.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it('uses an independent override trust prefix while enforcing newly sticky IDs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'weave-mcp-override-'));
    const filename = join(directory, 'weave.sqlite');
    const local = join(directory, 'plugins', 'manual');
    const manifest = { ...artifact().manifest, id: 'mcp-fixture', contributes: {} };
    const authority = createSqlitePluginAuthorityDatabase({ filename });
    const override = createSqlitePluginTrustStore({ filename: join(directory, 'override.sqlite') });
    const store = createSqliteMcpAuthorityStore({ filename });
    const mutate = vi.spyOn(store, 'mutate');
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      await mkdir(local, { recursive: true });
      await writeFile(
        join(local, 'weave-plugin.json'),
        JSON.stringify({ schemaVersion: 1, entry: 'index.mjs', manifest }),
      );
      await writeFile(join(local, 'index.mjs'), 'export default () => ({ setup() {} });\n');
      const { digest } = await computeDirectoryDigest(local);
      const mainRecord = await authority.trust.append({ kind: 'revoked', pluginId: 'unrelated' });
      const overrideRecord = await override.append({
        kind: 'trusted',
        pluginId: 'mcp-fixture',
        digest,
        manifest,
      });
      const close = vi.spyOn(override, 'close');
      expect(overrideRecord.sequence).toBe(mainRecord.sequence);
      server = await startServer(0, {
        dataDirectory: directory,
        environment: {},
        pluginTrustStore: override,
        mcpAuthorityStore: store,
      });
      const controller = server.runtime.serverHost.controller()!;
      const plugins = () => controller.current().resources.plugins.map(({ id }) => id);
      await server.mcpManager!.configure(0, fixtureConfig(directory, 'other'));
      await server.pluginHost!.reload();
      expect(plugins()).toContain('mcp-fixture');

      importFixture(authority, digest);
      await server.pluginHost!.reload();
      expect(plugins()).not.toContain('mcp-fixture');
      await rm(local, { recursive: true });
      mutate.mockClear();
      await expect(server.mcpManager!.configure(1, fixtureConfig(directory))).rejects.toMatchObject(
        { code: 'mcp-conflict' },
      );
      expect(mutate).not.toHaveBeenCalled();
      expect((await store.read()).sequence).toBe(1);
      expect(await authority.trust.events()).toEqual([mainRecord]);
      expect(await override.events()).toEqual([overrideRecord]);
      await expect(access(join(directory, 'plugins', '.weave-store'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await server.stop();
      await server.stop();
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      await server?.stop();
      await store.close();
      await override.close();
      await authority.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reserves an ESM ID while an old generation remains pinned and releases it after draining', async () => {
    const directory = join(tmpdir(), `weave-mcp-retained-${randomUUID()}`);
    const pluginsDirectory = join(directory, 'plugins');
    const local = join(pluginsDirectory, 'existing');
    await mkdir(local, { recursive: true });
    await writeFile(
      join(local, 'weave-plugin.json'),
      JSON.stringify({
        schemaVersion: 1,
        entry: 'index.mjs',
        manifest: {
          id: 'mcp-calculator',
          name: 'Existing ESM',
          version: '1.0.0',
          apiVersion: '1.0.0',
          capabilities: ['tool'],
          contributes: { tools: [] },
          permissions: [],
        },
      }),
    );
    await writeFile(join(local, 'index.mjs'), 'export default () => ({ setup() {} });\n');
    let started!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const toolRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = await startServer(0, {
      dataDirectory: directory,
      pluginsDirectory,
      environment: {},
      plugins: [
        {
          manifest: {
            id: 'pinner',
            name: 'Pinner',
            version: '1.0.0',
            apiVersion: '1.0.0',
            capabilities: ['tool'],
          },
          setup(context) {
            context.registerTool({
              name: 'pin_generation',
              description: 'Pin the test generation',
              parameters: { type: 'object' },
              inputSchema: z.object({}),
              async execute() {
                started();
                await toolRelease;
                return 'finished';
              },
            });
          },
        },
      ],
    });
    let active: Promise<void> | undefined;
    try {
      await server.pluginHost!.trust(
        'mcp-calculator',
        (await computeDirectoryDigest(local)).digest,
      );
      await getServerSessionStore(server.runtime).append('pinned-esm', [
        { type: 'session.created', payload: { title: 'Pin ESM' } },
      ]);
      active = (async () => {
        for await (const event of server.runtime.serverHost.controller()!.runner.run({
          sessionId: 'pinned-esm',
          provider: 'mock',
          model: 'test',
          permissionMode: 'yolo',
          userMessage: {
            role: 'user',
            content: [{ type: 'text', text: '/tool pin_generation {}' }],
          },
        }))
          void event;
      })();
      await toolStarted;
      await rm(pluginsDirectory, { recursive: true });
      await server.pluginHost!.reload();
      const config = {
        schemaVersion: 1 as const,
        id: 'calculator',
        label: 'Calculator',
        transport: 'stdio' as const,
        command: process.execPath,
        args: [],
        cwd: directory,
        env: {},
      };
      await expect(server.mcpManager!.configure(0, config)).rejects.toMatchObject({
        code: 'mcp-conflict',
      });
      release();
      await active;
      await expect
        .poll(async () => {
          try {
            return (await server.mcpManager!.configure(0, config)).authoritySequence;
          } catch (error) {
            return (error as { code: string }).code;
          }
        })
        .toBe(1);
    } finally {
      release();
      await active;
      await server.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('closes owned authority once after connection disposal and still closes it on bind failure', async () => {
    const directory = join(tmpdir(), `weave-mcp-owned-${randomUUID()}`);
    await mkdir(directory, { recursive: true });
    const store = createSqliteMcpAuthorityStore({ filename: join(directory, 'authority.sqlite') });
    const order: string[] = [];
    const close = vi.fn(async () => {
      order.push('store');
      await store.close();
    });
    const server = await startServer(0, {
      dataDirectory: directory,
      pluginsDirectory: false,
      environment: {},
      mcpAuthorityStore: { ...store, close },
      mcpConnect: async () => ({
        tools: [],
        stderrBytes: 0,
        validateInput: () => ({ valid: true }),
        callTool: async () => ({ content: [] }),
        close: async () => {
          order.push('connection');
        },
      }),
    });
    try {
      const created = await server.mcpManager!.configure(0, {
        schemaVersion: 1,
        id: 'owned',
        label: 'Owned',
        transport: 'stdio',
        command: process.execPath,
        args: [],
        cwd: directory,
        env: {},
      });
      await server.mcpManager!.trust(
        'owned',
        created.authoritySequence,
        created.servers[0]!.configDigest,
      );
      await Promise.all([server.stop(), server.stop()]);
      expect(order).toEqual(['connection', 'store']);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await server.stop();
    }
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
    try {
      const address = occupied.address();
      if (address === null || typeof address === 'string') throw new Error('Expected TCP address');
      const next = createSqliteMcpAuthorityStore({ filename: join(directory, 'failed.sqlite') });
      const failedClose = vi.fn(() => next.close());
      await expect(
        startServer(address.port, {
          dataDirectory: directory,
          pluginsDirectory: false,
          environment: {},
          mcpAuthorityStore: { ...next, close: failedClose },
        }),
      ).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(failedClose).toHaveBeenCalledOnce();
    } finally {
      await new Promise<void>((resolve, reject) =>
        occupied.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('starts only after explicit trust and reloads a new complete generation', async () => {
    const directory = join(tmpdir(), `weave-mcp-launch-${randomUUID()}`);
    await mkdir(directory, { recursive: true });
    const logFile = join(directory, 'launch.jsonl');
    const fixture = fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url));
    const server = await startServer(0, {
      dataDirectory: directory,
      pluginsDirectory: false,
      environment: { TEST_MCP_TOKEN: 'private-token', MCP_UNEXPECTED: 'must-not-inherit' },
    });
    const request = async (path: string, body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      return response.json();
    };
    try {
      const created = await request('/mcp/servers', {
        expectedSequence: 0,
        config: {
          schemaVersion: 1,
          id: 'fixture',
          label: 'Fixture',
          transport: 'stdio',
          command: process.execPath,
          args: [fixture, logFile],
          cwd: directory,
          env: { MCP_EXPLICIT: { fromHostEnv: 'TEST_MCP_TOKEN' } },
        },
      });
      await expect(access(logFile)).rejects.toMatchObject({ code: 'ENOENT' });
      const trusted = await request('/mcp/servers/fixture/trust', {
        expectedSequence: created.authoritySequence,
        configDigest: created.servers[0].configDigest,
      });
      expect(trusted).toMatchObject({
        servers: [
          {
            state: 'loaded',
            enabled: true,
            active: {
              generation: trusted.generation.id,
            },
            tools: [{ name: 'echo', annotations: { readOnlyHint: true } }],
          },
        ],
      });
      expect(JSON.stringify(trusted)).not.toContain('private-token');
      expect(trusted.servers[0].tools[0]).toMatchObject({
        description: 'Echo a value [REDACTED]',
        annotations: { title: 'Token [REDACTED]' },
      });
      const cached = await (await fetch(`http://127.0.0.1:${server.port}/mcp`)).json();
      expect(JSON.stringify(cached)).not.toContain('private-token');
      expect(JSON.stringify(trusted)).not.toContain('private MCP stderr');
      const launches = (await readFile(logFile, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(launches).toEqual([{ event: 'started', explicit: 'private-token' }]);
      const reloaded = await request('/mcp/reload', {
        expectedSequence: trusted.authoritySequence,
      });
      expect(reloaded.generation.id).toBeGreaterThan(trusted.generation.id);
      expect(reloaded.authoritySequence).toBe(trusted.authoritySequence);
      expect((await readFile(logFile, 'utf8')).trim().split('\n')).toHaveLength(2);
      const plugins = await (await fetch(`http://127.0.0.1:${server.port}/plugins`)).json();
      expect(plugins.generation).toEqual(reloaded.generation);
      expect(plugins.plugins).toContainEqual(
        expect.objectContaining({ id: 'mcp-fixture', host: 'mcp', state: 'loaded' }),
      );
      expect(
        plugins.plugins.find((item: { id: string }) => item.id === 'mcp-fixture'),
      ).not.toHaveProperty('local');
    } finally {
      await server.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps MCP authority available when ESM discovery is disabled and persists safe config', async () => {
    const directory = join(tmpdir(), `weave-mcp-api-${randomUUID()}`);
    await mkdir(directory, { recursive: true });
    const databaseFile = join(directory, 'weave.sqlite');
    const config = {
      schemaVersion: 1,
      id: 'calculator',
      label: 'Calculator',
      transport: 'stdio',
      command: process.execPath,
      args: [],
      cwd: directory,
      env: { SERVICE_TOKEN: { fromHostEnv: 'TEST_MCP_TOKEN' } },
    };
    try {
      const first = await startServer(0, {
        databaseFile,
        pluginsDirectory: false,
        environment: { TEST_MCP_TOKEN: 'private-token' },
      });
      try {
        const before = await fetch(`http://127.0.0.1:${first.port}/mcp`);
        expect(before.status).toBe(200);
        expect(await before.json()).toMatchObject({
          authoritySequence: 0,
          servers: [],
          generation: { id: 1, acceptingRuns: true },
        });
        const created = await fetch(`http://127.0.0.1:${first.port}/mcp/servers`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ expectedSequence: 0, config }),
        });
        expect(created.status).toBe(200);
        const value = await created.json();
        expect(value).toMatchObject({
          authoritySequence: 1,
          servers: [{ config: { id: 'calculator' }, state: 'untrusted', enabled: false }],
          result: { decisionSequence: 1 },
        });
        expect(JSON.stringify(value)).not.toContain('private-token');
        const plugins = await (await fetch(`http://127.0.0.1:${first.port}/plugins`)).json();
        expect(plugins).not.toHaveProperty('local');
        expect(plugins.generation).toEqual(value.generation);
      } finally {
        await first.stop();
      }
      const restarted = await startServer(0, {
        databaseFile,
        pluginsDirectory: false,
        environment: {},
      });
      try {
        const value = await (await fetch(`http://127.0.0.1:${restarted.port}/mcp`)).json();
        expect(value).toMatchObject({
          authoritySequence: 1,
          servers: [{ config: { id: 'calculator' }, state: 'untrusted', enabled: false }],
        });
      } finally {
        await restarted.stop();
      }
      await expect(access(join(directory, 'plugins'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refreshes discovered untrusted ESM IDs before persisting a conflicting MCP config', async () => {
    const directory = join(tmpdir(), `weave-mcp-collision-${randomUUID()}`);
    await mkdir(directory, { recursive: true });
    const pluginsDirectory = join(directory, 'plugins');
    const server = await startServer(0, {
      dataDirectory: directory,
      pluginsDirectory,
      environment: {},
    });
    try {
      const local = join(pluginsDirectory, 'late-plugin');
      await mkdir(local, { recursive: true });
      await writeFile(
        join(local, 'weave-plugin.json'),
        JSON.stringify({
          schemaVersion: 1,
          entry: 'index.mjs',
          manifest: {
            id: 'mcp-calculator',
            name: 'Reserved local tool',
            version: '1.0.0',
            apiVersion: '1.0.0',
            capabilities: ['tool'],
            contributes: {},
            permissions: [],
          },
        }),
      );
      await writeFile(join(local, 'index.mjs'), 'export default () => ({ setup() {} });\n');
      const response = await fetch(`http://127.0.0.1:${server.port}/mcp/servers`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          expectedSequence: 0,
          config: {
            schemaVersion: 1,
            id: 'calculator',
            label: 'Calculator',
            transport: 'stdio',
            command: process.execPath,
            args: [],
            cwd: directory,
            env: {},
          },
        }),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: 'mcp-conflict' } });
      const value = await (await fetch(`http://127.0.0.1:${server.port}/mcp`)).json();
      expect(value).toMatchObject({ authoritySequence: 0, servers: [] });
    } finally {
      await server.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['registered', 'current-esm'] as const)(
    'reserves a %s plugin ID when adding MCP configuration',
    async (owner) => {
      const directory = join(tmpdir(), `weave-mcp-reserved-${randomUUID()}`);
      const pluginsDirectory = join(directory, 'plugins');
      const local = join(pluginsDirectory, 'existing');
      await mkdir(local, { recursive: true });
      const manifest = {
        id: 'mcp-calculator',
        name: 'Existing plugin',
        version: '1.0.0',
        apiVersion: '1.0.0',
        capabilities: ['tool' as const],
        contributes: { tools: [] },
        permissions: [],
      };
      await writeFile(
        join(local, 'weave-plugin.json'),
        JSON.stringify({ schemaVersion: 1, entry: 'index.mjs', manifest }),
      );
      await writeFile(join(local, 'index.mjs'), 'export default () => ({ setup() {} });\n');
      const server = await startServer(0, {
        dataDirectory: directory,
        environment: {},
        ...(owner === 'registered'
          ? { pluginsDirectory: false as const, plugins: [{ manifest, setup() {} }] }
          : { pluginsDirectory }),
      });
      try {
        if (owner === 'current-esm') {
          await server.pluginHost!.trust(manifest.id, (await computeDirectoryDigest(local)).digest);
          await rm(pluginsDirectory, { recursive: true });
        }
        const response = await fetch(`http://127.0.0.1:${server.port}/mcp/servers`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            expectedSequence: 0,
            config: {
              schemaVersion: 1,
              id: 'calculator',
              label: 'Calculator',
              transport: 'stdio',
              command: process.execPath,
              args: [],
              cwd: directory,
              env: {},
            },
          }),
        });
        expect(response.status).toBe(409);
        const value = await (await fetch(`http://127.0.0.1:${server.port}/mcp`)).json();
        expect(value).toMatchObject({ authoritySequence: 0, servers: [] });
      } finally {
        await server.stop();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
