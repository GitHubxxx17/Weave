import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createInMemorySessionEventStore,
  createSqliteSessionEventStore,
  type AgentTaskAccepted,
  type SessionEventStore,
} from '@weave/session';
import type { TaskStopReason } from '@weave/protocol';
import { z } from 'zod';
import * as runtime from '../src/index.js';
import type { AgentRunner, AgentRuntimeEvent, AgentRunRequest } from '../src/index.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function task() {
  const request = { title: 'Review', prompt: 'Review the patch.', access: 'read-only' } as const;
  const taskId = randomUUID();
  const accepted: AgentTaskAccepted = {
    version: 1,
    taskId,
    rootSessionId: 'root',
    parentSessionId: 'root',
    childSessionId: randomUUID(),
    childExecutionId: randomUUID(),
    childTurnId: randomUUID(),
    childUserMessageId: randomUUID(),
    parentExecutionId: 'parent-execution',
    parentTurnId: 'parent-turn',
    parentToolCallId: 'parent-call',
    depth: 1,
    requestId: `agent-task:${taskId}`,
    requestDigest: runtime.agentTaskRequestDigest(request),
    ...request,
    settings: {
      provider: 'mock',
      model: 'test',
      temperature: 0.2,
      permissionMode: 'ask',
      useProviderDefaults: false,
    },
    tools: [],
    project: { projectId: 'project', folderRevision: 0 },
  };
  const { sessionId, requestId, ...identity } = runtime.agentTaskExecutionIdentity(accepted);
  const launch = {
    sessionId,
    requestId,
    identity,
    input: runtime.agentTaskExecutionInput(accepted),
  };
  return { accepted, sessionId, launch };
}

async function productionRunner(
  data: ReturnType<typeof task>,
  store: SessionEventStore,
): Promise<AgentRunner> {
  const registry = runtime.createToolRegistry();
  const {
    sessionId,
    launch: { identity, input },
  } = data;
  const parentIdentity = {
    sessionId: data.accepted.parentSessionId,
    executionId: data.accepted.parentExecutionId,
    turnId: data.accepted.parentTurnId,
    userMessageId: 'parent-user-message',
  };
  const { sessionId: parentSessionId, ...parentExecutionIdentity } = parentIdentity;
  let childAuthority: runtime.AgentToolAuthority | undefined;
  registry.register({
    name: 'agent_spawn',
    description: 'Start a task',
    parameters: { type: 'object' },
    inputSchema: z.strictObject({}),
    execute(_input, context) {
      childAuthority = runtime.deriveAgentToolAuthority(context, {
        identity: { sessionId, ...identity },
        access: 'read-only',
      });
      return 'accepted';
    },
  });
  let first = true;
  const parent = runtime.createAgentRunner({
    sessionStore: createInMemorySessionEventStore(),
    toolRegistry: registry,
    toolPipeline: runtime.createToolPipeline({ registry }),
    llm: {
      async *stream() {
        if (first) {
          first = false;
          yield {
            type: 'tool-call-start',
            id: data.accepted.parentToolCallId,
            name: 'agent_spawn',
          };
          yield {
            type: 'tool-call-delta',
            id: data.accepted.parentToolCallId,
            argumentsDelta: '{}',
          };
          yield { type: 'finish', reason: 'tool-call' };
        } else yield { type: 'finish', reason: 'stop' };
      },
    },
  });
  for await (const _event of parent.run({
    ...input,
    sessionId: parentSessionId,
    executionIdentity: parentExecutionIdentity,
    toolAuthority: runtime.createAgentToolAuthority({
      identity: parentIdentity,
      registry,
      ownerOf: () => 'host',
    }),
  }))
    void _event;
  if (childAuthority === undefined) throw new Error('The running parent did not derive authority');
  const child = runtime.createAgentRunner({
    sessionStore: store,
    toolRegistry: registry,
    toolPipeline: runtime.createToolPipeline({ registry }),
    llm: {
      async *stream() {
        yield { type: 'text-delta', text: 'Reviewed.' };
        yield { type: 'finish', reason: 'stop' };
      },
    },
  });
  return { run: (request) => child.run({ ...request, toolAuthority: childAuthority }) };
}

