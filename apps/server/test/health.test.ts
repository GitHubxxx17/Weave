import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createServer } from 'node:http';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInMemorySessionEventStore, type SessionEventStore } from '@weave/session';
import type { WeavePlugin } from '@weave/plugin';
import { createInMemoryProjectStore, type ProjectStore } from '@weave/workspace';
import { createTemporaryDatabaseFile, reservePort } from './persistence-fixture.js';
import { createRuntime } from '@weave/runtime';
import { createApp } from '../src/app.js';
import {
  approvalBrokerService,
  createServerAgentRunner,
  createServerRuntime,
  sessionEventStoreService,
} from '../src/runtime.js';
import { startServer } from '../src/main.js';
import { createSqliteMcpAuthorityStore } from '../src/mcp-authority-store.js';
import { openOwnedPluginArtifactStore } from '../src/owned-plugin-artifact-store.js';
import { createSqlitePluginAuthorityDatabase } from '../src/plugin-authority-store.js';
import type { ProviderSecretCodec } from '../src/provider-secret-codec.js';
import type { ProviderSettingsStore } from '../src/provider-settings-store.js';
import { openExecutionStream, runExecutionToLegacyResponse } from './execution-http-fixture.js';

vi.mock(import('../src/owned-plugin-artifact-store.js'), async (original) => {
  const actual = await original();
  return { ...actual, openOwnedPluginArtifactStore: vi.fn(actual.openOwnedPluginArtifactStore) };
});

describe('GET /health', () => {
  it('returns running runtime health', async () => {
    const runtime = createRuntime();
    await runtime.start();

    const response = await createApp(runtime).request('/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      runtime: 'running',
    });

    await runtime.stop();
  });

  it('assembles a Session Event Store into the server Runtime', async () => {
    const runtime = createServerRuntime();
    await runtime.start();

    const store = runtime.get(sessionEventStoreService);
    await store.append('session-1', [{ type: 'session.created', payload: { title: 'Demo' } }]);

    expect((await store.read('session-1')).map((event) => event.sequence)).toEqual([1]);

    await runtime.stop();

    await expect(store.read('session-1')).rejects.toMatchObject({
      code: 'session-store-closed',
    });
  });

  it('creates an isolated Approval Broker for each server Runtime', async () => {
    const first = createServerRuntime();
    const second = createServerRuntime();
    await first.start();
    await second.start();

    const firstBroker = first.get(approvalBrokerService);
    const secondBroker = second.get(approvalBrokerService);
    const decision = firstBroker.request({
      toolCallId: 'call-1',
      toolName: 'write_file',
      operation: 'workspace.write_file',
      summary: '写入测试文件',
      risk: 'high',
      inputSummary: { path: 'test.txt', bytes: 1, overwrite: false },
    });

    expect(firstBroker).not.toBe(secondBroker);
    expect(firstBroker.list()).toHaveLength(1);
    expect(secondBroker.list()).toHaveLength(0);

    firstBroker.cancel(firstBroker.list()[0]!.approvalId);
    await expect(decision).rejects.toMatchObject({ code: 'approval-cancelled' });
    await first.stop();
    await second.stop();
  });

  it('assembles an Agent Runner from the running Runtime services', async () => {
    const runtime = createServerRuntime();
    await runtime.start();

    expect(await createServerAgentRunner(runtime)).toMatchObject({
      run: expect.any(Function),
    });

    await runtime.stop();
  });

  it('returns an unavailable response before runtime starts', async () => {
    const runtime = createRuntime();
    const response = await createApp(runtime).request('/health');

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: 'unavailable',
      runtime: 'created',
    });
  });

  it('allows requests from the configured Studio origin only', async () => {
    const runtime = createRuntime();
    await runtime.start();

    const app = createApp(runtime, {
      studioOrigin: 'http://127.0.0.1:5173',
    });
    const allowedResponse = await app.request('/health', {
      headers: { Origin: 'http://127.0.0.1:5173' },
    });
    const rejectedResponse = await app.request('/health', {
      headers: { Origin: 'https://untrusted.example' },
    });

    expect(allowedResponse.headers.get('Access-Control-Allow-Origin')).toBe(
      'http://127.0.0.1:5173',
    );
    expect(rejectedResponse.headers.get('Access-Control-Allow-Origin')).toBeNull();

    await runtime.stop();
  });
});

