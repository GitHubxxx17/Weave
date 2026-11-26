import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentTaskSpawnInputSchema } from '@weave/protocol';
import {
  agentTaskFactDigest,
  createInMemorySessionEventStore,
  createSqliteSessionEventStore,
  type NewSessionEvent,
  type SessionEventStore,
} from '@weave/session';
import {
  adaptTaskRunnerLease,
  agentTaskOrigin,
  createAgentExecutionService,
  createAgentRunner,
  createAgentToolAuthority,
  createToolPipeline,
  createToolRegistry,
  deriveAgentToolAuthority,
  describeAgentToolAuthority,
  getBoundTaskExecutionPort,
  type AgentRunner,
  type ToolExecutionContext,
} from '../src/index.js';
import { createAgentTaskService } from '../src/agent-task-service.js';
import type { AgentTaskHost, AgentTaskLifetime } from '../src/agent-task-host.js';
import type { TaskProjectRelation } from '../src/agent-task-types.js';

const request = { title: 'Review', prompt: 'Review the patch.' };
const parentInput = {
  provider: 'mock',
  model: 'test',
  temperature: 0.25,
  permissionMode: 'ask' as const,
  userMessage: {
    role: 'user' as const,
    content: [{ type: 'text' as const, text: 'Start a task.' }],
  },
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const teardown: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of teardown.splice(0).reverse()) await dispose();
});