async function setup(
  options: {
    store?: SessionEventStore;
    payload?: ReturnType<typeof task>;
    runner?: AgentRunner;
    getStopReason?: () => TaskStopReason | undefined;
    assertCanStartSync?: () => void;
    release?: () => void;
    closeStarts?: (reason: TaskStopReason) => void;
    originWatermark?: number;
  } = {},
) {
  const data = options.payload ?? task();
  const store = options.store ?? createInMemorySessionEventStore();
  await store.append(data.sessionId, [
    { type: 'session.created', payload: {} },
    {
      type: 'agent.task.origin',
      payload: runtime.agentTaskOrigin(data.accepted, options.originWatermark ?? 7),
    },
  ]);
  const currentCalls: AgentRunRequest[] = [];
  const boundCalls: AgentRunRequest[] = [];
  const started = deferred();
  const currentRunner: AgentRunner = {
    run(request) {
      currentCalls.push(request);
      throw new Error('Task must use its bound runner');
    },
  };
  const makeService = () =>
    runtime.createAgentExecutionService({
      sessionStore: store,
      runner: currentRunner,
      admit: async () => {},
      resolveInput: async () => {
        throw new Error('Task has an effective input snapshot');
      },
      captureFiles: async () => {
        throw new Error('Task has no file attachments');
      },
    });
  const runner = options.runner ?? (await productionRunner(data, store));
  const service = makeService();
  const bind = () =>
    runtime.mintTaskLaunchAuthority({
      accepted: data.accepted,
      parentAcceptedSequence: 7,
      ...(options.getStopReason === undefined ? {} : { getStopReason: options.getStopReason }),
    });
  const authority = bind();
  const leaseOptions = {
    runner: {
      async *run(request: AgentRunRequest) {
        boundCalls.push(request);
        started.resolve();
        yield* runner.run(request);
      },
    },
    assertCanStartSync: options.assertCanStartSync ?? (() => {}),
    ...(options.release === undefined ? {} : { release: options.release }),
    ...(options.closeStarts === undefined ? {} : { closeStarts: options.closeStarts }),
  };
  return {
    ...data,
    store,
    service,
    makeService,
    port: runtime.getBoundTaskExecutionPort(service),
    authority,
    lease: runtime.adaptTaskRunnerLease(authority, leaseOptions),
    bind,
    leaseOptions,
    boundCalls,
    currentCalls,
    started,
  };
}

function acceptanceBarrier() {
  const base = createInMemorySessionEventStore();
  const appendEntered = deferred();
  const releaseAppend = deferred();
  let unknown = false;
  let acceptanceWrites = 0;
  const store: SessionEventStore = {
    ...base,
    async append(sessionId, events) {
      if (!events.some((event) => event.type === 'execution.accepted'))
        return base.append(sessionId, events);
      acceptanceWrites++;
      appendEntered.resolve();
      await releaseAppend.promise;
      await base.append(sessionId, events);
      throw new Error('Acceptance reply lost');
    },
    async read(sessionId, options) {
      if (unknown) throw new Error('Read reply lost');
      return base.read(sessionId, options);
    },
  };
  return {
    base,
    store,
    appendEntered,
    releaseAppend,
    setUnknown: (value: boolean) => {
      unknown = value;
    },
    acceptanceWrites: () => acceptanceWrites,
  };
}

