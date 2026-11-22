import { describe, expect, it } from 'vitest';
import {
  createInMemorySessionEventStore,
  projectSession,
  type SessionEventStore,
} from '@weave/session';
import type { LlmClient } from '@weave/llm';
import type { StreamEvent } from '@weave/protocol';
import {
  createAgentExecutionService,
  createAgentRunner,
  type AgentExecutionInput,
} from '../src/index.js';

const input: AgentExecutionInput = {
  userMessage: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  provider: 'mock',
  model: 'test',
  permissionMode: 'ask',
};
const launch = { requestId: 'request', input };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function terminal(
  service: ReturnType<typeof createAgentExecutionService>,
  sessionId: string,
  executionId: string,
) {
  const subscription = await service.subscribe(sessionId, executionId);
  for (const frame of subscription.initial)
    if (
      frame.type === 'snapshot' &&
      ['completed', 'failed', 'cancelled', 'interrupted', 'persistence-error'].includes(
        frame.snapshot.status,
      )
    )
      return frame.snapshot;
  for await (const frame of subscription.events) {
    if (
      frame.type === 'status' &&
      ['completed', 'failed', 'cancelled', 'interrupted', 'persistence-error'].includes(
        frame.status,
      )
    )
      return service.get(sessionId, executionId);
  }
  return service.get(sessionId, executionId);
}

async function setup(llm: LlmClient, store: SessionEventStore = createInMemorySessionEventStore()) {
  await store.append('session', [{ type: 'session.created', payload: {} }]);
  const service = createAgentExecutionService({
    runner: createAgentRunner({ sessionStore: store, llm }),
    sessionStore: store,
    admit: async () => {},
  });
  return { store, service };
}

