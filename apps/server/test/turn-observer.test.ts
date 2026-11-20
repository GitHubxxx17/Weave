import { describe, expect, it, vi } from 'vitest';
import type { TurnEndInfo, TurnInfo } from '@weave/plugin';
import { createInMemorySessionEventStore } from '@weave/session';
import { observeTurns, type TurnObserver } from '../src/turn-observer.js';

const sessionId = 'session-1';

function recordingObserver() {
  const calls: Array<['start', TurnInfo] | ['end', TurnEndInfo]> = [];
  const observer: TurnObserver = {
    start: async (info) => {
      calls.push(['start', info]);
    },
    end: async (info) => {
      calls.push(['end', info]);
    },
  };
  return { calls, observer };
}

describe('observeTurns', () => {
  it('announces a turn start only after it is durable', async () => {
    const store = createInMemorySessionEventStore();
    const seenWhenAnnounced: string[] = [];
    const observed = observeTurns(store, {
      start: async () => {
        seenWhenAnnounced.push(...(await store.read(sessionId)).map((event) => event.type));
      },
      end: async () => undefined,
    });

    await observed.append(sessionId, [{ type: 'turn.started', payload: { turnId: 'turn-1' } }]);

    expect(seenWhenAnnounced).toEqual(['turn.started']);
  });

  it('announces how a turn ended, with its reason when there is one', async () => {
    const { calls, observer } = recordingObserver();
    const observed = observeTurns(createInMemorySessionEventStore(), observer);

    await observed.append(sessionId, [
      { type: 'turn.completed', payload: { turnId: 'turn-1', status: 'completed' } },
      {
        type: 'turn.completed',
        payload: { turnId: 'turn-2', status: 'completed', reason: 'agent-step-limit' },
      },
      { type: 'turn.completed', payload: { turnId: 'turn-3', status: 'failed' } },
      { type: 'turn.completed', payload: { turnId: 'turn-4', status: 'cancelled' } },
    ]);

    expect(calls).toEqual([
      ['end', { sessionId, turnId: 'turn-1', status: 'completed' }],
      ['end', { sessionId, turnId: 'turn-2', status: 'completed', reason: 'agent-step-limit' }],
      ['end', { sessionId, turnId: 'turn-3', status: 'failed' }],
      ['end', { sessionId, turnId: 'turn-4', status: 'cancelled' }],
    ]);
  });

  it('announces start and end in the order the events were appended', async () => {
    const { calls, observer } = recordingObserver();
    const observed = observeTurns(createInMemorySessionEventStore(), observer);

    await observed.append(sessionId, [
      { type: 'turn.started', payload: { turnId: 'turn-1' } },
      { type: 'turn.completed', payload: { turnId: 'turn-1', status: 'completed' } },
    ]);

    expect(calls.map(([kind]) => kind)).toEqual(['start', 'end']);
  });

  it('ignores every other kind of event', async () => {
    const { calls, observer } = recordingObserver();
    const observed = observeTurns(createInMemorySessionEventStore(), observer);

    await observed.append(sessionId, [{ type: 'session.created', payload: {} }]);

    expect(calls).toEqual([]);
  });

  it('returns what the store returned and passes reads and close through', async () => {
    const store = createInMemorySessionEventStore();
    const observed = observeTurns(store, recordingObserver().observer);

    const stored = await observed.append(sessionId, [{ type: 'session.created', payload: {} }]);

    expect(stored).toHaveLength(1);
    expect(await observed.read(sessionId)).toEqual(await store.read(sessionId));
    expect(await observed.read(sessionId, { afterSequence: 1 })).toEqual([]);
    await observed.close();
    await expect(store.read(sessionId)).rejects.toMatchObject({ code: 'session-store-closed' });
  });

  it('never lets a failing observer undo or hide what was recorded', async () => {
    const store = createInMemorySessionEventStore();
    const end = vi.fn(async () => undefined);
    const observed = observeTurns(store, {
      start: async () => {
        throw new Error('observer bug');
      },
      end,
    });

    await expect(
      observed.append(sessionId, [
        { type: 'turn.started', payload: { turnId: 'turn-1' } },
        { type: 'turn.completed', payload: { turnId: 'turn-1', status: 'completed' } },
      ]),
    ).resolves.toHaveLength(2);

    expect((await store.read(sessionId)).map((event) => event.type)).toEqual([
      'turn.started',
      'turn.completed',
    ]);
    // A failing start does not stop the end from being announced.
    expect(end).toHaveBeenCalledOnce();
  });
});
