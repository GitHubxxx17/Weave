import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { createSqliteMemoryStore, MemoryStoreStartupError } from '@weave/memory';
import { createSqliteSessionEventStore } from '@weave/session';
import { createSqliteProjectStore } from '@weave/workspace';
import { describe, expect, it, vi } from 'vitest';
import { startServer } from '../src/main.js';
import { createServerMemoryComposition } from '../src/memory-composition.js';
import { retryFailedServerStartupCleanup } from '../src/server-shutdown.js';
import { resolveMemoryDatabaseFile } from '../src/persistence-path.js';

async function temporaryDirectory() {
  return realpath(await mkdtemp(join(tmpdir(), 'weave-memory-composition-')));
}
const serverDefaults = {
  pluginsDirectory: false,
  skillsDirectory: false,
  environment: {},
} as const;
const record = () => ({
  operation: 'create' as const,
  expectedRevision: 0 as const,
  requestId: randomUUID(),
  title: 'Persistent fact',
  content: 'Keep this exact fact.',
  tags: ['context'],
});

describe('Server Memory composition', () => {
  it('keeps the real owner and dependencies on uncertain commit and retries readback without a second event', async () => {
    const directory = await temporaryDirectory();
    const databaseFile = join(directory, 'state.sqlite');
    const sessionStore = createSqliteSessionEventStore({ filename: databaseFile });
    const projectStore = createSqliteProjectStore({ filename: databaseFile });
    const sessionClose = vi.spyOn(sessionStore, 'close');
    const projectClose = vi.spyOn(projectStore, 'close');
    const order: string[] = [];
    let armed = false;
    let unreadable = false;
    let commits = 0;
    class FaultDatabase extends DatabaseSync {
      override exec(sql: string) {
        super.exec(sql);
        if (armed && sql.trim() === 'COMMIT') {
          armed = false;
          unreadable = true;
          commits++;
          throw new Error('Injected response loss after COMMIT');
        }
      }
      override prepare(sql: string): StatementSync {
        if (unreadable && sql.startsWith('SELECT * FROM memory_requests'))
          throw new Error('Injected receipt read failure');
        return super.prepare(sql);
      }
    }
    const server = await startServer(0, {
      ...serverDefaults,
      databaseFile,
      projectStore,
      sessionStoreFactory: () => sessionStore,
      memoryStoreFactory(options) {
        const store = createSqliteMemoryStore({
          ...options,
          databaseFactory: (filename) => new FaultDatabase(filename),
        });
        return {
          ...store,
          closeSync() {
            order.push('closeSync');
            store.closeSync();
          },
          async drain() {
            order.push('drain');
            await store.drain();
          },
          async close() {
            order.push('close');
            await store.close();
          },
        };
      },
    });
    try {
      const project = await projectStore.createProject({ name: 'Memory', folderName: 'memory' });
      const scope = { kind: 'project' as const, projectId: project.id };
      const input = record();
      armed = true;
      await expect(server.memory.service.local.create(scope, input)).rejects.toMatchObject({
        code: 'memory-persistence-uncertain',
      });
      await expect(server.stop()).rejects.toMatchObject({ code: 'memory-persistence-uncertain' });
      expect(order).toEqual(['closeSync', 'drain']);
      expect(sessionClose).not.toHaveBeenCalled();
      expect(projectClose).not.toHaveBeenCalled();
      await expect(startServer(0, { ...serverDefaults, databaseFile })).rejects.toMatchObject({
        code: 'memory-busy',
      });
      unreadable = false;
      await server.stop();
      expect(commits).toBe(1);
      expect(order).toEqual(['closeSync', 'drain', 'drain', 'close']);
      expect(sessionClose).toHaveBeenCalledOnce();
      expect(projectClose).toHaveBeenCalledOnce();
      const reopened = await startServer(0, { ...serverDefaults, databaseFile });
      try {
        const page = await reopened.memory.service.local.list(scope);
        expect(page.entries).toHaveLength(1);
        expect(page.entries[0]?.title).toBe('Persistent fact');
        const receipt = await reopened.memory.service.local.create(scope, input);
        expect(receipt.subject).toMatchObject({ kind: 'record', revision: 1 });
        expect((await reopened.memory.service.local.list(scope)).entries).toHaveLength(1);
      } finally {
        await reopened.stop();
      }
    } finally {
      unreadable = false;
      await server.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('holds ownership until the same cancelled search worker actually exits', async () => {
    const directory = await temporaryDirectory();
    const databaseFile = join(directory, 'state.sqlite');
    const entered = Promise.withResolvers<void>();
    class DelayedWorker extends EventEmitter {
      readonly terminate = vi.fn(async () => 0);
    }
    const worker = new DelayedWorker();
    const closeStore = vi.fn();
    const server = await startServer(0, {
      ...serverDefaults,
      databaseFile,
      memoryStoreFactory(options) {
        const store = createSqliteMemoryStore({
          ...options,
          searchWorkerFactory: () => {
            entered.resolve();
            return worker as never;
          },
        });
        return {
          ...store,
          async close() {
            closeStore();
            await store.close();
          },
        };
      },
    });
    try {
      const search = server.memory.service.local
        .search({ kind: 'user' }, { query: 'memory' })
        .catch((cause: unknown) => cause);
      await entered.promise;
      await expect(server.stop()).rejects.toMatchObject({ code: 'memory-busy' });
      expect(worker.terminate).toHaveBeenCalled();
      expect(closeStore).not.toHaveBeenCalled();
      await expect(startServer(0, { ...serverDefaults, databaseFile })).rejects.toMatchObject({
        code: 'memory-busy',
      });
      worker.emit('exit', 0);
      await search;
      await server.stop();
      expect(closeStore).toHaveBeenCalledOnce();
    } finally {
      worker.emit('exit', 0);
      await server.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }, 15000);

  it('retains failed-startup cleanup for the same Memory owner until its barrier can settle', async () => {
    const directory = await temporaryDirectory();
    const databaseFile = join(directory, 'state.sqlite');
    const listener = createServer().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => listener.once('listening', resolve));
    const address = listener.address();
    if (address === null || typeof address === 'string') throw new Error('No port');
    let blocked = true;
    const closeStore = vi.fn();
    let failure: unknown;
    try {
      failure = await startServer(address.port, {
        ...serverDefaults,
        databaseFile,
        memoryStoreFactory(options) {
          const store = createSqliteMemoryStore(options);
          return {
            ...store,
            async drain() {
              if (blocked) throw new Error('Memory drain incomplete');
              await store.drain();
            },
            async close() {
              closeStore();
              await store.close();
            },
          };
        },
      }).catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).cause).toMatchObject({ code: 'EADDRINUSE' });
      expect(closeStore).not.toHaveBeenCalled();
      expect(() =>
        createSqliteMemoryStore({ filename: `${databaseFile}.memory.sqlite` }),
      ).toThrowError(expect.objectContaining({ code: 'memory-busy' }));
      blocked = false;
      await retryFailedServerStartupCleanup(failure);
      expect(closeStore).toHaveBeenCalledOnce();
      await expect(retryFailedServerStartupCleanup(failure)).rejects.toThrow(TypeError);
      const reopened = createSqliteMemoryStore({ filename: `${databaseFile}.memory.sqlite` });
      await reopened.close();
    } finally {
      blocked = false;
      if (failure !== undefined) await retryFailedServerStartupCleanup(failure).catch(() => {});
      await new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('uses the canonical sidecar, preserves Session migration version and registers host Memory tools with defaults', async () => {
    const directory = await temporaryDirectory();
    const databaseFile = join(directory, 'state.sqlite');
    const sessionStore = createSqliteSessionEventStore({ filename: databaseFile });
    const connection = new DatabaseSync(databaseFile);
    const version = connection.prepare('PRAGMA user_version').get()?.user_version;
    const server = await startServer(0, {
      ...serverDefaults,
      databaseFile,
      sessionStoreFactory: () => sessionStore,
    });
    try {
      expect(server.memory.databaseFile).toBe(await resolveMemoryDatabaseFile(databaseFile));
      expect(connection.prepare('PRAGMA user_version').get()?.user_version).toBe(version);
      const generation = server.runtime.serverHost.controller()!.current();
      const tools = generation.resources.toolRegistry
        .list()
        .filter((tool) =>
          ['search_memory', 'read_memory', 'save_memory', 'delete_memory'].includes(tool.name),
        );
      expect(tools.map((tool) => tool.name)).toEqual([
        'search_memory',
        'read_memory',
        'save_memory',
        'delete_memory',
      ]);
      expect(tools.map((tool) => server.memory.rootOnlyTool(tool))).toEqual([
        false,
        false,
        true,
        true,
      ]);
      const page = await server.memory.service.local.list({ kind: 'user' });
      expect(page.entries).toEqual([]);
    } finally {
      await server.stop();
      connection.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

it.each(['valid', 'invalid-origin'] as const)(
  'binds genuine child reads to accepted project lineage with %s and excludes write tools',
  async (scenario) => {
    const directory = await temporaryDirectory();
    const databaseFile = join(directory, 'state.sqlite');
    const projects = createSqliteProjectStore({ filename: databaseFile });
    const sessions = createSqliteSessionEventStore({ filename: databaseFile });
    const sessionPort = {
      ...sessions,
      async read(...args: Parameters<typeof sessions.read>) {
        const events = await sessions.read(...args);
        return scenario === 'invalid-origin' && events.at(-1)?.type === 'tool-call.created'
          ? events.map((event) =>
              event.type === 'agent.task.origin'
                ? {
                    ...event,
                    payload: { ...event.payload, parentAcceptedDigest: '0'.repeat(64) },
                  }
                : event,
            )
          : events;
      },
    };
    const childRequests: { tools?: readonly { name: string }[] }[] = [];
    let memoryId = '';
    let rootCalls = 0;
    let childCalls = 0;
    const server = await startServer(0, {
      ...serverDefaults,
      databaseFile,
      projectStore: projects,
      sessionStoreFactory: () => sessionPort,
      plugins: [
        {
          manifest: {
            id: 'memory-test-provider',
            name: 'Memory fixture',
            version: '1.0.0',
            apiVersion: '1.0.0',
            capabilities: ['llm-provider'],
          },
          setup(context) {
            context.registerProvider({
              id: 'memory-fixture',
              label: 'Memory fixture',
              type: 'mock',
              client: {
                async *stream(request) {
                  const isChild = request.messages.some(
                    (message) =>
                      message.role === 'user' &&
                      message.content.some(
                        (part) => part.type === 'text' && part.text === 'Read the project fact',
                      ),
                  );
                  if (isChild) childRequests.push(request);
                  const invoke = isChild ? childCalls++ === 0 : rootCalls++ === 0;
                  if (invoke) {
                    yield {
                      type: 'tool-call-start',
                      id: isChild ? 'child-read' : 'root-spawn',
                      name: isChild ? 'read_memory' : 'agent_spawn',
                    };
                    yield {
                      type: 'tool-call-delta',
                      id: isChild ? 'child-read' : 'root-spawn',
                      argumentsDelta: JSON.stringify(
                        isChild
                          ? { memoryId }
                          : {
                              title: 'Read memory',
                              prompt: 'Read the project fact',
                              access: 'workspace',
                            },
                      ),
                    };
                    yield { type: 'finish', reason: 'tool-call' };
                  } else {
                    yield { type: 'text-delta', text: 'Complete' };
                    yield { type: 'finish', reason: 'stop' };
                  }
                },
              },
            });
          },
        },
      ],
    });
    const post = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${server.port}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    try {
      const project = await projects.createProject({ name: 'Actual scope', folderName: 'scope' });
      const scope = { kind: 'project' as const, projectId: project.id };
      const created = await server.memory.service.local.create(scope, record());
      if (created.subject.kind !== 'record') throw new Error('No record');
      memoryId = created.subject.memoryId;
      await server.memory.service.local.setAccess(scope, {
        requestId: randomUUID(),
        level: 'read-write',
        expectedSettingRevision: 0,
      });
      const response = await post(`/projects/${project.id}/sessions`, {});
      const root = (await response.json()) as { id: string };
      const launched = await post(`/sessions/${root.id}/executions`, {
        requestId: 'root',
        input: {
          provider: 'memory-fixture',
          model: 'fixture',
          permissionMode: 'yolo',
          userMessage: {
            role: 'user',
            content: [{ type: 'text', text: 'Delegate a memory read' }],
          },
        },
      });
      expect(launched.status, await launched.text()).toBe(202);
      await expect.poll(() => childRequests.length).toBe(2);
      const accepted = (await sessions.read(root.id)).find(
        (event) => event.type === 'agent.task.accepted',
      );
      if (accepted?.type !== 'agent.task.accepted') throw new Error('Missing child');
      await expect
        .poll(async () =>
          (await sessions.read(accepted.payload.childSessionId)).some(
            (event) => event.type === 'tool-result.created' && event.payload.name === 'read_memory',
          ),
        )
        .toBe(true);
      const result = (await sessions.read(accepted.payload.childSessionId)).find(
        (event) => event.type === 'tool-result.created' && event.payload.name === 'read_memory',
      );
      expect(result).toMatchObject({
        payload:
          scenario === 'valid'
            ? { status: 'completed' }
            : {
                status: 'failed',
                errorCode: 'memory-scope-forbidden',
              },
      });
      if (result?.type !== 'tool-result.created') throw new Error('Missing result');
      if (scenario === 'valid') expect(result.payload.content).toContain('Keep this exact fact.');
      else expect(result.payload.content).not.toContain('Keep this exact fact.');
      const names = childRequests[0]?.tools?.map((tool) => tool.name);
      expect(names).toContain('read_memory');
      expect(names).toContain('search_memory');
      expect(names).not.toContain('save_memory');
      expect(names).not.toContain('delete_memory');
    } finally {
      await server.stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.each(['tool-call', 'execution-accepted'] as const)(
  'rejects a genuine active caller when its durable %s fact is unavailable',
  async (omission) => {
    const directory = await temporaryDirectory();
    const databaseFile = join(directory, 'state.sqlite');
    const projects = createSqliteProjectStore({ filename: databaseFile });
    const persisted = createSqliteSessionEventStore({ filename: databaseFile });
    const store = {
      ...persisted,
      async read(...args: Parameters<typeof persisted.read>) {
        const events = await persisted.read(...args);
        if (events.at(-1)?.type !== 'tool-call.created') return events;
        return omission === 'tool-call'
          ? events.slice(0, -1)
          : events
              .filter((event) => event.type !== 'execution.accepted')
              .map((event, index) => ({ ...event, sequence: index + 1 }));
      },
    };
    let calls = 0;
    let memoryId = '';
    const server = await startServer(0, {
      ...serverDefaults,
      databaseFile,
      projectStore: projects,
      sessionStoreFactory: () => store,
      plugins: [
        {
          manifest: {
            id: 'memory-source-provider',
            name: 'Source fixture',
            version: '1.0.0',
            apiVersion: '1.0.0',
            capabilities: ['llm-provider'],
          },
          setup(context) {
            context.registerProvider({
              id: 'source-fixture',
              label: 'Source fixture',
              type: 'mock',
              client: {
                async *stream() {
                  if (calls++ === 0) {
                    yield {
                      type: 'tool-call-start',
                      id: 'unavailable-source',
                      name: 'read_memory',
                    };
                    yield {
                      type: 'tool-call-delta',
                      id: 'unavailable-source',
                      argumentsDelta: JSON.stringify({ memoryId }),
                    };
                    yield { type: 'finish', reason: 'tool-call' };
                  } else {
                    yield { type: 'finish', reason: 'stop' };
                  }
                },
              },
            });
          },
        },
      ],
    });
    const post = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${server.port}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    try {
      const project = await projects.createProject({ name: 'Source', folderName: 'source' });
      const scope = { kind: 'project' as const, projectId: project.id };
      const created = await server.memory.service.local.create(scope, record());
      if (created.subject.kind !== 'record') throw new Error('No record');
      memoryId = created.subject.memoryId;
      await server.memory.service.local.setAccess(scope, {
        requestId: randomUUID(),
        level: 'read-only',
        expectedSettingRevision: 0,
      });
      const session = (await (await post(`/projects/${project.id}/sessions`, {})).json()) as {
        id: string;
      };
      const launched = await post(`/sessions/${session.id}/executions`, {
        requestId: 'source',
        input: {
          provider: 'source-fixture',
          model: 'fixture',
          permissionMode: 'yolo',
          userMessage: { role: 'user', content: [{ type: 'text', text: 'Read memory' }] },
        },
      });
      expect(launched.status, await launched.text()).toBe(202);
      await expect
        .poll(async () =>
          (await persisted.read(session.id)).some((event) => event.type === 'tool-result.created'),
        )
        .toBe(true);
      const result = (await persisted.read(session.id)).find(
        (event) => event.type === 'tool-result.created',
      );
      expect(result).toMatchObject({
        payload: { status: 'failed', errorCode: 'memory-scope-forbidden' },
      });
      if (result?.type !== 'tool-result.created') throw new Error('Missing result');
      expect(result.payload.content).not.toContain('Keep this exact fact.');
    } finally {
      await server.stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it('retains ownership and dependencies when the data connection closes but its acknowledgement fails', async () => {
  const directory = await temporaryDirectory();
  const databaseFile = join(directory, 'state.sqlite');
  const projectStore = createSqliteProjectStore({ filename: databaseFile });
  const sessionStore = createSqliteSessionEventStore({ filename: databaseFile });
  const sessionClose = vi.spyOn(sessionStore, 'close');
  const projectClose = vi.spyOn(projectStore, 'close');
  let failClose = false;
  class CloseFailureDatabase extends DatabaseSync {
    override close() {
      super.close();
      if (failClose) {
        failClose = false;
        throw new Error('Injected close acknowledgement failure');
      }
    }
  }
  const server = await startServer(0, {
    ...serverDefaults,
    databaseFile,
    projectStore,
    sessionStoreFactory: () => sessionStore,
    memoryStoreFactory: (options) =>
      createSqliteMemoryStore({
        ...options,
        databaseFactory: (filename) => new CloseFailureDatabase(filename),
      }),
  });
  try {
    failClose = true;
    await expect(server.stop()).rejects.toMatchObject({ code: 'memory-persistence-error' });
    expect(sessionClose).not.toHaveBeenCalled();
    expect(projectClose).not.toHaveBeenCalled();
    await expect(startServer(0, { ...serverDefaults, databaseFile })).rejects.toMatchObject({
      code: 'memory-busy',
    });
    await server.stop();
    expect(sessionClose).toHaveBeenCalledOnce();
    expect(projectClose).toHaveBeenCalledOnce();
    const reopened = createSqliteMemoryStore({
      filename: await resolveMemoryDatabaseFile(databaseFile),
    });
    await reopened.close();
  } finally {
    failClose = false;
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

it('registers a constructor cleanup failure before failed-startup shutdown and retains dependent stores for retry', async () => {
  const directory = await temporaryDirectory();
  const databaseFile = join(directory, 'state.sqlite');
  const memoryFile = `${databaseFile}.memory.sqlite`;
  const initial = new DatabaseSync(memoryFile);
  initial.exec('PRAGMA user_version = 2');
  initial.close();
  const sessionStore = createSqliteSessionEventStore({ filename: databaseFile });
  const projectStore = createSqliteProjectStore({ filename: databaseFile });
  const sessionClose = vi.spyOn(sessionStore, 'close');
  const projectClose = vi.spyOn(projectStore, 'close');
  let blocked = true;
  let connection: DatabaseSync | undefined;
  let failure: unknown;
  class CloseFailureDatabase extends DatabaseSync {
    override close() {
      if (blocked) throw new Error('Injected startup data close failure');
      super.close();
    }
  }
  try {
    failure = await startServer(0, {
      ...serverDefaults,
      databaseFile,
      projectStore,
      sessionStoreFactory: () => sessionStore,
      memoryStoreFactory: (options) =>
        createSqliteMemoryStore({
          ...options,
          databaseFactory: (filename) => {
            connection = new CloseFailureDatabase(filename);
            return connection;
          },
        }),
    }).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).cause).toBeInstanceOf(MemoryStoreStartupError);
    expect((failure as AggregateError).cause).toMatchObject({ code: 'memory-persistence-error' });
    expect(connection?.isOpen).toBe(true);
    expect(sessionClose).not.toHaveBeenCalled();
    expect(projectClose).not.toHaveBeenCalled();
    await expect(sessionStore.read('startup-cleanup-probe')).resolves.toEqual([]);
    await expect(projectStore.listProjects()).resolves.toEqual([]);
    expect(() => createSqliteMemoryStore({ filename: memoryFile })).toThrow(
      expect.objectContaining({ code: 'memory-busy' }),
    );
    await expect(retryFailedServerStartupCleanup(failure)).rejects.toMatchObject({
      code: 'memory-persistence-error',
    });
    expect(sessionClose).not.toHaveBeenCalled();
    expect(projectClose).not.toHaveBeenCalled();
    blocked = false;
    await retryFailedServerStartupCleanup(failure);
    expect(connection?.isOpen).toBe(false);
    expect(sessionClose).toHaveBeenCalledOnce();
    expect(projectClose).toHaveBeenCalledOnce();
    await expect(retryFailedServerStartupCleanup(failure)).rejects.toThrow(TypeError);
    const repair = new DatabaseSync(memoryFile);
    repair.exec('PRAGMA user_version = 0');
    repair.close();
    const reopened = await startServer(0, { ...serverDefaults, databaseFile });
    await reopened.stop();
  } finally {
    blocked = false;
    if (failure !== undefined) await retryFailedServerStartupCleanup(failure).catch(() => {});
    if (connection?.isOpen) DatabaseSync.prototype.close.call(connection);
    await sessionStore.close();
    await projectStore.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('does not register cleanup-shaped ordinary errors as owned startup resources', async () => {
  const directory = await temporaryDirectory();
  const databaseFile = join(directory, 'state.sqlite');
  const sessionStore = createSqliteSessionEventStore({ filename: databaseFile });
  const projectStore = createSqliteProjectStore({ filename: databaseFile });
  const registerResource = vi.fn();
  const failure = Object.assign(new Error('ordinary failure'), {
    code: 'memory-persistence-error',
    cleanup: { closeSync() {}, async drain() {}, async close() {} },
  });
  try {
    await expect(
      createServerMemoryComposition({
        databaseFile,
        sessionStore,
        projectStore,
        registerResource,
        storeFactory() {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(registerResource).not.toHaveBeenCalled();
  } finally {
    await sessionStore.close();
    await projectStore.close();
    await rm(directory, { recursive: true, force: true });
  }
});