describe('startServer', () => {
  it('drains an owned facade through quiescence and the running admin operation before cancelling the turn', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'weave-owned-drain-'));
    const options = { dataDirectory, environment: {} };
    const mcpStore = createSqliteMcpAuthorityStore({
      filename: join(dataDirectory, 'weave.sqlite'),
    });
    const quiescing = Promise.withResolvers<void>();
    const quiesceGate = Promise.withResolvers<void>();
    const adminReading = Promise.withResolvers<void>();
    const adminGate = Promise.withResolvers<void>();
    const actual = await vi.importActual<typeof import('../src/owned-plugin-artifact-store.js')>(
      '../src/owned-plugin-artifact-store.js',
    );
    const quiesce = vi.fn();
    const close = vi.fn();
    const dispose = vi.fn();
    vi.mocked(openOwnedPluginArtifactStore).mockImplementationOnce(async (input) => {
      const owned = await actual.openOwnedPluginArtifactStore(input);
      return {
        ...owned,
        close: close.mockImplementation(owned.close),
        quiesce: quiesce.mockImplementation(async () => {
          await owned.quiesce();
          quiescing.resolve();
          await quiesceGate.promise;
        }),
      };
    });
    const baseStore = createInMemorySessionEventStore();
    const statuses: string[] = [];
    let statusesAtClose: readonly string[] | undefined;
    const sessionStore: SessionEventStore = {
      ...baseStore,
      async append(id, events) {
        for (const event of events) {
          if (event.type === 'turn.completed') statuses.push(event.payload.status);
        }
        return baseStore.append(id, events);
      },
      async close() {
        statusesAtClose = [...statuses];
        await baseStore.close();
      },
    };
    let started: Awaited<ReturnType<typeof startServer>> | undefined;
    let active: Promise<unknown> | undefined;
    let admin: Promise<unknown> | undefined;
    let unsubscribe: (() => void) | undefined;
    try {
      started = await startServer(0, {
        ...options,
        managedPluginStore: { initialBinding: 'allow-unbound' },
        mcpAuthorityStore: mcpStore,
        sessionStoreFactory: () => sessionStore,
        plugins: [
          {
            manifest: {
              id: 'owned-drain-fixture',
              name: 'Owned drain fixture',
              version: '1.0.0',
              apiVersion: '1.0.0',
              capabilities: ['tool'],
            },
            setup(context) {
              context.registerTool({
                name: 'owned_protected',
                description: 'Wait for approval',
                parameters: { type: 'object' },
                inputSchema: z.object({}),
                approval: {
                  operation: 'test.protected',
                  risk: 'high',
                  summarize: () => ({ summary: 'Protected', inputSummary: {} }),
                },
                execute: () => 'approved',
              });
            },
            dispose,
          },
        ],
      });
      const { pluginHost, mcpManager, runtime, stop } = started;
      const broker = runtime.get(approvalBrokerService);
      const pendingApproval = Promise.withResolvers<void>();
      unsubscribe = broker.subscribe((event) => {
        if (event.request.status === 'pending') pendingApproval.resolve();
      });
      const runner = runtime.serverHost.controller()!.runner;
      const sessionId = 'owned-drain';
      await sessionStore.append(sessionId, [
        { type: 'session.created', payload: { title: 'Owned drain' } },
      ]);
      const run = async (id: string) => {
        for await (const event of runner.run({
          sessionId: id,
          provider: 'mock',
          model: 'test',
          userMessage: {
            role: 'user',
            content: [{ type: 'text', text: '/tool owned_protected {}' }],
          },
        }))
          void event;
      };
      active = run(sessionId).catch((error: unknown) => error);
      await pendingApproval.promise;
      const originalRead = mcpStore.read;
      vi.spyOn(mcpStore, 'read').mockImplementationOnce(async (input) => {
        adminReading.resolve();
        await adminGate.promise;
        return originalRead(input);
      });
      admin = mcpManager!.reload(0).catch((error: unknown) => error);
      await adminReading.promise;

      expect(pluginHost?.dispose).toBe(stop);
      const stopping = pluginHost!.dispose();
      expect(stop()).toBe(stopping);
      await quiescing.promise;
      await expect(mcpManager!.reload(0)).rejects.toMatchObject({ code: 'plugin-host-disposed' });
      await expect(run('other-session')).rejects.toMatchObject({ code: 'plugin-host-disposed' });
      expect(broker.list()[0]?.status).toBe('pending');
      expect(statusesAtClose).toBeUndefined();
      expect(close).not.toHaveBeenCalled();

      quiesceGate.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(broker.list()[0]?.status).toBe('pending');
      expect(dispose).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();

      adminGate.resolve();
      await expect(admin).resolves.toMatchObject({ code: 'plugin-host-disposed' });
      await active;
      await stopping;
      expect(stop()).toBe(stopping);
      expect(broker.list()[0]?.status).toBe('cancelled');
      expect(statusesAtClose).toEqual(['cancelled']);
      expect(dispose).toHaveBeenCalledOnce();
      expect(quiesce).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      const restarted = await startServer(0, options);
      await restarted.stop();
    } finally {
      quiesceGate.resolve();
      adminGate.resolve();
      unsubscribe?.();
      await started?.stop();
      await admin;
      await active;
      await mcpStore.close();
      await rm(dataDirectory, { recursive: true, force: true });
      vi.mocked(openOwnedPluginArtifactStore).mockReset();
    }
  });

  it('keeps HTTP listening when an unowned local facade is disposed', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'weave-manual-dispose-'));
    const started = await startServer(0, { dataDirectory, environment: {} });
    try {
      expect(started.pluginHost?.dispose).not.toBe(started.stop);
      await started.pluginHost!.dispose();
      await expect(started.pluginHost!.reload()).rejects.toMatchObject({
        code: 'plugin-host-disposed',
      });
      expect((await fetch(`http://127.0.0.1:${started.port}/health`)).status).toBe(200);
    } finally {
      await started.stop();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it('releases the real lease after an occupied port rejects startup', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'weave-owned-bind-failure-'));
    const options = { dataDirectory, environment: {} };
    const occupied = createServer().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => occupied.once('listening', resolve));
    try {
      const address = occupied.address();
      if (address === null || typeof address === 'string')
        throw new Error('Expected a TCP address');
      await expect(
        startServer(address.port, {
          ...options,
          managedPluginStore: { initialBinding: 'allow-unbound' },
        }),
      ).rejects.toMatchObject({ code: 'EADDRINUSE' });
      const authority = createSqlitePluginAuthorityDatabase({
        filename: join(dataDirectory, 'weave.sqlite'),
      });
      try {
        expect(authority.readStartupAuthoritySync().registration).not.toBeNull();
      } finally {
        await authority.close();
      }
      const restarted = await startServer(0, options);
      try {
        expect(restarted.pluginHost?.dispose).toBe(restarted.stop);
      } finally {
        await restarted.stop();
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        occupied.close((error) => (error === undefined ? resolve() : reject(error))),
      );
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it('restores saved Provider configuration after Server restart', async () => {
    const database = createTemporaryDatabaseFile();
    const secretCodec: ProviderSecretCodec = {
      isAvailable: () => true,
      encrypt: (value) => `encrypted:${value}`,
      decrypt: (value) => value.replace(/^encrypted:/, ''),
    };
    const input = {
      id: 'deepseek',
      label: 'DeepSeek',
      type: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'deepseek-secret',
      defaultModel: 'deepseek-chat',
      makeDefault: true,
    };

    try {
      const first = await startServer(0, {
        databaseFile: database.filename,
        providerSecretCodec: secretCodec,
        environment: {},
      });
      const createdResponse = await fetch(`http://127.0.0.1:${first.port}/settings/providers`, {
        method: 'POST',
        body: JSON.stringify(input),
        headers: { 'content-type': 'application/json' },
      });
      expect(createdResponse.status).toBe(201);
      await expect(createdResponse.json()).resolves.toMatchObject({
        provider: { id: 'deepseek', hasApiKey: true },
      });
      await first.stop();

      const second = await startServer(0, {
        databaseFile: database.filename,
        providerSecretCodec: secretCodec,
        environment: {},
      });
      const settingsResponse = await fetch(`http://127.0.0.1:${second.port}/settings/providers`);

      expect(settingsResponse.status).toBe(200);
      await expect(settingsResponse.json()).resolves.toEqual(
        expect.objectContaining({
          defaultProvider: 'deepseek',
          canManage: true,
          providers: expect.arrayContaining([
            expect.objectContaining({ id: 'deepseek', hasApiKey: true }),
          ]),
        }),
      );
      await second.stop();
    } finally {
      await database.cleanup();
    }
  });

  it('closes the injected Provider Settings Store once during shutdown', async () => {
    const database = createTemporaryDatabaseFile();
    let closeCount = 0;
    const providerSettingsStore: ProviderSettingsStore = {
      async list() {
        return [];
      },
      async get() {
        return undefined;
      },
      async create() {},
      async update() {},
      async delete() {},
      async close() {
        closeCount += 1;
      },
    };
    const secretCodec: ProviderSecretCodec = {
      isAvailable: () => true,
      encrypt: (value) => value,
      decrypt: (value) => value,
    };

    try {
      const server = await startServer(0, {
        databaseFile: database.filename,
        providerSettingsStore,
        providerSecretCodec: secretCodec,
        environment: {},
      });

      await Promise.all([server.stop(), server.stop()]);

      expect(closeCount).toBe(1);
    } finally {
      await database.cleanup();
    }
  });

  it('drains an open Agent SSE waiting for Approval before closing durable stores', async () => {
    const database = createTemporaryDatabaseFile();
    const baseStore = createInMemorySessionEventStore();
    let closed = false;
    const terminalStatuses: string[] = [];
    let statusesAtClose: readonly string[] = [];
    const sessionStore: SessionEventStore = {
      ...baseStore,
      async append(id, events) {
        if (closed) throw new Error('store closed before terminal append');
        for (const event of events) {
          if (event.type === 'turn.completed') terminalStatuses.push(event.payload.status);
        }
        return baseStore.append(id, events);
      },
      async close() {
        statusesAtClose = [...terminalStatuses];
        closed = true;
        await baseStore.close();
      },
    };
    const projectStore = createInMemoryProjectStore();
    const project = await projectStore.createProject({ name: 'Shutdown', folderName: 'shutdown' });
    await baseStore.append('shutdown-session', [
      { type: 'session.created', payload: { title: 'Shutdown' } },
    ]);
    await projectStore.attachSession(project.id, 'shutdown-session');
    const server = await startServer(0, {
      databaseFile: database.filename,
      projectStore,
      sessionStoreFactory: () => sessionStore,
      environment: {},
      plugins: [
        {
          manifest: {
            id: 'approval-test',
            name: 'Approval Test',
            version: '1.0.0',
            apiVersion: '1.0.0',
            capabilities: ['tool'],
          },
          setup(context) {
            context.registerTool({
              name: 'protected',
              description: 'Protected',
              parameters: { type: 'object' },
              inputSchema: z.object({}),
              approval: {
                operation: 'test.protected',
                risk: 'high',
                summarize: () => ({ summary: 'Protected', inputSummary: {} }),
              },
              execute: () => 'done',
            });
          },
        },
      ],
    });
    const broker = server.runtime.get(approvalBrokerService);
    let unsubscribe = () => {};
    const pendingApproval = new Promise<void>((resolve) => {
      unsubscribe = broker.subscribe((event) => {
        if (event.request.status === 'pending') resolve();
      });
    });
    let response: Response | undefined;
    const approvalsResponse = await fetch(`http://127.0.0.1:${server.port}/approvals/stream`);
    expect(approvalsResponse.status).toBe(200);
    const approvalReader = approvalsResponse.body!.getReader();
    expect((await approvalReader.read()).done).toBe(false);
    try {
      ({ response } = await openExecutionStream(server, {
        sessionId: 'shutdown-session',
        provider: 'mock',
        model: 'test',
        userMessage: { role: 'user', content: [{ type: 'text', text: '/tool protected {}' }] },
      }));
      expect(response.status).toBe(200);
      await pendingApproval;
      const body = response.text();
      await Promise.all([server.stop(), server.stop()]);
      // Shutdown may close the HTTP stream immediately after durable
      // cancellation has been recorded, so the final frame is transport
      // dependent. The lifecycle assertions below are the contract boundary.
      await body;
      expect(broker.list()[0]?.status).toBe('cancelled');
      expect(terminalStatuses).toEqual(['cancelled']);
      expect(statusesAtClose).toEqual(['cancelled']);
      expect(closed).toBe(true);
      try {
        while (!(await approvalReader.read()).done) {
          /* drain buffered frames */
        }
      } catch {
        /* shutdown closed the Approval SSE socket */
      }
    } finally {
      await approvalReader.cancel().catch(() => undefined);
      unsubscribe();
      await response?.body?.cancel().catch(() => undefined);
      await server.stop();
      await database.cleanup();
    }
  }, 5000);

  it('returns the actual port when started with port zero', async () => {
    const database = createTemporaryDatabaseFile();

    try {
      const result = await startServer(0, {
        databaseFile: database.filename,
      });

      expect(result.port).toBeGreaterThan(0);
      expect(result.server.listening).toBe(true);

      await result.stop();
    } finally {
      await database.cleanup();
    }
  });

  it('uses WEAVE_DATA_DIR when no explicit database file is provided', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'weave-server-data-'));

    try {
      const result = await startServer(0, {
        environment: { WEAVE_DATA_DIR: dataDirectory },
      });

      expect(result.port).toBeGreaterThan(0);
      await expect(access(join(dataDirectory, 'weave.sqlite'))).resolves.toBeUndefined();

      await result.stop();
    } finally {
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it('continues all stop cleanup steps and reports the first cleanup error', async () => {
    const database = createTemporaryDatabaseFile();
    const cleanupCalls: string[] = [];
    const baseProjectStore = createInMemoryProjectStore();
    const projectStore: ProjectStore = {
      ...baseProjectStore,
      async close(): Promise<void> {
        cleanupCalls.push('project-store');
        throw new Error('project store close failed');
      },
    };
    const baseSessionStore = createInMemorySessionEventStore();
    const sessionStore: SessionEventStore = {
      ...baseSessionStore,
      async close(): Promise<void> {
        cleanupCalls.push('runtime');
        throw new Error('runtime stop failed');
      },
    };
    const plugin: WeavePlugin = {
      manifest: {
        id: 'cleanup-failure-plugin',
        name: 'Cleanup Failure Plugin',
        version: '1.0.0',
        apiVersion: '1.0.0',
        capabilities: ['tool'],
      },
      setup: () => undefined,
      dispose: () => {
        cleanupCalls.push('plugin');
        throw new Error('plugin dispose failed');
      },
    };

    try {
      const result = await startServer(0, {
        databaseFile: database.filename,
        projectStore,
        sessionStoreFactory: () => sessionStore,
        plugins: [plugin],
      });

      await expect(result.stop()).rejects.toMatchObject({
        code: 'plugin-dispose-failed',
      });
      expect(cleanupCalls).toEqual(['plugin', 'runtime', 'project-store']);
      expect(result.server.listening).toBe(false);
      expect(result.runtime.status).toBe('stopped');
    } finally {
      await database.cleanup();
    }
  });

  it('removes signal listeners after every start and stop cycle', async () => {
    const database = createTemporaryDatabaseFile();
    const initialSigintListeners = process.listenerCount('SIGINT');
    const initialSigtermListeners = process.listenerCount('SIGTERM');

    try {
      for (let cycle = 0; cycle < 2; cycle += 1) {
        const result = await startServer(0, {
          databaseFile: database.filename,
        });

        expect(process.listenerCount('SIGINT')).toBe(initialSigintListeners + 1);
        expect(process.listenerCount('SIGTERM')).toBe(initialSigtermListeners + 1);

        await result.stop();

        expect(process.listenerCount('SIGINT')).toBe(initialSigintListeners);
        expect(process.listenerCount('SIGTERM')).toBe(initialSigtermListeners);
      }
    } finally {
      await database.cleanup();
    }
  });

  it('waits for listening before resolving and stops its server and runtime', async () => {
    const reservation = createServer().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => {
      reservation.once('listening', resolve);
    });
    const address = reservation.address();
    if (address === null || typeof address === 'string') {
      reservation.close();
      throw new Error('Expected an address for the server test');
    }
    await new Promise<void>((resolve, reject) => {
      reservation.close((error) => (error === undefined ? resolve() : reject(error)));
    });

    const database = createTemporaryDatabaseFile();
    try {
      const result = await startServer(address.port, { databaseFile: database.filename });

      expect(result.server.listening).toBe(true);
      expect(result.runtime.status).toBe('running');
      const approvalsResponse = await fetch(`http://127.0.0.1:${address.port}/approvals`);
      expect(approvalsResponse.status).toBe(200);
      expect(await approvalsResponse.json()).toEqual({ approvals: [] });

      await result.stop();

      expect(result.server.listening).toBe(false);
      expect(result.runtime.status).toBe('stopped');
      await result.stop();
    } finally {
      await database.cleanup();
    }
  });

  it('persists Projects, Sessions, lifecycle state, and messages across restart', async () => {
    const database = createTemporaryDatabaseFile();
    const firstPort = await reservePort();

    try {
      const first = await startServer(firstPort, { databaseFile: database.filename });
      const projectResponse = await fetch(`http://127.0.0.1:${firstPort}/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Weave', folderName: 'weave' }),
      });
      const project = (await projectResponse.json()) as { id: string };
      const sessionResponse = await fetch(
        `http://127.0.0.1:${firstPort}/projects/${project.id}/sessions`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: '可恢复会话' }),
        },
      );
      const session = (await sessionResponse.json()) as { id: string };
      const agentResponse = await runExecutionToLegacyResponse(first, {
        sessionId: session.id,
        userMessage: {
          role: 'user',
          content: [{ type: 'text', text: '请记录这条消息' }],
        },
        provider: 'mock',
        model: 'test-model',
      });
      expect(agentResponse.status).toBe(200);
      await agentResponse.text();

      const archiveResponse = await fetch(
        `http://127.0.0.1:${firstPort}/sessions/${session.id}/archive`,
        { method: 'POST' },
      );
      expect(archiveResponse.status).toBe(200);
      await first.stop();

      const secondPort = await reservePort();
      const second = await startServer(secondPort, { databaseFile: database.filename });
      try {
        const projectsResponse = await fetch(
          `http://127.0.0.1:${secondPort}/projects?includeArchived=true`,
        );
        expect(projectsResponse.status).toBe(200);
        expect(await projectsResponse.json()).toMatchObject({
          projects: [
            {
              name: 'Weave',
              sessions: [
                {
                  id: session.id,
                  title: '可恢复会话',
                  archivedAt: expect.any(String),
                },
              ],
            },
          ],
          warnings: [],
        });

        const detailResponse = await fetch(`http://127.0.0.1:${secondPort}/sessions/${session.id}`);
        expect(detailResponse.status).toBe(200);
        const detail = (await detailResponse.json()) as {
          readonly messages: readonly unknown[];
        };
        expect(detail.messages.length).toBeGreaterThan(0);
      } finally {
        await second.stop();
      }
    } finally {
      await database.cleanup();
    }
  });

  it('rejects when the port is already occupied without leaving an unhandled error', async () => {
    const occupiedServer = createServer().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => {
      occupiedServer.once('listening', resolve);
    });
    const address = occupiedServer.address();
    if (address === null || typeof address === 'string') {
      occupiedServer.close();
      throw new Error('Expected an address for the occupied test server');
    }

    const uncaughtErrors: unknown[] = [];
    const onUncaughtException = (error: unknown): void => {
      uncaughtErrors.push(error);
    };
    process.once('uncaughtException', onUncaughtException);
    const database = createTemporaryDatabaseFile();

    try {
      const outcome = await startServer(address.port, { databaseFile: database.filename }).then(
        (result) => ({ kind: 'resolved' as const, result }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      );

      if (outcome.kind === 'resolved') {
        await new Promise<void>((resolve) => setImmediate(resolve));
        await outcome.result.stop();
      }

      expect(outcome.kind).toBe('rejected');
      expect(outcome.kind === 'rejected' ? outcome.error : undefined).toMatchObject({
        code: 'EADDRINUSE',
      });
      expect(uncaughtErrors).toEqual([]);
    } finally {
      process.removeListener('uncaughtException', onUncaughtException);
      await new Promise<void>((resolve, reject) => {
        occupiedServer.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      await database.cleanup();
    }
  });

  it('retains the bind error when startup cleanup also fails', async () => {
    const occupiedServer = createServer().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => occupiedServer.once('listening', resolve));
    const address = occupiedServer.address();
    if (address === null || typeof address === 'string') {
      occupiedServer.close();
      throw new Error('Expected an address for the occupied test server');
    }
    const database = createTemporaryDatabaseFile();
    const projectCloseFailure = new Error('Project store failed to close');
    try {
      const outcome = await startServer(address.port, {
        databaseFile: database.filename,
        projectStore: {
          ...createInMemoryProjectStore(),
          close() {
            throw projectCloseFailure;
          },
        },
      }).catch((cause: unknown) => cause);
      expect(outcome).toBeInstanceOf(AggregateError);
      const failure = outcome as AggregateError;
      expect(failure.cause).toMatchObject({ code: 'EADDRINUSE' });
      expect(failure.errors).toEqual([failure.cause, projectCloseFailure]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        occupiedServer.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      await database.cleanup();
    }
  });
});
