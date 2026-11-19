import { describe, expect, it } from 'vitest';
import {
  createInMemorySessionEventStore,
  createSessionProjectionCache,
  projectSession,
  type SessionEventStore,
} from '../src/index.js';

/** Wraps a Store to record the `afterSequence` each read requested. */
function recordingReads(inner: SessionEventStore): {
  readonly store: SessionEventStore;
  readonly afterSequences: (number | undefined)[];
} {
  const afterSequences: (number | undefined)[] = [];
  const store: SessionEventStore = {
    append: (sessionId, events) => inner.append(sessionId, events),
    read: (sessionId, options) => {
      afterSequences.push(options?.afterSequence);
      return inner.read(sessionId, options);
    },
    close: () => inner.close(),
  };
  return { store, afterSequences };
}

describe('Session projection cache', () => {
  it('matches projectSession for the full log', async () => {
    const store = createInMemorySessionEventStore();
    await store.append('s', [
      { type: 'session.created', payload: { title: 'Demo' } },
      {
        type: 'message.created',
        payload: {
          messageId: 'm1',
          message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        },
      },
      { type: 'turn.started', payload: { turnId: 't1' } },
      { type: 'step.started', payload: { turnId: 't1', stepId: 'st1', kind: 'model' } },
      { type: 'step.completed', payload: { turnId: 't1', stepId: 'st1', status: 'completed' } },
      { type: 'turn.completed', payload: { turnId: 't1', status: 'completed' } },
    ]);

    const cache = createSessionProjectionCache(store);
    const cached = await cache.project('s');
    const direct = projectSession(await store.read('s'));

    expect(cached).toEqual(direct);
  });

  it('reads only new events after the first projection', async () => {
    const { store, afterSequences } = recordingReads(createInMemorySessionEventStore());
    await store.append('s', [
      { type: 'session.created', payload: { title: 'Demo' } },
      { type: 'turn.started', payload: { turnId: 't1' } },
    ]);
    const cache = createSessionProjectionCache(store);

    const first = await cache.project('s');
    expect(first?.lastSequence).toBe(2);

    await store.append('s', [
      { type: 'step.started', payload: { turnId: 't1', stepId: 'st1', kind: 'model' } },
    ]);
    const second = await cache.project('s');
    expect(second?.lastSequence).toBe(3);

    // First projection reads from zero; the second resumes at the last sequence.
    expect(afterSequences).toEqual([0, 2]);
  });

  it('returns undefined for a session with no events', async () => {
    const store = createInMemorySessionEventStore();
    const cache = createSessionProjectionCache(store);
    expect(await cache.project('missing')).toBeUndefined();
  });

  it('throws and drops the entry when the log becomes invalid', async () => {
    const store = createInMemorySessionEventStore();
    await store.append('s', [{ type: 'session.created', payload: { title: 'A' } }]);
    const cache = createSessionProjectionCache(store);
    expect((await cache.project('s'))?.title).toBe('A');

    // A second session.created is illegal and must drop the cached state.
    await store.append('s', [{ type: 'session.created', payload: { title: 'B' } }]);
    await expect(cache.project('s')).rejects.toMatchObject({
      code: 'session-projection-invalid-order',
    });
    // The dropped entry re-reads from zero and reproduces the same error.
    await expect(cache.project('s')).rejects.toMatchObject({
      code: 'session-projection-invalid-order',
    });
  });

  it('evicts least-recently-used sessions beyond maxEntries', async () => {
    const { store, afterSequences } = recordingReads(createInMemorySessionEventStore());
    for (const id of ['a', 'b', 'c']) {
      await store.append(id, [{ type: 'session.created', payload: { title: id } }]);
    }
    const cache = createSessionProjectionCache(store, { maxEntries: 2 });

    await cache.project('a'); // [a]
    await cache.project('b'); // [a, b]
    await cache.project('a'); // touch -> [b, a]
    await cache.project('c'); // insert -> evict b -> [a, c]
    afterSequences.length = 0;

    await cache.project('a'); // still cached, resumes at its last sequence
    await cache.project('b'); // evicted, re-reads from zero
    expect(afterSequences).toEqual([1, 0]);
  });

  it('serializes concurrent projections of the same session', async () => {
    const store = createInMemorySessionEventStore();
    await store.append('s', [{ type: 'session.created', payload: { title: 'A' } }]);
    const cache = createSessionProjectionCache(store);
    await cache.project('s'); // cache at sequence 1

    await store.append('s', [{ type: 'turn.started', payload: { turnId: 't1' } }]); // sequence 2
    const results = await Promise.all([cache.project('s'), cache.project('s'), cache.project('s')]);

    for (const result of results) {
      expect(result?.lastSequence).toBe(2);
    }
  });
});