describe('owned Agent executions', () => {
  it('recovers unfinished accepted Turns and steps without executing the Runner', async () => {
    const store = createInMemorySessionEventStore();
    await store.append('session', [
      { type: 'session.created', payload: {} },
      {
        type: 'execution.accepted',
        payload: {
          executionId: 'execution',
          requestId: 'request',
          requestDigest: 'a'.repeat(64),
          turnId: 'turn',
          userMessageId: 'user',
          input,
        },
      },
      { type: 'message.created', payload: { messageId: 'user', message: input.userMessage } },
      {
        type: 'turn.started',
        payload: { turnId: 'turn', userMessageId: 'user', executionId: 'execution' },
      },
      { type: 'step.started', payload: { turnId: 'turn', stepId: 'step', kind: 'model' } },
    ]);
    const service = createAgentExecutionService({
      sessionStore: store,
      admit: async () => {},
      runner: {
        run() {
          throw new Error('Recovery must never execute');
        },
      },
    });
    await service.recover(['session']);
    await service.recover(['session']);
    expect((await service.get('session', 'execution')).status).toBe('interrupted');
    expect(projectSession(await store.read('session')).turns).toMatchObject([
      { status: 'failed', reason: 'server-restarted', steps: [{ status: 'failed' }] },
    ]);
    expect((await store.read('session')).slice(-3).map((event) => event.type)).toEqual([
      'step.completed',
      'turn.completed',
      'execution.finished',
    ]);
    expect(await service.withSessionIdle('session', async () => 'idle')).toBe('idle');
  });

  it('never confirms terminal state when the Runner terminal append fails', async () => {
    const base = createInMemorySessionEventStore();
    const store: SessionEventStore = {
      ...base,
      append: (sessionId, events) =>
        events.some((event) => event.type === 'turn.completed')
          ? Promise.reject(new Error('disk failed'))
          : base.append(sessionId, events),
    };
    const { service } = await setup(
      {
        async *stream(): AsyncIterable<StreamEvent> {
          yield { type: 'text-delta', text: 'shown' };
          throw new Error('provider failed');
        },
      },
      store,
    );
    const receipt = await service.launch('session', launch);
    expect((await terminal(service, 'session', receipt.executionId)).status).toBe(
      'persistence-error',
    );
    expect((await base.read('session')).some((event) => event.type === 'execution.finished')).toBe(
      false,
    );
    await expect(service.withSessionIdle('session', async () => {})).rejects.toMatchObject({
      code: 'execution-busy',
    });
    await expect(service.drain()).rejects.toMatchObject({ code: 'execution-persistence-error' });
  });

  it('rejects oversized initial snapshots before durable acceptance', async () => {
    const { service, store } = await setup({
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: 'finish', reason: 'stop' };
      },
    });
    await expect(
      service.launch('session', {
        requestId: 'large',
        input: {
          ...input,
          userMessage: {
            role: 'user',
            content: [{ type: 'text', text: 'x'.repeat(8 * 1024 * 1024) }],
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'execution-output-limit' });
    expect((await store.read('session')).map((event) => event.type)).toEqual(['session.created']);
  });

  it('preserves already published frames when snapshots coalesce deltas and atomically hands off to new events', async () => {
    const next = deferred<void>();
    const finish = deferred<void>();
    const produced = deferred<void>();
    const { service } = await setup({
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: 'text-delta', text: 'a' };
        produced.resolve();
        await next.promise;
        yield { type: 'text-delta', text: 'b' };
        await finish.promise;
        yield { type: 'finish', reason: 'stop' };
      },
    });
    const receipt = await service.launch('session', launch);
    await produced.promise;
    const snapshot = await service.get('session', receipt.executionId);
    const subscription = await service.subscribe('session', receipt.executionId, receipt.cursor);
    const replay = subscription.initial.filter(
      (frame) => frame.type === 'event' && frame.event.type === 'text-delta',
    );
    expect(replay).toMatchObject([{ event: { text: 'a' } }]);
    const handoff = await service.subscribe('session', receipt.executionId, snapshot.cursor);
    expect(handoff.initial).toEqual([]);
    next.resolve();
    expect(await handoff.events[Symbol.asyncIterator]().next()).toMatchObject({
      value: { type: 'event', event: { type: 'text-delta', text: 'b' } },
    });
    expect(replay).toMatchObject([{ event: { text: 'a' } }]);
    expect(
      (await service.get('session', receipt.executionId)).events.filter(
        (event) => event.type === 'text-delta',
      ),
    ).toEqual([{ type: 'text-delta', text: 'ab' }]);
    subscription.close();
    handoff.close();
    finish.resolve();
    await terminal(service, 'session', receipt.executionId);
  });

  it('uses a snapshot when bounded replay exceeds the subscriber budget and isolates slow subscribers', async () => {
    const release = deferred<void>();
    const produced = deferred<void>();
    const finish = deferred<void>();
    const { service } = await setup({
      async *stream(): AsyncIterable<StreamEvent> {
        await release.promise;
        for (let index = 0; index < 100; index++)
          yield { type: index % 2 ? 'text-delta' : 'reasoning-delta', text: String(index) };
        produced.resolve();
        await finish.promise;
        yield { type: 'finish', reason: 'stop' };
      },
    });
    const receipt = await service.launch('session', launch);
    const slow = await service.subscribe('session', receipt.executionId);
    release.resolve();
    await produced.promise;
    expect(await slow.events[Symbol.asyncIterator]().next()).toMatchObject({ done: true });
    const reconnect = await service.subscribe('session', receipt.executionId, receipt.cursor);
    expect(reconnect.initial).toMatchObject([{ type: 'snapshot' }]);
    reconnect.close();
    expect((await service.get('session', receipt.executionId)).status).toBe('running');
    finish.resolve();
    await terminal(service, 'session', receipt.executionId);
  });

  it('does not publish completed before execution.finished is durably appended', async () => {
    const base = createInMemorySessionEventStore();
    const writing = deferred<void>();
    const release = deferred<void>();
    const store: SessionEventStore = {
      ...base,
      async append(sessionId, events) {
        if (events.some((event) => event.type === 'execution.finished')) {
          writing.resolve();
          await release.promise;
        }
        return base.append(sessionId, events);
      },
    };
    const { service } = await setup(
      {
        async *stream(): AsyncIterable<StreamEvent> {
          yield { type: 'finish', reason: 'stop' };
        },
      },
      store,
    );
    const receipt = await service.launch('session', launch);
    await writing.promise;
    const during = await service.get('session', receipt.executionId);
    expect(during.status).toBe('running');
    expect(during.events.some((event) => event.type === 'completed')).toBe(false);
    const subscription = await service.subscribe('session', receipt.executionId, during.cursor);
    release.resolve();
    const frames = [];
    for await (const frame of subscription.events) frames.push(frame);
    expect(frames).toMatchObject([
      { type: 'event', event: { type: 'completed' } },
      { type: 'status', status: 'completed', durableThroughSequence: expect.any(Number) },
    ]);
  });

  it('stops production at the complete live output bound and persists all yielded partial bytes', async () => {
    const abortObserved = deferred<void>();
    const { service, store } = await setup({
      async *stream(_request, options): AsyncIterable<StreamEvent> {
        for (let index = 0; index < 5000; index++) {
          if (options?.signal?.aborted) {
            abortObserved.resolve();
            throw options.signal.reason;
          }
          yield { type: index % 2 ? 'text-delta' : 'reasoning-delta', text: 'x' };
        }
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) resolve();
          else options?.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        abortObserved.resolve();
        throw options?.signal?.reason;
      },
    });
    const receipt = await service.launch('session', launch);
    await abortObserved.promise;
    const done = await terminal(service, 'session', receipt.executionId);
    expect(done.error?.code).toBe('execution-output-limit');
    expect(done.status).toBe('cancelled');
    const assistant = projectSession(await store.read('session')).messages.find(
      ({ message }) => message.role === 'assistant',
    );
    expect(
      assistant?.message.content.reduce(
        (total, part) => total + (part.type === 'image' ? 0 : part.text.length),
        0,
      ),
    ).toBeGreaterThanOrEqual(4096);
  });

  it('replays after recovery before current admission and does not rerun a completed Turn', async () => {
    const { service, store } = await setup({
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: 'finish', reason: 'stop' };
      },
    });
    const first = await service.launch('session', launch);
    await terminal(service, 'session', first.executionId);
    const restarted = createAgentExecutionService({
      sessionStore: store,
      admit: async () => {
        throw new Error('Now archived');
      },
      runner: {
        run() {
          throw new Error('Must not rerun');
        },
      },
    });
    await restarted.recover(['session']);
    expect(await restarted.launch('session', launch)).toMatchObject({
      executionId: first.executionId,
      status: 'completed',
      events: [],
    });
    expect(
      (await store.read('session')).filter((event) => event.type === 'turn.started'),
    ).toHaveLength(1);
  });

  it('closes admission synchronously and drains cancellation before resolving', async () => {
    const { service, store } = await setup({
      async *stream(_request, options): AsyncIterable<StreamEvent> {
        yield { type: 'text-delta', text: 'partial' };
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(new DOMException('Aborted', 'AbortError'));
          if (options?.signal?.aborted) abort();
          else options?.signal?.addEventListener('abort', abort, { once: true });
        });
      },
    });
    const receipt = await service.launch('session', launch);
    service.closeSync();
    await expect(service.launch('other-session', launch)).rejects.toMatchObject({
      code: 'execution-closed',
    });
    await service.drain();
    await service.drain();
    expect((await service.get('session', receipt.executionId)).status).toBe('cancelled');
    expect((await store.read('session')).at(-1)?.type).toBe('execution.finished');
  });

  it('does not count terminal bookkeeping against the live output cap', async () => {
    const { service } = await setup({
      async *stream(): AsyncIterable<StreamEvent> {
        // context is the first compacted event; this fills the remaining live slots.
        for (let index = 0; index < 4095; index++)
          yield { type: index % 2 ? 'text-delta' : 'reasoning-delta', text: 'x' };
        yield { type: 'finish', reason: 'stop' };
      },
    });
    const receipt = await service.launch('session', launch);
    const subscription = await service.subscribe('session', receipt.executionId);
    const frames = [];
    for await (const frame of subscription.events) frames.push(frame);
    expect(
      frames.some(
        (frame) => frame.type === 'status' && frame.error?.code === 'execution-output-limit',
      ),
    ).toBe(false);
    const done = await service.get('session', receipt.executionId);
    expect(done.status).toBe('completed');
    expect(done.error).toBeUndefined();
  });

  it('accepts before producing and completes without a subscriber with stable identities', async () => {
    let acceptedAtModelStart = false;
    const store = createInMemorySessionEventStore();
    const { service } = await setup(
      {
        async *stream(): AsyncIterable<StreamEvent> {
          acceptedAtModelStart = (await store.read('session')).some(
            (event) => event.type === 'execution.accepted',
          );
          yield { type: 'text-delta', text: 'answer' };
          yield { type: 'finish', reason: 'stop' };
        },
      },
      store,
    );
    const receipt = await service.launch('session', launch);
    const done = await terminal(service, 'session', receipt.executionId);
    expect(acceptedAtModelStart).toBe(true);
    expect(done).toMatchObject({
      status: 'completed',
      turnId: receipt.turnId,
      userMessageId: receipt.userMessageId,
    });
    const events = await store.read('session');
    expect(events.at(-1)).toMatchObject({
      type: 'execution.finished',
      sequence: done.durableThroughSequence,
    });
    expect(projectSession(events).turns[0]?.turnId).toBe(receipt.turnId);
    expect(projectSession(events).messages[0]?.messageId).toBe(receipt.userMessageId);
    expect((await service.get('session', receipt.executionId)).events).toEqual([]);
  });

  it('replays the same accepted request after response loss and rejects conflicts or a second active execution', async () => {
    const release = deferred<void>();
    const { service, store } = await setup({
      async *stream(): AsyncIterable<StreamEvent> {
        await release.promise;
        yield { type: 'finish', reason: 'stop' };
      },
    });
    const first = await service.launch('session', launch);
    const second = await service.launch('session', { input: { ...input }, requestId: 'request' });
    expect(second.executionId).toBe(first.executionId);
    await expect(
      service.launch('session', { requestId: 'request', input: { ...input, model: 'different' } }),
    ).rejects.toMatchObject({ code: 'execution-request-conflict' });
    await expect(
      service.launch('session', { ...launch, requestId: 'other' }),
    ).rejects.toMatchObject({ code: 'execution-busy' });
    await expect(service.withSessionIdle('session', async () => 'archived')).rejects.toMatchObject({
      code: 'execution-busy',
    });
    expect(
      (await store.read('session')).filter((event) => event.type === 'execution.accepted'),
    ).toHaveLength(1);
    release.resolve();
    await terminal(service, 'session', first.executionId);
  });

  it('detaches subscriptions without cancelling and Stop durably retains partial output once', async () => {
    const started = deferred<void>();
    const { service, store } = await setup({
      async *stream(_request, options): AsyncIterable<StreamEvent> {
        yield { type: 'reasoning-delta', text: 'think' };
        yield { type: 'text-delta', text: 'partial' };
        started.resolve();
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(new DOMException('Aborted', 'AbortError'));
          if (options?.signal?.aborted) abort();
          else options?.signal?.addEventListener('abort', abort, { once: true });
        });
      },
    });
    const receipt = await service.launch('session', launch);
    const subscription = await service.subscribe('session', receipt.executionId);
    subscription.close();
    await started.promise;
    expect((await service.get('session', receipt.executionId)).status).toBe('running');
    await service.cancel('session', receipt.executionId);
    expect((await terminal(service, 'session', receipt.executionId)).status).toBe('cancelled');
    expect(
      projectSession(await store.read('session')).messages.map(({ message }) => message),
    ).toEqual([
      input.userMessage,
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'think' },
          { type: 'text', text: 'partial' },
        ],
      },
    ]);
  });
});