function setup(
  options: {
    store?: SessionEventStore;
    append?: (
      original: SessionEventStore,
      id: string,
      events: readonly NewSessionEvent[],
    ) => ReturnType<SessionEventStore['append']>;
    read?: (original: SessionEventStore, id: string) => ReturnType<SessionEventStore['read']>;
    beforeCreate?: () => Promise<void>;
    beforeAttach?: () => Promise<void>;
    afterCreate?: () => void;
    afterAttach?: () => void;
    afterLaunch?: () => void;
    beforeChild?: (signal: AbortSignal) => Promise<void>;
    onStartCheck?: (lifetime: AgentTaskLifetime) => void;
    afterCheckpointCheck?: (lifetime: AgentTaskLifetime) => void;
    relation?: (attached: boolean) => TaskProjectRelation;
    projectAvailable?: boolean;
  } = {},
) {
  const original = options.store ?? createInMemorySessionEventStore();
  const store: SessionEventStore = {
    ...original,
    append: (id, events) => options.append?.(original, id, events) ?? original.append(id, events),
    read: (id) => options.read?.(original, id) ?? original.read(id),
    close: () => original.close(),
  };
  const registry = createToolRegistry();
  const attached = new Set<string>();
  const creates: string[] = [];
  const reserves: string[] = [];
  const releases: string[] = [];
  const starts: string[] = [];
  const contexts: ToolExecutionContext[] = [];
  const childRunner = createAgentRunner({
    sessionStore: store,
    toolRegistry: registry,
    toolPipeline: createToolPipeline({ registry }),
    llm: {
      async *stream(_request, runOptions) {
        if (options.beforeChild !== undefined) {
          if (runOptions?.signal === undefined) throw new Error('Missing child provider signal');
          await options.beforeChild(runOptions.signal);
        }
        yield { type: 'text-delta', text: 'Reviewed.' };
        yield { type: 'finish', reason: 'stop' };
      },
    },
  });
  const host: AgentTaskHost = {
    async reserve({ context, child, access, lifetime }) {
      if (options.projectAvailable === false) throw new Error('No Project');
      reserves.push(child.sessionId);
      const token = deriveAgentToolAuthority(context, { identity: child, access });
      let checkpointChecked = false;
      const assertCanStartSync = () => {
        options.onStartCheck?.(lifetime);
        if (lifetime.getStopReason() !== undefined) throw new Error('Closed');
        if (checkpointChecked) {
          checkpointChecked = false;
          options.afterCheckpointCheck?.(lifetime);
        }
      };
      return {
        project: { projectId: 'project', folderRevision: 2 },
        tools: describeAgentToolAuthority(token).tools,
        assertCanStartSync,
        async checkpoint() {
          assertCanStartSync();
          checkpointChecked = true;
        },
        async createExact(accepted, sequence) {
          creates.push(child.sessionId);
          await options.beforeCreate?.();
          await store.append(child.sessionId, [
            { type: 'session.created', payload: { title: accepted.title } },
            { type: 'agent.task.origin', payload: agentTaskOrigin(accepted, sequence) },
          ]);
          options.afterCreate?.();
        },
        async attachExact() {
          await options.beforeAttach?.();
          attached.add(child.sessionId);
          options.afterAttach?.();
        },
        async withLaunchAuthority(operation) {
          const result = await operation();
          options.afterLaunch?.();
          return result;
        },
        bindRunner(authority) {
          const runner: AgentRunner = {
            run(input) {
              starts.push(child.sessionId);
              return childRunner.run({
                ...input,
                toolAuthority: token,
                signal:
                  input.signal === undefined
                    ? lifetime.signal
                    : AbortSignal.any([input.signal, lifetime.signal]),
              });
            },
          };
          return adaptTaskRunnerLease(authority, { runner, assertCanStartSync });
        },
        closeStarts() {},
        release() {
          releases.push(child.sessionId);
        },
      };
    },
    async projectRelation(accepted) {
      const isAttached = attached.has(accepted.childSessionId);
      return options.relation?.(isAttached) ?? (isAttached ? 'attached' : 'unattached');
    },
  };
  const execution = createAgentExecutionService({
    sessionStore: store,
    runner: {
      run: () => {
        throw new Error('An ordinary runner cannot launch a task');
      },
    },
    admit: async () => {},
  });
  const tasks = createAgentTaskService({
    sessionStore: store,
    execution: getBoundTaskExecutionPort(execution),
    host,
  });
  teardown.push(async () => {
    tasks.closeSync();
    await tasks.drain().catch(() => {});
    execution.closeSync();
    await execution.drain();
    await store.close();
  });
  let invoke: ((context: ToolExecutionContext) => Promise<void>) | undefined;
  let invocationFailure: unknown;
  registry.register({
    name: 'agent_spawn',
    description: 'Spawn a task',
    parameters: { type: 'object' },
    inputSchema: agentTaskSpawnInputSchema,
    async execute(_args, context) {
      contexts.push(context);
      try {
        await invoke?.(context);
      } catch (cause: unknown) {
        invocationFailure = cause;
        throw cause;
      }
      return 'ok';
    },
  });
  const onSpawn = async (
    onInvoke: (context: ToolExecutionContext, index: number) => Promise<void>,
    {
      root = 'root',
      count = 1,
      before,
    }: { root?: string; count?: number; before?: () => Promise<void> } = {},
  ) => {
    let call = 0;
    invocationFailure = undefined;
    invoke = (context) => onInvoke(context, call++);
    const identity = {
      executionId: randomUUID(),
      turnId: randomUUID(),
      userMessageId: randomUUID(),
    };
    if ((await original.read(root)).length === 0)
      await original.append(root, [{ type: 'session.created', payload: {} }]);
    await original.append(root, [
      {
        type: 'execution.accepted',
        payload: {
          ...identity,
          requestId: randomUUID(),
          requestDigest: agentTaskFactDigest(parentInput),
          input: parentInput,
        },
      },
    ]);
    let step = 0;
    const parent = createAgentRunner({
      sessionStore: original,
      toolRegistry: registry,
      toolPipeline: createToolPipeline({ registry }),
      maxSteps: count + 1,
      llm: {
        async *stream() {
          if (step++ === 0) await before?.();
          if (step <= count) {
            yield { type: 'tool-call-start', id: `call-${step}`, name: 'agent_spawn' };
            yield {
              type: 'tool-call-delta',
              id: `call-${step}`,
              argumentsDelta: JSON.stringify(request),
            };
            yield { type: 'finish', reason: 'tool-call' };
          } else yield { type: 'finish', reason: 'stop' };
        },
      },
    });
    for await (const _ of parent.run({
      ...parentInput,
      sessionId: root,
      executionIdentity: identity,
      toolAuthority: createAgentToolAuthority({
        identity: { sessionId: root, ...identity },
        registry,
        ownerOf: () => 'core',
      }),
    }))
      void _;
    await original.append(root, [
      {
        type: 'execution.finished',
        payload: { executionId: identity.executionId, status: 'completed' },
      },
    ]);
    if (invocationFailure !== undefined) throw invocationFailure;
  };
  return {
    tasks,
    original,
    execution,
    attached,
    starts,
    creates,
    reserves,
    releases,
    onSpawn,
    contexts,
  };
}

async function acceptedFacts(store: SessionEventStore, root = 'root') {
  return (await store.read(root)).filter((event) => event.type === 'agent.task.accepted');
}