describe('one-shot bound task execution', () => {
  it('refuses ordinary admission before the first task execution', async () => {
    const { accepted, sessionId, launch } = task();
    const store = createInMemorySessionEventStore();
    await store.append(sessionId, [
      { type: 'session.created', payload: {} },
      { type: 'agent.task.origin', payload: runtime.agentTaskOrigin(accepted, 7) },
    ]);
    const service = runtime.createAgentExecutionService({
      sessionStore: store,
      runner: {
        run() {
          throw new Error('No execution allowed');
        },
      },
      admit: async () => {},
    });
    await expect(
      service.launch(sessionId, { requestId: 'ordinary', input: launch.input }),
    ).rejects.toMatchObject({ code: 'execution-task-session-read-only' });
    expect((await store.read(sessionId)).map((event) => event.type)).toEqual([
      'session.created',
      'agent.task.origin',
    ]);
  });

  it('rejects a cloned capability, a different lease, and changed identity or input', async () => {
    expect(runtime.mintTaskLaunchAuthority).toBeTypeOf('function');
    const f = await setup();
    const otherAuthority = f.bind();
    const otherLease = runtime.adaptTaskRunnerLease(otherAuthority, f.leaseOptions);
    for (const [launch, authority, lease] of [
      [f.launch, { ...f.authority } as typeof f.authority, f.lease],
      [f.launch, f.authority, { ...f.lease } as typeof f.lease],
      [f.launch, f.authority, otherLease],
      [{ ...f.launch, requestId: 'other' }, f.authority, f.lease],
      [
        { ...f.launch, identity: { ...f.launch.identity, turnId: randomUUID() } },
        f.authority,
        f.lease,
      ],
      [{ ...f.launch, input: { ...f.launch.input, temperature: 0.3 } }, f.authority, f.lease],
    ] as const) {
      await expect(f.port.launchBoundTask(launch, authority, lease)).rejects.toMatchObject({
        code: 'execution-request-conflict',
      });
    }
    expect((await f.store.read(f.sessionId)).map((event) => event.type)).toEqual([
      'session.created',
      'agent.task.origin',
    ]);
    expect(f.boundCalls).toEqual([]);
  });

  it('rejects a child origin with a different parent acceptance watermark', async () => {
    const f = await setup({ originWatermark: 8 });
    await expect(f.port.launchBoundTask(f.launch, f.authority, f.lease)).rejects.toMatchObject({
      code: 'execution-request-conflict',
    });
    expect(await f.service.list(f.sessionId)).toEqual([]);
  });

  it('uses preallocated identity and the bound runner exactly once across concurrent launch and replay', async () => {
    const f = await setup();
    const replay = () => f.port.launchBoundTask(f.launch, f.authority, f.lease);
    const [first, second] = await Promise.all([replay(), replay()]);
    expect(first).toMatchObject(f.launch.identity);
    expect(second).toMatchObject(f.launch.identity);
    const cleanup = await f.port.whenSettled(f.authority);
    expect(cleanup).toMatchObject({
      acceptance: 'accepted',
      executionStatus: 'completed',
      launchClosed: true,
      pendingLaunches: 0,
      cleanupComplete: true,
    });
    const terminal = await replay();
    expect(terminal).toMatchObject({
      status: 'completed',
      durableThroughSequence: cleanup.acceptance === 'accepted' && cleanup.terminalSequence,
    });
    expect(await f.port.cancelBoundTask(f.authority)).toEqual(terminal);
    const differentLease = runtime.adaptTaskRunnerLease(f.authority, f.leaseOptions);
    await expect(
      f.port.launchBoundTask(f.launch, f.authority, differentLease),
    ).rejects.toMatchObject({
      code: 'execution-request-conflict',
    });
    await expect(
      f.makeService().launch(f.sessionId, { requestId: f.launch.requestId, input: f.launch.input }),
    ).rejects.toMatchObject({ code: 'execution-task-session-read-only' });
    expect(f.boundCalls).toMatchObject([
      { ...f.launch.input, executionIdentity: f.launch.identity },
    ]);
    expect(f.currentCalls).toEqual([]);
    expect(
      (await f.store.read(f.sessionId)).filter((event) => event.type === 'execution.accepted'),
    ).toHaveLength(1);
  });

  it('permanently closes admission on cancellation before launch', async () => {
    const f = await setup();
    expect(await f.port.cancelBoundTask(f.authority)).toBeUndefined();
    await expect(f.port.launchBoundTask(f.launch, f.authority, f.lease)).rejects.toMatchObject({
      code: 'execution-closed',
    });
    expect(await f.port.whenSettled(f.authority)).toMatchObject({
      acceptance: 'none',
      launchClosed: true,
      pendingLaunches: 0,
      exactAcceptanceAbsent: true,
      cleanupComplete: true,
    });
    expect(await f.service.list(f.sessionId)).toEqual([]);
    expect(f.boundCalls).toEqual([]);
  });

  it('starts only after exact commit-then-throw reconciliation', async () => {
    const barrier = acceptanceBarrier();
    const f = await setup({ store: barrier.store });
    const launch = f.port.launchBoundTask(f.launch, f.authority, f.lease);
    await barrier.appendEntered.promise;
    expect(f.boundCalls).toEqual([]);
    barrier.releaseAppend.resolve();
    await expect(launch).resolves.toMatchObject(f.launch.identity);
    await expect(f.port.whenSettled(f.authority)).resolves.toMatchObject({
      acceptance: 'accepted',
      executionStatus: 'completed',
    });
    expect(f.boundCalls).toHaveLength(1);
  });

  it('honors a host fence raised during an append before any provider or Turn', async () => {
    const barrier = acceptanceBarrier();
    let revoked = false;
    const f = await setup({
      store: barrier.store,
      getStopReason: () => (revoked ? 'generation-revoked' : undefined),
    });
    const launch = f.port.launchBoundTask(f.launch, f.authority, f.lease);
    await barrier.appendEntered.promise;
    revoked = true;
    barrier.releaseAppend.resolve();
    await expect(launch).resolves.toMatchObject({ status: 'cancelled' });
    await expect(f.port.whenSettled(f.authority)).resolves.toMatchObject({
      acceptance: 'accepted',
      executionStatus: 'cancelled',
      reason: 'generation-revoked',
    });
    expect(f.boundCalls).toEqual([]);
    expect((await barrier.base.read(f.sessionId)).map((event) => event.type)).toEqual([
      'session.created',
      'agent.task.origin',
      'execution.accepted',
      'execution.claimed',
      'execution.finished',
    ]);
  });

  it('retains an unresolved acceptance binding and never starts it after cancellation', async () => {
    const barrier = acceptanceBarrier();
    const f = await setup({ store: barrier.store });
    const launch = f.port.launchBoundTask(f.launch, f.authority, f.lease);
    await barrier.appendEntered.promise;
    barrier.setUnknown(true);
    const cancel = f.port.cancelBoundTask(f.authority);
    const cancelled = expect(cancel).rejects.toMatchObject({
      code: 'execution-admission-uncertain',
    });
    const uncertain = expect(launch).rejects.toMatchObject({
      code: 'execution-admission-uncertain',
    });
    barrier.releaseAppend.resolve();
    await uncertain;
    await cancelled;
    expect(f.boundCalls).toEqual([]);
    barrier.setUnknown(false);
    const replacementLease = runtime.adaptTaskRunnerLease(f.authority, f.leaseOptions);
    await expect(
      f.port.launchBoundTask(f.launch, f.authority, replacementLease),
    ).rejects.toMatchObject({
      code: 'execution-request-conflict',
    });
    await expect(f.port.launchBoundTask(f.launch, f.authority, f.lease)).resolves.toMatchObject({
      status: 'cancelled',
      error: { code: 'task-cancelled' },
    });
    expect(barrier.acceptanceWrites()).toBe(1);
    expect(f.boundCalls).toEqual([]);
  });

  it('reconciles an unresolved commit exactly once with the original lease', async () => {
    const barrier = acceptanceBarrier();
    const f = await setup({ store: barrier.store });
    const launch = f.port.launchBoundTask(f.launch, f.authority, f.lease);
    await barrier.appendEntered.promise;
    barrier.setUnknown(true);
    const uncertain = expect(launch).rejects.toMatchObject({
      code: 'execution-admission-uncertain',
    });
    barrier.releaseAppend.resolve();
    await uncertain;
    expect(f.boundCalls).toEqual([]);
    barrier.setUnknown(false);
    await expect(f.port.launchBoundTask(f.launch, f.authority, f.lease)).resolves.toMatchObject(
      f.launch.identity,
    );
    await expect(f.port.whenSettled(f.authority)).resolves.toMatchObject({
      acceptance: 'accepted',
      executionStatus: 'completed',
    });
    expect(barrier.acceptanceWrites()).toBe(1);
    expect(f.boundCalls).toHaveLength(1);
  });

  it('recovers a persisted task acceptance on reopen without running it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'weave-bound-task-'));
    const filename = join(directory, 'sessions.sqlite');
    const first = createSqliteSessionEventStore({ filename });
    const { accepted, sessionId, launch } = task();
    const requestDigest = runtime.agentTaskFactDigest(launch.input);
    const runner = {
      run(): never {
        throw new Error('Recovery called the runner');
      },
    };
    try {
      await first.append(sessionId, [
        { type: 'session.created', payload: {} },
        { type: 'agent.task.origin', payload: runtime.agentTaskOrigin(accepted, 7) },
        {
          type: 'execution.accepted',
          payload: {
            ...launch.identity,
            requestId: launch.requestId,
            requestDigest,
            input: launch.input,
            runInput: launch.input,
            dispatch: 'queued',
          },
        },
        { type: 'execution.claimed', payload: { executionId: launch.identity.executionId } },
      ]);
      await first.close();
      const store = createSqliteSessionEventStore({ filename });
      try {
        const service = runtime.createAgentExecutionService({
          sessionStore: store,
          runner,
          admit: async () => {},
        });
        await service.recover([sessionId]);
        await expect(
          service.launch(sessionId, { requestId: launch.requestId, input: launch.input }),
        ).rejects.toMatchObject({ code: 'execution-task-session-read-only' });
        expect(await service.get(sessionId, launch.identity.executionId)).toMatchObject({
          status: 'interrupted',
          durableThroughSequence: 5,
        });
        expect((await store.read(sessionId)).map((event) => event.type)).toEqual([
          'session.created',
          'agent.task.origin',
          'execution.accepted',
          'execution.claimed',
          'execution.finished',
        ]);
      } finally {
        await store.close();
      }
    } finally {
      await first.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('retries an unconfirmed terminal write during drain without rerunning the child', async () => {
    const base = createInMemorySessionEventStore();
    let failTerminal = true;
    const store: SessionEventStore = {
      ...base,
      async append(sessionId, events) {
        if (failTerminal && events.some((event) => event.type === 'execution.finished'))
          throw new Error('Terminal write unavailable');
        return base.append(sessionId, events);
      },
    };
    const f = await setup({ store });
    await f.port.launchBoundTask(f.launch, f.authority, f.lease);
    await expect(f.port.whenSettled(f.authority)).rejects.toMatchObject({
      code: 'execution-persistence-error',
    });
    await expect(f.service.drain()).rejects.toMatchObject({ code: 'execution-persistence-error' });
    failTerminal = false;
    await expect(f.service.drain()).resolves.toBeUndefined();
    await expect(f.port.whenSettled(f.authority)).resolves.toMatchObject({
      acceptance: 'accepted',
      executionStatus: 'completed',
    });
    expect(f.boundCalls).toHaveLength(1);
  });

  it('retries a selected pre-start terminal without reopening runner admission', async () => {
    const base = createInMemorySessionEventStore();
    let denyStart = false;
    let failTerminal = true;
    const store: SessionEventStore = {
      ...base,
      async append(sessionId, events) {
        if (events.some((event) => event.type === 'execution.claimed')) denyStart = true;
        if (failTerminal && events.some((event) => event.type === 'execution.finished'))
          throw new Error('Pre-start terminal write unavailable');
        return base.append(sessionId, events);
      },
    };
    const f = await setup({
      store,
      assertCanStartSync() {
        if (denyStart) throw new Error('Lease refused start');
      },
    });
    await expect(f.port.launchBoundTask(f.launch, f.authority, f.lease)).rejects.toMatchObject({
      code: 'execution-persistence-error',
    });
    denyStart = false;
    failTerminal = false;
    await expect(f.port.whenSettled(f.authority)).resolves.toMatchObject({
      acceptance: 'accepted',
      executionStatus: 'failed',
      reason: 'generation-unavailable',
    });
    expect(f.boundCalls).toEqual([]);
    expect(await f.port.launchBoundTask(f.launch, f.authority, f.lease)).toMatchObject({
      status: 'failed',
    });
    expect(
      (await store.read(f.sessionId)).filter(({ type }) => type === 'execution.finished'),
    ).toHaveLength(1);
  });

  it('waits for iterator cleanup and delivers frozen settlement outside the child gate', async () => {
    const cleanupStarted = deferred();
    const finishCleanup = deferred();
    let releaseCount = 0;
    const fenceCalls: TaskStopReason[] = [];
    let reason: TaskStopReason | undefined;
    const f = await setup({
      getStopReason: () => reason,
      release: () => {
        releaseCount++;
      },
      closeStarts: (stop) => {
        fenceCalls.push(stop);
      },
      runner: {
        async *run({ signal }): AsyncIterable<AgentRuntimeEvent> {
          try {
            yield { type: 'text-delta', text: 'Waiting for cancellation' };
            if (!signal?.aborted)
              await new Promise<void>((resolve) => {
                signal?.addEventListener('abort', () => resolve(), { once: true });
              });
          } finally {
            cleanupStarted.resolve();
            await finishCleanup.promise;
          }
        },
      },
    });
    await f.port.launchBoundTask(f.launch, f.authority, f.lease);
    await f.started.promise;
    let settleDelivered = false;
    const settled = f.port.whenSettled(f.authority).then(async (cleanup) => {
      settleDelivered = true;
      await f.service.withSessionIdle(f.sessionId, async () => {});
      return cleanup;
    });
    reason = 'parent-stop';
    await expect(f.port.cancelBoundTask(f.authority)).resolves.toMatchObject({
      status: 'cancelling',
    });
    await cleanupStarted.promise;
    reason = 'shutdown';
    await f.port.cancelBoundTask(f.authority);
    expect(settleDelivered).toBe(false);
    expect(releaseCount).toBe(0);
    finishCleanup.resolve();
    const cleanup = await settled;
    expect(cleanup).toMatchObject({
      acceptance: 'accepted',
      executionStatus: 'cancelled',
      reason: 'parent-stop',
    });
    expect(Object.isFrozen(cleanup)).toBe(true);
    expect(Object.isFrozen(cleanup.identity)).toBe(true);
    expect(releaseCount).toBe(1);
    expect(fenceCalls).toEqual(['parent-stop']);
    await expect(f.port.whenSettled(f.authority)).resolves.toEqual(cleanup);
  });
});
