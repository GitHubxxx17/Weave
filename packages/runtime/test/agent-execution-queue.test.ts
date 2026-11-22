import { describe, expect, it } from 'vitest';
import {
  createInMemorySessionEventStore,
  projectSession,
  type SessionEventStore,
} from '@weave/session';
import type { StreamEvent } from '@weave/protocol';
import {
  createAgentExecutionService,
  createAgentRunner,
  type AgentExecutionInput,
  agentExecutionQueueSnapshotSchema,
} from '../src/index.js';

const input: AgentExecutionInput = {
  userMessage: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  provider: 'mock',
  model: 'model',
  permissionMode: 'ask',
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function setup(store: SessionEventStore = createInMemorySessionEventStore()) {
  await store.append('s', [{ type: 'session.created', payload: {} }]);
  const starts: string[] = [];
  const finishes = new Map<string, ReturnType<typeof deferred<void>>>();
  const started = new Map<string, ReturnType<typeof deferred<void>>>();
  const llm = {
    async *stream(
      request: {
        messages: readonly { role: string; content: readonly { type: string; text?: string }[] }[];
      },
      options?: { signal?: AbortSignal },
    ): AsyncIterable<StreamEvent> {
      const last = request.messages.filter((message) => message.role === 'user').at(-1);
      const text = last?.content.find((part) => part.type === 'text')?.text ?? '';
      starts.push(text);
      started.get(text)?.resolve();
      yield { type: 'text-delta', text: `answer:${text}` };
      await Promise.race([
        finishes.get(text)?.promise ?? Promise.resolve(),
        new Promise<void>((_yes, no) => {
          if (options?.signal?.aborted) no(options.signal.reason);
          else
            options?.signal?.addEventListener('abort', () => no(options.signal?.reason), {
              once: true,
            });
        }),
      ]);
      yield { type: 'finish', reason: 'stop' };
    },
  };
  const service = createAgentExecutionService({
    runner: createAgentRunner({ sessionStore: store, llm }),
    sessionStore: store,
    admit: async () => {},
  });
  const send = async (text: string, sessionId = 's') => {
    finishes.set(text, deferred());
    started.set(text, deferred());
    return service.launch(sessionId, {
      requestId: text,
      input: { ...input, userMessage: { role: 'user', content: [{ type: 'text', text }] } },
    });
  };
  const settle = async (id: string, sessionId = 's') => {
    for (let attempt = 0; attempt < 500; attempt++) {
      const item = await service.get(sessionId, id);
      if (
        ['completed', 'failed', 'cancelled', 'interrupted', 'persistence-error'].includes(
          item.status,
        )
      )
        return item;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error('Execution did not settle');
  };
  return { store, service, send, starts, finishes, started, settle };
}

describe('durable Session FIFO', () => {
  it('accepts while busy, retains only metadata views, and advances without subscribers', async () => {
    const f = await setup();
    const a = await f.send('a');
    await f.started.get('a')?.promise;
    const b = await f.send('b');
    const c = await f.send('c');
    expect(b.status).toBe('queued');
    expect(b.events).toEqual([]);
    expect(f.starts).toEqual(['a']);
    const queue = await f.service.queue('s');
    expect(queue.active?.executionId).toBe(a.executionId);
    expect(queue.queued.map((item) => item.executionId)).toEqual([b.executionId, c.executionId]);
    expect(JSON.stringify(queue)).not.toContain('"userMessage":');
    expect(
      projectSession(await f.store.read('s')).messages.filter(
        (item) => item.message.role === 'user',
      ),
    ).toHaveLength(1);
    f.finishes.get('a')?.resolve();
    await f.started.get('b')?.promise;
    expect(f.starts).toEqual(['a', 'b']);
    f.finishes.get('b')?.resolve();
    await f.started.get('c')?.promise;
    f.finishes.get('c')?.resolve();
    expect((await f.settle(c.executionId)).status).toBe('completed');
    expect((await f.service.queue('s')).queued).toEqual([]);
  });

  it('reorders exact membership and replays controls before revision checks, then cancels without a Turn', async () => {
    const f = await setup();
    await f.send('a');
    await f.started.get('a')?.promise;
    const b = await f.send('b');
    const c = await f.send('c');
    const before = await f.service.queue('s');
    const operation = {
      requestId: 'move',
      expectedRevision: before.revision,
      executionIds: [c.executionId, b.executionId],
    };
    const moved = await f.service.reorderQueue('s', operation);
    await expect(
      f.service.reorderQueue('s', { ...operation, requestId: 'stale' }),
    ).rejects.toMatchObject({ code: 'execution-queue-conflict' });
    const cancel = { requestId: 'remove', expectedRevision: moved.revision };
    await f.service.cancelQueued('s', b.executionId, cancel);
    expect(
      (await f.service.reorderQueue('s', operation)).queued.map((item) => item.executionId),
    ).toEqual([c.executionId]);
    expect((await f.service.cancelQueued('s', b.executionId, cancel)).queued).toHaveLength(1);
    await expect(f.service.cancelQueued('s', c.executionId, cancel)).rejects.toMatchObject({
      code: 'execution-request-conflict',
    });
    await expect(f.service.cancel('s', c.executionId)).rejects.toMatchObject({
      code: 'execution-not-active',
    });
    expect((await f.service.get('s', b.executionId)).status).toBe('cancelled');
    f.finishes.get('a')?.resolve();
    await f.started.get('c')?.promise;
    await expect(
      f.service.cancelQueued('s', c.executionId, {
        requestId: 'late',
        expectedRevision: (await f.service.queue('s')).revision,
      }),
    ).rejects.toMatchObject({ code: 'execution-not-queued' });
    f.finishes.get('c')?.resolve();
    await f.settle(c.executionId);
    expect(projectSession(await f.store.read('s')).turns).toHaveLength(2);
    const restarted = createAgentExecutionService({
      runner: {
        run() {
          throw new Error('no run');
        },
      },
      sessionStore: f.store,
      admit: async () => {
        throw new Error('archived');
      },
    });
    await restarted.recover(['s']);
    expect((await restarted.cancelQueued('s', b.executionId, cancel)).queued).toEqual([]);
  });

  it('Stop preserves the waiting queue and releases only after durable iterator settlement', async () => {
    const f = await setup();
    const a = await f.send('a');
    await f.started.get('a')?.promise;
    const b = await f.send('b');
    await f.service.cancel('s', a.executionId);
    await f.started.get('b')?.promise;
    expect((await f.settle(a.executionId)).status).toBe('cancelled');
    expect(
      projectSession(await f.store.read('s')).messages.some(
        (item) => item.message.role === 'assistant',
      ),
    ).toBe(true);
    f.finishes.get('b')?.resolve();
    await f.settle(b.executionId);
  });

  it('enforces pending capacity excluding active and serializes cross-Session global races', async () => {
    const f = await setup();
    await Promise.all(
      Array.from({ length: 10 }, async (_, s) => {
        const sessionId = `s${s}`;
        await f.store.append(sessionId, [{ type: 'session.created', payload: {} }]);
        await f.send(`active${s}`, sessionId);
        for (let i = 0; i < 10; i++) await f.send(`queued${s}-${i}`, sessionId);
      }),
    );
    await expect(f.send('over-session', 's0')).rejects.toMatchObject({
      code: 'execution-queue-full',
    });
    await f.store.append('idle', [{ type: 'session.created', payload: {} }]);
    const idle = await f.send('idle-active', 'idle');
    expect(idle.status).toBe('accepted');
    await expect(f.send('over-global', 'idle')).rejects.toMatchObject({
      code: 'execution-queue-full',
    });
    f.service.closeSync();
    await f.service.drain();
    expect(f.starts.length).toBeLessThanOrEqual(11);
    expect((await f.service.queue('s0')).queued).toEqual([]);
  });

  it('freezes only effective sampling at admission and resolves original request replay first', async () => {
    const f = await setup();
    let temperature = 0.2;
    let resolves = 0;
    const requests: unknown[] = [];
    const runner = createAgentRunner({
      sessionStore: f.store,
      llm: {
        async *stream(request): AsyncIterable<StreamEvent> {
          requests.push(request);
          yield { type: 'finish', reason: 'stop' };
        },
      },
    });
    const service = createAgentExecutionService({
      runner,
      sessionStore: f.store,
      admit: async () => {},
      resolveInput: async (_s, value) => {
        resolves++;
        return { ...value, temperature, maxTokens: 10, useProviderDefaults: false };
      },
    });
    const first = await service.launch('s', { requestId: 'freeze', input });
    temperature = 0.8;
    expect((await service.launch('s', { requestId: 'freeze', input })).executionId).toBe(
      first.executionId,
    );
    expect(resolves).toBe(1);
    await service.drain();
    const accepted = (await f.store.read('s')).find((item) => item.type === 'execution.accepted');
    expect(accepted).toMatchObject({
      payload: { input, runInput: { temperature: 0.2, maxTokens: 10, useProviderDefaults: false } },
    });
    expect(requests.length).toBeLessThanOrEqual(1);
  });

  it('recovers every queued and claimed execution as interrupted without starting Runner', async () => {
    const f = await setup();
    const a = await f.send('a');
    await f.started.get('a')?.promise;
    const b = await f.send('b');
    const copied = createInMemorySessionEventStore();
    await copied.append(
      's',
      (await f.store.read('s')).map(({ type, payload }) => ({ type, payload })),
    );
    const restarted = createAgentExecutionService({
      sessionStore: copied,
      admit: async () => {},
      runner: {
        run() {
          throw new Error('Never rerun');
        },
      },
    });
    await restarted.recover(['s']);
    expect((await restarted.get('s', a.executionId)).status).toBe('interrupted');
    expect((await restarted.get('s', b.executionId)).status).toBe('interrupted');
    expect((await restarted.queue('s')).queued).toEqual([]);
    f.service.closeSync();
    await f.service.drain();
  });

  it('publishes replacement queue snapshots and keeps only the latest for slow listeners', async () => {
    const f = await setup();
    await f.send('a');
    await f.started.get('a')?.promise;
    const sub = await f.service.subscribeQueue('s');
    const b = await f.send('b');
    const c = await f.send('c');
    const frame = await sub.events[Symbol.asyncIterator]().next();
    expect(frame.value?.queued.map((item) => item.executionId)).toEqual([
      b.executionId,
      c.executionId,
    ]);
    expect(frame.value?.cursor).not.toBe(sub.initial[0]?.cursor);
    sub.close();
    f.service.closeSync();
    await f.service.drain();
  });

  it('blocks the Session after terminal persistence failure instead of claiming the next input', async () => {
    const base = createInMemorySessionEventStore();
    const store: SessionEventStore = {
      ...base,
      append: (s, events) =>
        events.some((e) => e.type === 'execution.finished')
          ? Promise.reject(new Error('disk failed'))
          : base.append(s, events),
    };
    const f = await setup(store);
    const a = await f.send('a');
    await f.started.get('a')?.promise;
    const b = await f.send('b');
    f.finishes.get('a')?.resolve();
    expect((await f.settle(a.executionId)).status).toBe('persistence-error');
    expect((await f.service.queue('s')).scheduler).toBe('blocked');
    expect(f.starts).toEqual(['a']);
    await expect(f.service.withSessionIdle('s', async () => {})).rejects.toMatchObject({
      code: 'execution-busy',
    });
    expect((await f.service.get('s', b.executionId)).status).toBe('queued');
    await expect(f.service.drain()).rejects.toMatchObject({ code: 'execution-persistence-error' });
  });
});

describe('queue dispatch boundaries', () => {
  it('continues after ordinary provider failure and dispatches separate Sessions concurrently', async () => {
    const store = createInMemorySessionEventStore();
    for (const id of ['s', 'other'])
      await store.append(id, [{ type: 'session.created', payload: {} }]);
    const release = deferred<void>();
    const firstStarted = deferred<void>();
    const otherStarted = deferred<void>();
    let runs = 0;
    const service = createAgentExecutionService({
      sessionStore: store,
      admit: async () => {},
      runner: createAgentRunner({
        sessionStore: store,
        llm: {
          async *stream(request): AsyncIterable<StreamEvent> {
            const text = request.messages
              .filter((message) => message.role === 'user')
              .at(-1)
              ?.content.find((part) => part.type === 'text');
            runs++;
            if (text?.type === 'text' && text.text === 'other') {
              otherStarted.resolve();
              await release.promise;
            } else if (runs === 1) {
              firstStarted.resolve();
              await release.promise;
              throw new Error('ordinary failure');
            }
            yield { type: 'finish', reason: 'stop' };
          },
        },
      }),
    });
    const first = await service.launch('s', { requestId: 'first', input });
    await firstStarted.promise;
    const second = await service.launch('s', { requestId: 'second', input });
    const other = await service.launch('other', {
      requestId: 'other',
      input: {
        ...input,
        userMessage: { role: 'user', content: [{ type: 'text', text: 'other' }] },
      },
    });
    await otherStarted.promise;
    expect(runs).toBe(2);
    release.resolve();
    for (let i = 0; i < 100; i++) {
      if ((await service.get('s', second.executionId)).status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect((await service.get('s', first.executionId)).status).toBe('failed');
    expect((await service.get('s', second.executionId)).status).toBe('completed');
    expect((await service.get('other', other.executionId)).status).toBe('completed');
  });

  it('allows exactly one competing submission at the last global pending slot', async () => {
    const f = await setup();
    for (let s = 0; s < 10; s++) {
      const id = `s${s}`;
      await f.store.append(id, [{ type: 'session.created', payload: {} }]);
      await f.send(`active-${s}`, id);
      for (let q = 0; q < (s < 8 ? 10 : s === 8 ? 10 : 9); q++)
        await f.send(`pending-${s}-${q}`, id);
    }
    // s9 has one per-Session slot, and a second active Session may compete globally.
    await f.store.append('competitor', [{ type: 'session.created', payload: {} }]);
    await f.send('competing-active', 'competitor');
    const attempts = await Promise.allSettled([
      f.send('last-s9', 's9'),
      f.send('last-competitor', 'competitor'),
    ]);
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((result) => result.status === 'rejected')).toMatchObject([
      { reason: { code: 'execution-queue-full' } },
    ]);
    f.service.closeSync();
    await f.service.drain();
  });
});

describe('queue wire bounds', () => {
  it('validates queue replacement cursors for encoded long Unicode Session IDs', async () => {
    const f = await setup();
    const id = '汉'.repeat(240);
    await f.store.append(id, [{ type: 'session.created', payload: {} }]);
    const q = await f.service.queue(id);
    expect(agentExecutionQueueSnapshotSchema.safeParse(q).success).toBe(true);
    const sub = await f.service.subscribeQueue(id);
    expect(agentExecutionQueueSnapshotSchema.safeParse(sub.initial[0]).success).toBe(true);
    sub.close();
  });
  it('exposes captured effective sampling without duplicating accepted content', async () => {
    const f = await setup();
    const service = createAgentExecutionService({
      sessionStore: f.store,
      admit: async () => {},
      runner: {
        run() {
          throw new Error('not needed');
        },
      },
      resolveInput: async (_s, value) => ({
        ...value,
        temperature: 0.3,
        maxTokens: 123,
        useProviderDefaults: false,
      }),
    });
    const receipt = await service.launch('s', { requestId: 'sampling', input });
    expect(receipt).toMatchObject({
      input,
      effectiveSettings: { temperature: 0.3, maxTokens: 123, useProviderDefaults: false },
    });
    expect(Object.keys(receipt).filter((key) => key === 'input')).toHaveLength(1);
    await service.drain();
  });
});

describe('queue settlement publication', () => {
  it.each(['completed', 'failed', 'cancelled'] as const)(
    'publishes a durable %s removal before claiming the next item',
    async (outcome) => {
      const base = createInMemorySessionEventStore();
      const firstStarted = deferred<void>();
      const settleFirst = deferred<void>();
      const claimingNext = deferred<void>();
      const releaseClaim = deferred<void>();
      let claims = 0;
      let calls = 0;
      const store: SessionEventStore = {
        ...base,
        async append(sessionId, events) {
          if (events.some((event) => event.type === 'execution.claimed') && ++claims === 2) {
            claimingNext.resolve();
            await releaseClaim.promise;
          }
          return base.append(sessionId, events);
        },
      };
      await store.append('s', [{ type: 'session.created', payload: {} }]);
      const service = createAgentExecutionService({
        sessionStore: store,
        admit: async () => {},
        runner: createAgentRunner({
          sessionStore: store,
          llm: {
            async *stream(_request, options): AsyncIterable<StreamEvent> {
              if (++calls === 1) {
                firstStarted.resolve();
                yield { type: 'text-delta', text: 'partial' };
                await settleFirst.promise;
                options?.signal?.throwIfAborted();
                if (outcome === 'failed') throw new Error('provider failure');
                yield { type: 'finish', reason: 'stop' };
              } else {
                await new Promise<void>((_resolve, reject) => {
                  if (options?.signal?.aborted) reject(options.signal.reason);
                  else
                    options?.signal?.addEventListener(
                      'abort',
                      () => reject(options.signal?.reason),
                      { once: true },
                    );
                });
              }
            },
          },
        }),
      });
      const first = await service.launch('s', { requestId: 'first', input });
      await firstStarted.promise;
      const next = await service.launch('s', { requestId: 'next', input });
      const subscription = await service.subscribeQueue('s');
      const iterator = subscription.events[Symbol.asyncIterator]();
      if (outcome === 'cancelled') {
        await service.cancel('s', first.executionId);
        expect((await iterator.next()).value?.active?.status).toBe('cancelling');
      }
      // Install a pending read before settlement so latest-only buffering cannot
      // replace an inconsistent intermediate publication with a later valid view.
      const pendingSettlement = iterator.next();
      settleFirst.resolve();
      const settled = (await pendingSettlement).value;
      await claimingNext.promise;
      const finished = (await base.read('s')).find(
        (event) =>
          event.type === 'execution.finished' && event.payload.executionId === first.executionId,
      );
      expect(finished).toMatchObject({ type: 'execution.finished', payload: { status: outcome } });
      expect(settled?.active).toBeNull();
      expect(settled?.revision).toBe(finished?.sequence);
      expect(settled?.queued.map((entry) => entry.executionId)).toEqual([next.executionId]);
      releaseClaim.resolve();
      let claimed = settled;
      for (let count = 0; count < 5 && claimed?.active?.executionId !== next.executionId; count++) {
        claimed = (await iterator.next()).value;
      }
      const claim = (await base.read('s')).find(
        (event) =>
          event.type === 'execution.claimed' && event.payload.executionId === next.executionId,
      );
      expect(claimed?.active).toMatchObject({ executionId: next.executionId });
      expect(['accepted', 'running', 'cancelling', 'persistence-error']).toContain(
        claimed?.active?.status,
      );
      expect(claimed?.revision).toBe(claim?.sequence);
      subscription.close();
      service.closeSync();
      await service.drain();
    },
  );
});