describe('Agent task admission and materialization', () => {
  it('returns identical concurrent receipts before a blocked create and rejects altered arguments', async () => {
    const allowCreate = deferred();
    const { tasks, original, creates, starts, onSpawn } = setup({
      beforeCreate: () => allowCreate.promise,
    });
    try {
      await onSpawn(async (context) => {
        const [first, second] = await Promise.all([
          tasks.spawn(request, context),
          tasks.spawn(request, context),
        ]);
        expect(first).toEqual(second);
        expect(first.status).toBe('preparing');
        expect(await original.read(first.childSessionId)).toEqual([]);
        await expect(tasks.spawn({ ...request, prompt: 'Changed' }, context)).rejects.toMatchObject(
          {
            code: 'agent-task-request-conflict',
          },
        );
      });
      const [fact] = await acceptedFacts(original);
      expect(fact?.payload.settings).toEqual({
        provider: 'mock',
        model: 'test',
        temperature: 0.25,
        permissionMode: 'ask',
        useProviderDefaults: false,
      });
      expect(fact?.payload.access).toBe('read-only');
      expect(await acceptedFacts(original)).toHaveLength(1);
    } finally {
      allowCreate.resolve();
    }
    await vi.waitFor(() => expect(tasks.snapshot('root')[0]?.status).toBe('completed'));
    expect(creates).toHaveLength(1);
    expect(starts).toHaveLength(1);
  });

  it('keeps accepted work after its genuine tool invocation returns', async () => {
    const allowCreate = deferred();
    const { tasks, original, onSpawn } = setup({ beforeCreate: () => allowCreate.promise });
    let context: ToolExecutionContext | undefined;
    try {
      await onSpawn(async (call) => {
        context = call;
        await tasks.spawn(request, call);
      });
      expect(context?.signal.aborted).toBe(true);
    } finally {
      allowCreate.resolve();
    }
    await vi.waitFor(() => expect(tasks.snapshot('root')[0]?.status).toBe('completed'));
    expect(tasks.snapshot('root')[0]?.permissionMode).toBe(parentInput.permissionMode);
    expect(
      (await original.read('root')).filter((event) => event.type === 'turn.started'),
    ).toHaveLength(1);
  });

  it('permanently fences a delayed create and settles without a phantom child Turn', async () => {
    const enteredCreate = deferred();
    const allowCreate = deferred();
    const { tasks, original, starts, releases, onSpawn } = setup({
      async beforeCreate() {
        enteredCreate.resolve();
        await allowCreate.promise;
      },
    });
    try {
      await onSpawn(async (context) => {
        await tasks.spawn(request, context);
      });
      await enteredCreate.promise;
      const [accepted] = await acceptedFacts(original);
      const { taskId, childSessionId } = accepted!.payload;
      const [cancel] = await tasks.requestCancel('root', [taskId], 'operation', 'parent-stop');
      expect(cancel?.status).toBe('cancelling');
      expect(tasks.snapshot('root')[0]?.status).toBe('cancelling');
      expect(releases).toEqual([]);
      allowCreate.resolve();
      await vi.waitFor(() =>
        expect(tasks.snapshot('root')[0]).toMatchObject({
          status: 'cancelled',
          reason: 'parent-stop',
        }),
      );
      expect(starts).toEqual([]);
      expect((await original.read(childSessionId)).map((event) => event.type)).toEqual([
        'session.created',
        'agent.task.origin',
      ]);
      expect(releases).toEqual([childSessionId]);
      await expect(
        tasks.requestCancel('root', [taskId], 'later-operation', 'task-cancelled'),
      ).resolves.toMatchObject([{ status: 'cancelled', reason: 'parent-stop' }]);
      expect(releases).toEqual([childSessionId]);
    } finally {
      allowCreate.resolve();
    }
  });

  it('settles a cancellation recorded before the materializer has started', async () => {
    const { tasks, original, creates, onSpawn } = setup();
    await onSpawn(async (context) => {
      const receipt = await tasks.spawn(request, context);
      await tasks.requestCancel('root', [receipt.taskId], 'operation', 'task-cancelled');
    });
    await vi.waitFor(() => expect(tasks.snapshot('root')[0]?.status).toBe('cancelled'));
    expect(creates).toEqual([]);
    expect(
      (await original.read('root')).find((event) => event.type === 'agent.task.settled')?.payload,
    ).toMatchObject({ settlement: { phase: 'preparation', evidence: { stage: 'accepted' } } });
  });

  it('stops the exact parent Turn, preserves a replay and admits the next Turn', async () => {
    const { tasks, starts, onSpawn } = setup();
    await onSpawn(
      async (context, index) => {
        if (index === 0) {
          const receipt = await tasks.spawn(request, context);
          const [{ parentTurnId }] = tasks.snapshot('root');
          await expect(tasks.stopParentTurn('root', parentTurnId, 'stop')).resolves.toMatchObject([
            { status: 'cancelling' },
          ]);
          await expect(tasks.spawn(request, context)).resolves.toEqual(receipt);
        } else {
          await expect(tasks.spawn(request, context)).rejects.toMatchObject({
            code: 'agent-task-not-permitted',
          });
        }
      },
      { count: 2 },
    );
    await vi.waitFor(() => expect(tasks.snapshot('root')[0]?.reason).toBe('parent-stop'));
    expect(starts).toEqual([]);
    await onSpawn(async (context) => {
      await tasks.spawn(request, context);
    });
    await vi.waitFor(() => expect(tasks.snapshot('root')[1]?.status).toBe('completed'));
  });

  it('serializes Session lifecycle changes with spawn and guards both sides of live tasks', async () => {
    const releaseArchive = deferred();
    const startedArchive = deferred();
    const startedChild = deferred();
    const releaseChild = deferred();
    const { tasks, execution, original, reserves, onSpawn } = setup({
      async beforeChild() {
        startedChild.resolve();
        await releaseChild.promise;
      },
    });
    try {
      await onSpawn(async (context) => {
        const archive = tasks.withTaskSessionsIdle('root', async () => {
          startedArchive.resolve();
          await releaseArchive.promise;
          await execution.withSessionIdle('root', () => Promise.resolve());
        });
        const refused = expect(archive).rejects.toMatchObject({ code: 'execution-busy' });
        await startedArchive.promise;
        const spawn = tasks.spawn(request, context);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(reserves).toEqual([]);
        releaseArchive.resolve();
        await refused;
        const receipt = await spawn;
        for (const id of ['root', receipt.childSessionId])
          await expect(
            tasks.withTaskSessionsIdle(id, () => Promise.resolve()),
          ).rejects.toMatchObject({ code: 'agent-task-busy' });
      });
      await startedChild.promise;
      releaseChild.resolve();
      await vi.waitFor(() => expect(tasks.snapshot('root')[0]?.status).toBe('completed'));
      const { childSessionId } = tasks.snapshot('root')[0]!;
      await expect(
        tasks.withTaskSessionsIdle(childSessionId, () =>
          execution.withSessionIdle(childSessionId, async () => {
            await original.append(childSessionId, [{ type: 'session.archived', payload: {} }]);
          }),
        ),
      ).resolves.toBeUndefined();
      expect(tasks.snapshot('root')[0]?.result?.sessionId).toBe(childSessionId);
    } finally {
      releaseArchive.resolve();
      releaseChild.resolve();
    }
  });

  it('stops an uncertain acceptance and allows a later spawn in the same Turn', async () => {
    let parentUnavailable = false;
    let blockAcceptance = true;
    const { tasks, original, starts, onSpawn } = setup({
      async append(actual, id, events) {
        const written = await actual.append(id, events);
        if (blockAcceptance && events.some(({ type }) => type === 'agent.task.accepted')) {
          parentUnavailable = true;
          throw new Error('Acceptance acknowledgement lost');
        }
        return written;
      },
      async read(actual, id) {
        if (parentUnavailable && id === 'root') throw new Error('Parent unavailable');
        return actual.read(id);
      },
    });
    await onSpawn(
      async (context, index) => {
        if (index === 0) {
          await expect(tasks.spawn(request, context)).rejects.toMatchObject({
            code: 'agent-task-persistence-error',
          });
          await expect(tasks.withTaskSessionsIdle('root', async () => {})).rejects.toMatchObject({
            code: 'agent-task-busy',
          });
          await expect(tasks.stopAll('root', 'root-stop')).rejects.toMatchObject({
            code: 'agent-task-persistence-error',
          });
          parentUnavailable = false;
          blockAcceptance = false;
          await tasks.retry('root');
          await vi.waitFor(() =>
            expect(tasks.snapshot('root')[0]).toMatchObject({
              status: 'cancelled',
              reason: 'task-cancelled',
            }),
          );
        } else {
          await tasks.spawn(request, context);
        }
      },
      { count: 2 },
    );
    await vi.waitFor(() => expect(tasks.snapshot('root')[1]?.status).toBe('completed'));
    expect(starts).toEqual([tasks.snapshot('root')[1]?.childSessionId]);
    expect(
      (await original.read('root')).filter(({ type }) => type === 'agent.task.cancel-requested'),
    ).toHaveLength(1);
  });

  it('replays the original stop-all target after later children are admitted', async () => {
    const { tasks, original, onSpawn } = setup();
    await onSpawn(
      async (context, index) => {
        const receipt = await tasks.spawn(request, context);
        const targets = await tasks.stopAll('root', 'same-stop');
        if (index === 0) expect(targets.map(({ taskId }) => taskId)).toEqual([receipt.taskId]);
        else
          expect(targets.map(({ taskId }) => taskId)).toEqual([tasks.snapshot('root')[0]?.taskId]);
      },
      { count: 2 },
    );
    await vi.waitFor(() =>
      expect(tasks.snapshot('root').map(({ status }) => status)).toEqual([
        'cancelled',
        'completed',
      ]),
    );
    expect(
      (await original.read('root')).filter(({ type }) => type === 'agent.task.cancel-requested'),
    ).toHaveLength(1);
  });

  it.each(['empty', 'already-stopping'] as const)(
    'replays a durable %s stop-all across recovery without stopping a new child',
    async (stage) => {
      const first = setup();
      let originalTargets: string[] = [];
      await first.onSpawn(async (context) => {
        if (stage === 'already-stopping') {
          const receipt = await first.tasks.spawn(request, context);
          originalTargets = [receipt.taskId];
          await first.tasks.requestCancel('root', originalTargets, 'first-stop', 'parent-stop');
        }
        expect(
          (await first.tasks.stopAll('root', 'same-batch')).map(({ taskId }) => taskId),
        ).toEqual(originalTargets);
      });
      first.tasks.closeSync();
      await first.tasks.drain();

      const second = setup({ store: first.original });
      await second.tasks.recover(['root'], (ids) => second.execution.recover(ids));
      await second.onSpawn(async (context) => {
        await second.tasks.spawn(request, context);
        const replay = await second.tasks.stopAll('root', 'same-batch');
        expect(replay.map(({ taskId }) => taskId)).toEqual(originalTargets);
      });
      await vi.waitFor(() =>
        expect(second.tasks.snapshot('root').at(-1)?.status).toBe('completed'),
      );
      if (stage === 'already-stopping')
        expect(second.tasks.snapshot('root')[0]?.reason).toBe('parent-stop');
      expect(
        (await second.original.read('root')).filter(
          ({ type }) => type === 'agent.tasks.stop-requested',
        ),
      ).toMatchObject([{ payload: { operationId: 'same-batch', taskIds: originalTargets } }]);
    },
  );

  it('remembers original stop-all targets after the batch append and its readback both lose acknowledgement', async () => {
    let readUnavailable = false;
    const { tasks, original, onSpawn } = setup({
      async append(store, id, events) {
        const written = await store.append(id, events);
        if (events.some(({ type }) => type === 'agent.tasks.stop-requested')) {
          readUnavailable = true;
          throw new Error('Stop batch acknowledgement lost');
        }
        return written;
      },
      async read(store, id) {
        if (readUnavailable && id === 'root')
          throw new Error('Root prefix temporarily unavailable');
        return store.read(id);
      },
    });
    await onSpawn(async (context) => {
      await expect(tasks.stopAll('root', 'lost-batch')).rejects.toMatchObject({
        code: 'agent-task-persistence-error',
      });
      readUnavailable = false;
      await tasks.spawn(request, context);
      await expect(tasks.stopAll('root', 'lost-batch')).resolves.toEqual([]);
    });
    await vi.waitFor(() => expect(tasks.snapshot('root').at(-1)?.status).toBe('completed'));
    expect(
      (await original.read('root')).filter(({ type }) => type === 'agent.tasks.stop-requested'),
    ).toHaveLength(1);
  });

  it.each(['create', 'attach'] as const)(
    'checks the synchronous fence immediately before the %s effect',
    async (effect) => {
      let checkpoints = 0;
      const { tasks, original, attached, creates, onSpawn } = setup({
        afterCheckpointCheck(lifetime) {
          if (++checkpoints === (effect === 'create' ? 1 : 2))
            queueMicrotask(() => lifetime.requestStop('generation-revoked'));
        },
      });
      await onSpawn(async (context) => {
        await tasks.spawn(request, context);
      });
      await vi.waitFor(() => expect(tasks.snapshot('root')[0]?.status).toBe('cancelled'));
      expect(creates).toHaveLength(effect === 'create' ? 0 : 1);
      expect(attached.size).toBe(0);
      expect((await original.read('root')).at(-1)).toMatchObject({
        type: 'agent.task.settled',
        payload: { settlement: { reason: 'generation-revoked' } },
      });
    },
  );

  it('keeps the launch behind a cancellation intent being durably written', async () => {
    const enteredAttach = deferred();
    const allowAttach = deferred();
    const committedIntent = deferred();
    const acknowledgeIntent = deferred();
    const { tasks, starts, onSpawn } = setup({
      async beforeAttach() {
        enteredAttach.resolve();
        await allowAttach.promise;
      },
      async append(actual, id, events) {
        const written = await actual.append(id, events);
        if (events.some(({ type }) => type === 'agent.task.cancel-requested')) {
          committedIntent.resolve();
          await acknowledgeIntent.promise;
        }
        return written;
      },
    });
    try {
      await onSpawn(async (context) => {
        await tasks.spawn(request, context);
      });
      await enteredAttach.promise;
      const cancel = tasks.requestCancel(
        'root',
        [tasks.snapshot('root')[0]!.taskId],
        'stop',
        'parent-stop',
      );
      await committedIntent.promise;
      allowAttach.resolve();
      // Let the attach continuation reach child admission while persistence is paused.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      acknowledgeIntent.resolve();
      await cancel;
      await vi.waitFor(() => expect(tasks.snapshot('root')[0]?.status).toBe('cancelled'));
      expect(starts).toEqual([]);
    } finally {
      allowAttach.resolve();
      acknowledgeIntent.resolve();
    }
  });

  it('cleans up an exact child after acknowledgement is lost outside the launch port', async () => {
    const { tasks, starts, releases, onSpawn } = setup({
      afterLaunch() {
        throw new Error('Host acknowledgement lost');
      },
    });
    await onSpawn(async (context) => {
      await tasks.spawn(request, context);
    });
    await vi.waitFor(() => expect(tasks.snapshot('root')[0]?.status).toBe('completed'));
    expect(starts).toHaveLength(1);
    expect(releases).toEqual(starts);
  });

  it('permanently fences a confirmed foreign Project relation across retry', async () => {
    let conflict = true;
    const { tasks, original, creates, starts, releases, onSpawn } = setup({
      relation: (attached) => (conflict ? 'conflict' : attached ? 'attached' : 'unattached'),
    });
    await onSpawn(async (context) => {
      await tasks.spawn(request, context);
    });
    await vi.waitFor(() => expect(tasks.snapshot('root')[0]?.status).toBe('blocked'));
    const [accepted] = await acceptedFacts(original);
    expect(await original.read(accepted!.payload.childSessionId)).toEqual([]);
    conflict = false;
    await tasks.retry('root');
    await vi.waitFor(() =>
      expect(tasks.snapshot('root')[0]).toMatchObject({
        status: 'failed',
        reason: 'preparation-failed',
      }),
    );
    expect(creates).toEqual([]);
    expect(starts).toEqual([]);
    expect(releases).toEqual([accepted!.payload.childSessionId]);
  });

  it('reconciles committed-but-thrown parent acceptance, child creation, attachment and dispatch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'weave-task-saga-'));
    teardown.push(() => rm(directory, { recursive: true, force: true }));
    const store = createSqliteSessionEventStore({ filename: join(directory, 'sessions.sqlite') });
    const { tasks, original, starts, creates, onSpawn } = setup({
      store,
      async append(actual, id, events) {
        const result = await actual.append(id, events);
        if (
          events.some((event) =>
            ['agent.task.accepted', 'agent.task.dispatched', 'execution.claimed'].includes(
              event.type,
            ),
          )
        )
          throw new Error('Acknowledgement lost');
        return result;
      },
      afterCreate() {
        throw new Error('Create acknowledgement lost');
      },
      afterAttach() {
        throw new Error('Attach acknowledgement lost');
      },
    });
    await onSpawn(async (context) => {
      await tasks.spawn(request, context);
    });
    await vi.waitFor(() =>
      expect(tasks.snapshot('root')[0]).toMatchObject({
        status: 'completed',
        resultKind: 'final-answer',
        preview: 'Reviewed.',
      }),
    );
    const events = await original.read('root');
    expect(events.filter((event) => event.type === 'agent.task.accepted')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'agent.task.dispatched')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'agent.task.settled')).toHaveLength(1);
    expect(starts).toEqual(creates);
    expect(starts).toHaveLength(1);
  });

  it('retains the original acceptance and reservation until the parent can be read', async () => {
    let parentReadBlocked = false;
    const { tasks, original, creates, reserves, contexts, onSpawn } = setup({
      async append(actual, id, events) {
        const result = await actual.append(id, events);
        if (events.some(({ type }) => type === 'agent.task.accepted')) {
          parentReadBlocked = true;
          throw new Error('Acceptance acknowledgement lost');
        }
        return result;
      },
      async read(actual, id) {
        if (id === 'root' && parentReadBlocked) throw new Error('Parent unavailable');
        return actual.read(id);
      },
    });
    await onSpawn(async (context) => {
      await expect(tasks.spawn(request, context)).rejects.toMatchObject({
        code: 'agent-task-persistence-error',
      });
      await expect(tasks.spawn(request, context)).rejects.toMatchObject({
        code: 'agent-task-persistence-error',
      });
      expect(creates).toEqual([]);
      expect(reserves).toHaveLength(1);
    });
    const [accepted] = await acceptedFacts(original);
    expect(accepted).toBeDefined();
    parentReadBlocked = false;
    // The exact former Pipeline object may replay its own receipt. A shape copy never can.
    await expect(tasks.spawn(request, { ...contexts[0]! })).rejects.toMatchObject({
      code: 'agent-task-not-permitted',
    });
    const receipt = await tasks.spawn(request, contexts[0]!);
    expect(receipt).toMatchObject({
      taskId: accepted!.payload.taskId,
      childSessionId: accepted!.payload.childSessionId,
    });
    await vi.waitFor(() => expect(tasks.snapshot('root')[0]?.status).toBe('completed'));
    expect(creates).toEqual(reserves);
    expect(await acceptedFacts(original)).toHaveLength(1);
  });

  it('reconciles the original child acceptance after an unknown read without relaunching it', async () => {
    let unknownChild: string | undefined;
    const { tasks, original, creates, starts, onSpawn } = setup({
      async append(actual, id, events) {
        const result = await actual.append(id, events);
        if (events.some(({ type }) => type === 'execution.claimed')) {
          unknownChild = id;
          throw new Error('Child acceptance acknowledgement lost');
        }
        return result;
      },
      async read(actual, id) {
        if (id === unknownChild) throw new Error('Child unavailable');
        return actual.read(id);
      },
    });
    await onSpawn(async (context) => {
      await tasks.spawn(request, context);
    });
    await vi.waitFor(() => expect(tasks.snapshot('root')[0]?.status).toBe('blocked'));
    const childId = unknownChild!;
    expect(starts).toEqual([]);
    expect(
      (await original.read(childId)).filter(({ type }) => type === 'execution.accepted'),
    ).toHaveLength(1);
    unknownChild = undefined;
    await tasks.retry('root');
    await vi.waitFor(() => expect(tasks.snapshot('root')[0]?.status).toBe('completed'));
    expect(creates).toEqual([childId]);
    expect(starts).toEqual([childId]);
    expect(
      (await original.read(childId)).filter(({ type }) => type === 'execution.accepted'),
    ).toHaveLength(1);
  });

  it('releases a pre-start failure after its terminal acknowledgement and readback are lost', async () => {
    let revoked = false;
    let unavailableChild: string | undefined;
    const { tasks, original, releases, starts, onSpawn } = setup({
      onStartCheck() {
        if (revoked) throw new Error('Retained Generation no longer admits starts');
      },
      async append(actual, id, events) {
        const result = await actual.append(id, events);
        if (events.some(({ type }) => type === 'execution.claimed')) revoked = true;
        if (id !== 'root' && events.some(({ type }) => type === 'execution.finished')) {
          unavailableChild = id;
          throw new Error('Terminal acknowledgement lost');
        }
        return result;
      },
      async read(actual, id) {
        if (id === unavailableChild) throw new Error('Child unavailable');
        return actual.read(id);
      },
    });
    await onSpawn(async (context) => {
      await tasks.spawn(request, context);
    });
    await vi.waitFor(() => expect(tasks.snapshot('root')[0]?.status).toBe('blocked'));
    const childId = unavailableChild!;
    expect((await original.read(childId)).at(-1)).toMatchObject({
      type: 'execution.finished',
      payload: { status: 'failed', reason: 'generation-unavailable' },
    });
    expect(releases).toEqual([]);
    unavailableChild = undefined;
    await tasks.retry('root');
    await vi.waitFor(() =>
      expect(tasks.snapshot('root')[0]).toMatchObject({
        status: 'failed',
        reason: 'generation-unavailable',
      }),
    );
    expect(releases).toEqual([childId]);
    expect(starts).toEqual([]);
  });

  it('preserves an already durable child cancellation when a parent stop arrives before settlement', async () => {
    const childStarted = deferred();
    const committedTerminal = deferred();
    const acknowledgeTerminal = deferred();
    const { tasks, original, execution, releases, onSpawn } = setup({
      async beforeChild(signal) {
        childStarted.resolve();
        await new Promise<void>((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
      async append(actual, id, events) {
        const result = await actual.append(id, events);
        if (id !== 'root' && events.some(({ type }) => type === 'execution.finished')) {
          committedTerminal.resolve();
          await acknowledgeTerminal.promise;
        }
        return result;
      },
    });
    try {
      await onSpawn(async (context) => {
        await tasks.spawn(request, context);
      });
      await childStarted.promise;
      const { taskId, childSessionId, childExecutionId } = tasks.snapshot('root')[0]!;
      await execution.cancel(childSessionId, childExecutionId);
      await committedTerminal.promise;
      expect((await original.read(childSessionId)).at(-1)).toMatchObject({
        type: 'execution.finished',
        payload: { status: 'cancelled', reason: 'task-cancelled' },
      });
      await tasks.requestCancel('root', [taskId], 'late-stop', 'parent-stop');
      acknowledgeTerminal.resolve();
      await vi.waitFor(() =>
        expect(tasks.snapshot('root')[0]).toMatchObject({
          status: 'cancelled',
          reason: 'task-cancelled',
        }),
      );
      expect(releases).toEqual([childSessionId]);
    } finally {
      acknowledgeTerminal.resolve();
    }
  });

  it('closes an exact open Turn after its terminal writes fail and storage recovers', async () => {
    let blockTerminal = true;
    const { tasks, execution, original, starts, releases, onSpawn } = setup({
      async append(actual, id, events) {
        if (id !== 'root' && blockTerminal && events.some(({ type }) => type === 'turn.completed'))
          throw new Error('Child Turn terminal writes unavailable');
        return actual.append(id, events);
      },
    });
    await onSpawn(async (context) => {
      await tasks.spawn(request, context);
    });
    await vi.waitFor(() => expect(tasks.snapshot('root')[0]?.status).toBe('blocked'));
    const childId = tasks.snapshot('root')[0]!.childSessionId;
    expect((await original.read(childId)).at(-1)?.type).toBe('step.started');
    expect(releases).toEqual([]);
    blockTerminal = false;
    await tasks.retry('root');
    await vi.waitFor(() =>
      expect(tasks.snapshot('root')[0]).toMatchObject({
        status: 'interrupted',
        reason: 'child-interrupted',
      }),
    );
    expect(releases).toEqual([childId]);
    expect(starts).toEqual([childId]);
    expect((await original.read(childId)).slice(-3).map(({ type }) => type)).toEqual([
      'step.completed',
      'turn.completed',
      'execution.finished',
    ]);
    await expect(execution.drain()).resolves.toBeUndefined();
  });

  it('releases actual resources before a failed parent settlement while keeping root capacity', async () => {
    let blockSettlement = true;
    const { tasks, original, reserves, releases, onSpawn } = setup({
      async append(actual, id, events) {
        if (blockSettlement && events.some(({ type }) => type === 'agent.task.settled'))
          throw new Error('Parent settlement write rejected');
        return actual.append(id, events);
      },
    });
    await onSpawn(
      async (context, index) => {
        if (index < 4) {
          await tasks.spawn(request, context);
        } else {
          await vi.waitFor(() => expect(releases).toHaveLength(4));
          await expect(tasks.spawn(request, context)).rejects.toMatchObject({
            code: 'agent-task-capacity',
          });
        }
      },
      { count: 5 },
    );
    expect(reserves).toHaveLength(4);
    expect(tasks.snapshot('root').map(({ status }) => status)).toEqual(Array(4).fill('blocked'));
    expect(
      (await original.read('root')).filter(({ type }) => type === 'agent.task.settled'),
    ).toHaveLength(0);
    blockSettlement = false;
    await tasks.retry('root');
    await vi.waitFor(() =>
      expect(tasks.snapshot('root').map(({ status }) => status)).toEqual(
        Array(4).fill('completed'),
      ),
    );
    expect(releases).toEqual(reserves);
    await onSpawn(async (context) => {
      await tasks.spawn(request, context);
    });
    expect(reserves).toHaveLength(5);
  });

  it('enforces sixteen accepted children per parent Turn after earlier children settle', async () => {
    const { tasks, original, reserves, onSpawn } = setup();
    await onSpawn(
      async (context, index) => {
        if (index === 16) {
          await expect(tasks.spawn(request, context)).rejects.toMatchObject({
            code: 'agent-task-capacity',
          });
        } else {
          const receipt = await tasks.spawn(request, context);
          await vi.waitFor(
            () =>
              expect(
                tasks.snapshot('root').find(({ taskId }) => taskId === receipt.taskId)?.status,
              ).toBe('completed'),
            { interval: 5 },
          );
        }
      },
      { count: 17 },
    );
    expect(await acceptedFacts(original)).toHaveLength(16);
    expect(reserves).toHaveLength(16);
  });

  it('enforces sixteen live children across distinct roots before retaining another Generation pin', async () => {
    const allowCreate = deferred();
    const { tasks, original, reserves, onSpawn } = setup({
      beforeCreate: () => allowCreate.promise,
    });
    try {
      for (let i = 0; i < 4; i++) {
        await onSpawn(
          async (context) => {
            await tasks.spawn(request, context);
          },
          { root: `root-${i}`, count: 4 },
        );
      }
      await onSpawn(
        async (context) => {
          await expect(tasks.spawn(request, context)).rejects.toMatchObject({
            code: 'agent-task-capacity',
          });
        },
        { root: 'fifth-root' },
      );
      expect(reserves).toHaveLength(16);
      expect(await acceptedFacts(original, 'fifth-root')).toHaveLength(0);
    } finally {
      allowCreate.resolve();
    }
  });

  it('rejects an invalid invocation or unavailable Project before child creation', async () => {
    const { tasks, original, creates, starts, onSpawn } = setup({ projectAvailable: false });
    await onSpawn(async (context) => {
      await expect(
        tasks.spawn({ ...request, rootSessionId: 'forged' }, context),
      ).rejects.toMatchObject({ code: 'agent-task-invalid-input' });
      await expect(tasks.spawn(request, { ...context })).rejects.toMatchObject({
        code: 'agent-task-not-permitted',
      });
      await expect(tasks.spawn(request, context)).rejects.toMatchObject({
        code: 'agent-task-not-permitted',
      });
    });
    expect(await acceptedFacts(original)).toHaveLength(0);
    expect(creates).toEqual([]);
    expect(starts).toEqual([]);
  });
});
