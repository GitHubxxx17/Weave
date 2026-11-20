import { describe, expect, it } from 'vitest';
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
import type { ProviderSecretCodec } from '../src/provider-secret-codec.js';
import type { ProviderSettingsStore } from '../src/provider-settings-store.js';

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
      const agentResponse = await fetch(`http://127.0.0.1:${firstPort}/agent/runs/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: session.id,
          userMessage: {
            role: 'user',
            content: [{ type: 'text', text: '请记录这条消息' }],
          },
          provider: 'mock',
          model: 'test-model',
        }),
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
});
