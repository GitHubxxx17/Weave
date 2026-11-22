import { describe, expect, it } from 'vitest';
import { createInMemorySessionEventStore, type SessionEventStore } from '@weave/session';
import type { StreamEvent } from '@weave/protocol';
import {
  createAgentExecutionService,
  createAgentRunner,
  type AgentExecutionInput,
} from '../src/index.js';
const input: AgentExecutionInput = {
  userMessage: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  provider: 'mock',
  model: 'model',
  permissionMode: 'ask',
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function fixture(mode: 'after' | 'before' | 'unreadable' = 'after') {
  const base = createInMemorySessionEventStore();
  await base.append('s', [{ type: 'session.created', payload: {} }]);
  let fails: string | undefined;
  let unreadable = false;
  const finish = deferred();
  const started = deferred();
  let runs = 0;
  const store: SessionEventStore = {
    ...base,
    async read(s, o) {
      if (unreadable) throw new Error('unreadable');
      return base.read(s, o);
    },
    async append(s, events) {
      if (events.some((e) => e.type === fails)) {
        fails = undefined;
        if (mode !== 'before') await base.append(s, events);
        if (mode === 'unreadable') unreadable = true;
        throw new Error('append error');
      }
      return base.append(s, events);
    },
  };
  const service = createAgentExecutionService({
    sessionStore: store,
    admit: async () => {},
    runner: createAgentRunner({
      sessionStore: store,
      llm: {
        async *stream(_request, options): AsyncIterable<StreamEvent> {
          runs++;
          started.resolve();
          yield { type: 'text-delta', text: 'answer' };
          await Promise.race([
            finish.promise,
            new Promise<void>((_, no) => {
              if (options?.signal?.aborted) no(options.signal.reason);
              else
                options?.signal?.addEventListener('abort', () => no(options.signal?.reason), {
                  once: true,
                });
            }),
          ]);
          yield { type: 'finish', reason: 'stop' };
        },
      },
    }),
  });
  const send = (id: string) => service.launch('s', { requestId: id, input });
  const settle = async (id: string) => {
    for (let i = 0; i < 100; i++) {
      const value = await service.get('s', id);
      if (['completed', 'failed', 'cancelled', 'persistence-error'].includes(value.status))
        return value;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error('not settled');
  };
  return {
    base,
    store,
    service,
    send,
    settle,
    finish,
    started,
    fail(type: string) {
      fails = type;
    },
    readable() {
      unreadable = false;
    },
    runs: () => runs,
  };
}

describe('queue persistence uncertainty', () => {
  it('reconciles accepted, reorder, queued cancel and terminal facts committed before append throws', async () => {
    const f = await fixture();
    f.fail('execution.accepted');
    const a = await f.send('a');
    await f.started.promise;
    const b = await f.send('b');
    const c = await f.send('c');
    f.fail('execution.queue-reordered');
    const q = await f.service.reorderQueue('s', {
      requestId: 'r',
      expectedRevision: (await f.service.queue('s')).revision,
      executionIds: [c.executionId, b.executionId],
    });
    f.fail('execution.finished');
    await f.service.cancelQueued('s', b.executionId, {
      requestId: 'cancel',
      expectedRevision: q.revision,
    });
    f.fail('execution.finished');
    f.finish.resolve();
    expect((await f.settle(a.executionId)).status).toBe('completed');
    expect((await f.settle(c.executionId)).status).toBe('completed');
    expect(f.runs()).toBe(2);
    const events = await f.base.read('s');
    for (const id of [a.executionId, b.executionId, c.executionId])
      expect(
        events.filter((e) => e.type === 'execution.finished' && e.payload.executionId === id),
      ).toHaveLength(1);
    expect((await f.send('a')).executionId).toBe(a.executionId);
  });
  it('reconciles a durable claim before invoking the Runner once', async () => {
    const f = await fixture();
    const a = await f.send('a');
    await f.started.promise;
    const b = await f.send('b');
    f.fail('execution.claimed');
    f.finish.resolve();
    await f.settle(a.executionId);
    expect((await f.settle(b.executionId)).status).toBe('completed');
    expect(f.runs()).toBe(2);
    expect(
      (await f.base.read('s')).filter(
        (e) => e.type === 'execution.claimed' && e.payload.executionId === b.executionId,
      ),
    ).toHaveLength(1);
  });
  it('releases confirmed noncommitted acceptance capacity and allows the same exact retry', async () => {
    const f = await fixture('before');
    await f.send('a');
    await f.started.promise;
    for (let i = 0; i < 9; i++) await f.send(`queued${i}`);
    f.fail('execution.accepted');
    await expect(f.send('last')).rejects.toMatchObject({ code: 'execution-persistence-error' });
    expect((await f.send('last')).status).toBe('queued');
    await expect(f.send('overflow')).rejects.toMatchObject({ code: 'execution-queue-full' });
    f.service.closeSync();
    await f.service.drain();
  });
  it('blocks unresolved admission and lifecycle mutations when reconciliation cannot read', async () => {
    const f = await fixture('unreadable');
    await f.send('a');
    await f.started.promise;
    f.fail('execution.accepted');
    await expect(f.send('b')).rejects.toMatchObject({ code: 'execution-admission-uncertain' });
    f.readable();
    const q = await f.service.queue('s');
    expect(q.scheduler).toBe('blocked');
    expect(q.queued).toHaveLength(1);
    await expect(f.send('c')).rejects.toMatchObject({ code: 'execution-persistence-error' });
    await expect(f.service.withSessionIdle('s', async () => {})).rejects.toMatchObject({
      code: 'execution-busy',
    });
    f.service.closeSync();
    await expect(f.service.drain()).rejects.toMatchObject({ code: 'execution-persistence-error' });
  });
  it('uses a larger initial replacement cursor after idle state eviction and reconnect', async () => {
    const f = await fixture();
    const sub = await f.service.subscribeQueue('s');
    const initial = sub.initial[0]!.cursor;
    sub.close();
    const again = await f.service.subscribeQueue('s');
    expect(Number(again.initial[0]!.cursor.split(':')[2])).toBeGreaterThan(
      Number(initial.split(':')[2]),
    );
    again.close();
    const a = await f.send('a');
    await f.started.promise;
    f.finish.resolve();
    await f.settle(a.executionId);
    const reopened = await f.service.subscribeQueue('s');
    expect(Number(reopened.initial[0]!.cursor.split(':')[2])).toBeGreaterThan(
      Number(initial.split(':')[2]),
    );
    reopened.close();
  });
  it('restores an already durable Turn terminal instead of replacing it with interrupted', async () => {
    const f = await fixture();
    const a = await f.send('a');
    await f.started.promise;
    f.finish.resolve();
    await f.settle(a.executionId);
    const copy = createInMemorySessionEventStore();
    await copy.append(
      's',
      (await f.base.read('s'))
        .filter((e) => e.type !== 'execution.finished')
        .map(({ type, payload }) => ({ type, payload })),
    );
    const recovered = createAgentExecutionService({
      sessionStore: copy,
      admit: async () => {},
      runner: {
        run() {
          throw new Error('never');
        },
      },
    });
    await recovered.recover(['s']);
    expect((await recovered.get('s', a.executionId)).status).toBe('completed');
  });
  it('returns the new revision for a persisted empty reorder instead of an evicted fallback view', async () => {
    const f = await fixture();
    const q = await f.service.queue('s');
    const reordered = await f.service.reorderQueue('s', {
      requestId: 'empty',
      expectedRevision: q.revision,
      executionIds: [],
    });
    expect(reordered.revision).toBeGreaterThan(q.revision);
    expect((await f.service.queue('s')).revision).toBe(reordered.revision);
  });
  it.each([
    { ...input, model: 'changed', useProviderDefaults: false },
    { ...input, useProviderDefaults: true },
    { ...input, permissionMode: 'yolo', useProviderDefaults: false },
  ])('rejects a resolver that changes immutable input %#', async (value) => {
    const base = createInMemorySessionEventStore();
    const service = createAgentExecutionService({
      sessionStore: base,
      admit: async () => {},
      runner: {
        run() {
          throw new Error('never');
        },
      },
      resolveInput: async () => value as AgentExecutionInput,
    });
    await expect(service.launch('s', { requestId: 'bad', input })).rejects.toMatchObject({
      code: 'execution-invalid-input',
    });
    expect(await base.read('s')).toEqual([]);
  });
});

describe('terminal projection safety', () => {
  it('retains the confirmed terminal outcome when a later queue read fails', async () => {
    const base = createInMemorySessionEventStore();
    await base.append('s', [{ type: 'session.created', payload: {} }]);
    let failRead = false;
    const store: SessionEventStore = {
      ...base,
      async read(s, o) {
        if (failRead) {
          failRead = false;
          throw new Error('later read failed');
        }
        return base.read(s, o);
      },
      async append(s, events) {
        const appended = await base.append(s, events);
        if (events.some((e) => e.type === 'execution.finished')) failRead = true;
        return appended;
      },
    };
    const done = deferred();
    const started = deferred();
    const service = createAgentExecutionService({
      sessionStore: store,
      admit: async () => {},
      runner: createAgentRunner({
        sessionStore: store,
        llm: {
          async *stream(): AsyncIterable<StreamEvent> {
            started.resolve();
            await done.promise;
            yield { type: 'finish', reason: 'stop' };
          },
        },
      }),
    });
    const a = await service.launch('s', { requestId: 'a', input });
    await started.promise;
    const sub = await service.subscribe('s', a.executionId);
    done.resolve();
    for await (const frame of sub.events) {
      if (frame.type === 'status') expect(frame.status).not.toBe('persistence-error');
    }
    // The terminal and queue removal can be projected from the confirmed append;
    // no follow-up Store read is needed to establish that durable state.
    const queueSub = await service.subscribeQueue('s').catch(() => undefined);
    if (queueSub !== undefined) {
      expect(queueSub.initial[0]?.active).toBeNull();
      expect(queueSub.initial[0]?.scheduler).toBe('ready');
      queueSub.close();
    }
    const q = await service.queue('s');
    expect(q.active).toBeNull();
    expect(q.scheduler).toBe('ready');
  });
});

describe('shutdown claim barrier', () => {
  it('never starts a claimed item if closeSync occurs while its durable claim is committing', async () => {
    const base = createInMemorySessionEventStore();
    await base.append('s', [{ type: 'session.created', payload: {} }]);
    const entered = deferred();
    const releaseClaim = deferred();
    let claims = 0;
    let runs = 0;
    const finish = deferred();
    const started = deferred();
    const store: SessionEventStore = {
      ...base,
      async append(s, events) {
        if (events.some((e) => e.type === 'execution.claimed') && ++claims === 2) {
          entered.resolve();
          await releaseClaim.promise;
        }
        return base.append(s, events);
      },
    };
    const service = createAgentExecutionService({
      sessionStore: store,
      admit: async () => {},
      runner: createAgentRunner({
        sessionStore: store,
        llm: {
          async *stream(): AsyncIterable<StreamEvent> {
            runs++;
            started.resolve();
            await finish.promise;
            yield { type: 'finish', reason: 'stop' };
          },
        },
      }),
    });
    await service.launch('s', { requestId: 'a', input });
    await started.promise;
    const b = await service.launch('s', { requestId: 'b', input });
    finish.resolve();
    await entered.promise;
    service.closeSync();
    releaseClaim.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runs).toBe(1);
    // Drain settles the accepted claim without another provider/model invocation.
    await service.drain();
    expect(runs).toBe(1);
    expect((await service.get('s', b.executionId)).status).toBe('cancelled');
  });
});

describe('ambiguous admission replay', () => {
  it('adopts the durable owner once when exact retry resolves an unreadable committed idle acceptance', async () => {
    const f = await fixture('unreadable');
    f.fail('execution.accepted');
    await expect(f.send('a')).rejects.toMatchObject({ code: 'execution-admission-uncertain' });
    expect(f.runs()).toBe(0);
    f.readable();
    const retried = await f.send('a');
    await f.started.promise;
    expect((await f.send('a')).executionId).toBe(retried.executionId);
    expect(f.runs()).toBe(1);
    expect((await f.service.queue('s')).scheduler).toBe('ready');
    f.finish.resolve();
    expect((await f.settle(retried.executionId)).status).toBe('completed');
  });
});

describe('closed ambiguous admission replay', () => {
  it('settles a resolved acceptance without installing a new owner after drain already completed', async () => {
    const f = await fixture('unreadable');
    f.fail('execution.accepted');
    await expect(f.send('a')).rejects.toMatchObject({ code: 'execution-admission-uncertain' });
    f.service.closeSync();
    await expect(f.service.drain()).rejects.toMatchObject({ code: 'execution-persistence-error' });
    f.readable();
    const replay = await f.send('a');
    expect(replay.status).toBe('cancelled');
    expect(f.runs()).toBe(0);
    expect((await f.service.queue('s')).active).toBeNull();
  });
});
