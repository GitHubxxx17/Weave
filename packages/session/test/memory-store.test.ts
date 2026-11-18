import { describe, expect, it } from 'vitest';
import { createInMemorySessionEventStore, type SessionStoreError } from '../src/index.js';

describe('In-Memory Session Event Store', () => {
  it('appends events with continuous per-session sequences', async () => {
    const store = createInMemorySessionEventStore();

    const written = await store.append('session-1', [
      { type: 'session.created', payload: { title: 'Demo' } },
      { type: 'turn.started', payload: { turnId: 'turn-1' } },
    ]);

    expect(written.map((event) => event.sequence)).toEqual([1, 2]);
    expect((await store.read('session-1')).map((event) => event.type)).toEqual([
      'session.created',
      'turn.started',
    ]);

    await store.close();
  });

  it('ignores caller-supplied store-owned fields so sequences stay authoritative', async () => {
    const store = createInMemorySessionEventStore();

    await store.append('session-1', [{ type: 'session.created', payload: {} }]);
    const written = await store.append('session-1', [
      {
        type: 'session.renamed',
        payload: { title: 'x' },
        // A caller must not be able to forge these; the store overrides them.
        sequence: 99,
        eventId: 'forged',
        occurredAt: '2000-01-01T00:00:00.000Z',
        sessionId: 'other-session',
      } as never,
    ]);

    expect(written[0]?.sequence).toBe(2);
    expect(written[0]?.eventId).not.toBe('forged');
    expect(written[0]?.sessionId).toBe('session-1');
    expect(written[0]?.occurredAt).not.toBe('2000-01-01T00:00:00.000Z');

    await store.close();
  });

  it('isolates sessions and supports incremental reads', async () => {
    const store = createInMemorySessionEventStore();

    await store.append('session-1', [
      { type: 'session.created', payload: { title: 'One' } },
      { type: 'turn.started', payload: { turnId: 'turn-1' } },
    ]);
    await store.append('session-2', [{ type: 'session.created', payload: { title: 'Two' } }]);

    expect(
      (await store.read('session-1', { afterSequence: 1 })).map((event) => event.sequence),
    ).toEqual([2]);
    expect((await store.read('session-2')).map((event) => event.sequence)).toEqual([1]);

    await store.close();
  });

  it('does not change state for an empty append', async () => {
    const store = createInMemorySessionEventStore();

    expect(await store.append('session-1', [])).toEqual([]);
    expect(await store.read('session-1')).toEqual([]);

    await store.close();
  });

  it('does not expose mutable references to stored events', async () => {
    const store = createInMemorySessionEventStore();
    const [written] = await store.append('session-1', [
      { type: 'session.created', payload: { title: 'Original' } },
    ]);

    if (written === undefined || written.type !== 'session.created') {
      throw new Error('Expected a session.created event');
    }
    written.payload.title = 'Changed';

    expect((await store.read('session-1'))[0]?.payload).toEqual({ title: 'Original' });
    await store.close();
  });

  it('does not partially write an invalid batch', async () => {
    const store = createInMemorySessionEventStore();

    await expect(
      store.append('session-1', [
        { type: 'session.created', payload: { title: 'Valid' } },
        { type: 'turn.started', payload: { turnId: '' } },
      ]),
    ).rejects.toMatchObject({
      code: 'session-store-invalid-input',
    });

    expect(await store.read('session-1')).toEqual([]);
    await store.close();
  });

  it('is idempotent on close and rejects later operations', async () => {
    const store = createInMemorySessionEventStore();

    await store.close();
    await store.close();

    const appendError = await store
      .append('session-1', [])
      .catch((error: unknown) => error as SessionStoreError);
    const readError = await store
      .read('session-1')
      .catch((error: unknown) => error as SessionStoreError);

    expect(appendError).toMatchObject({ code: 'session-store-closed' });
    expect(readError).toMatchObject({ code: 'session-store-closed' });
  });
});
