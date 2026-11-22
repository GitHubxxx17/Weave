import { describe, expect, it } from 'vitest';
import {
  createInMemorySessionEventStore,
  projectAgentExecutionQueue,
  projectAgentExecutions,
  projectSession,
  type NewSessionEvent,
} from '../src/index.js';

const input = {
  userMessage: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  provider: 'mock',
  model: 'test',
  permissionMode: 'ask',
} as const;
const accepted = (id: string, queued = true): NewSessionEvent => ({
  type: 'execution.accepted',
  payload: {
    executionId: id,
    requestId: id,
    requestDigest: 'a'.repeat(64),
    turnId: `turn-${id}`,
    userMessageId: `user-${id}`,
    input,
    ...(queued ? { dispatch: 'queued' as const } : {}),
    runInput: { ...input, useProviderDefaults: false },
  },
});

describe('durable execution queue', () => {
  it('projects FIFO, reorder, claim and queued cancellation without conversation messages', async () => {
    const store = createInMemorySessionEventStore();
    await store.append('session', [
      { type: 'session.created', payload: {} },
      accepted('a'),
      accepted('b'),
      accepted('c'),
      { type: 'execution.claimed', payload: { executionId: 'a' } },
      {
        type: 'execution.queue-reordered',
        payload: {
          requestId: 'reorder',
          requestDigest: 'b'.repeat(64),
          expectedRevision: 5,
          executionIds: ['c', 'b'],
        },
      },
      {
        type: 'execution.finished',
        payload: {
          executionId: 'b',
          status: 'cancelled',
          reason: 'queue-cancelled',
          queueRequest: { requestId: 'cancel', requestDigest: 'c'.repeat(64), expectedRevision: 6 },
        },
      },
    ]);
    const events = await store.read('session');
    expect(projectAgentExecutionQueue(events)).toMatchObject({
      revision: 7,
      active: { executionId: 'a' },
      queued: [{ executionId: 'c' }],
    });
    expect(
      projectAgentExecutions(events).map(({ executionId, status }) => ({ executionId, status })),
    ).toEqual([
      { executionId: 'a', status: 'accepted' },
      { executionId: 'b', status: 'cancelled' },
      { executionId: 'c', status: 'queued' },
    ]);
    expect(projectSession(events).messages).toEqual([]);
  });

  it('treats legacy accepted facts as implicit claims and keeps unrelated sequence out of revision', async () => {
    const store = createInMemorySessionEventStore();
    await store.append('session', [
      accepted('old', false),
      { type: 'session.created', payload: {} },
    ]);
    expect(projectAgentExecutionQueue(await store.read('session'))).toMatchObject({
      revision: 1,
      active: { executionId: 'old' },
      queued: [],
    });
  });

  it.each(
    (
      [
        [{ type: 'execution.claimed', payload: { executionId: 'missing' } }],
        [
          accepted('a'),
          { type: 'execution.claimed', payload: { executionId: 'a' } },
          { type: 'execution.claimed', payload: { executionId: 'a' } },
        ],
        [
          accepted('a'),
          accepted('b'),
          { type: 'execution.claimed', payload: { executionId: 'b' } },
        ],
        [
          accepted('a'),
          {
            type: 'execution.queue-reordered',
            payload: {
              requestId: 'r',
              requestDigest: 'b'.repeat(64),
              expectedRevision: 1,
              executionIds: [],
            },
          },
        ],
        [
          accepted('a'),
          {
            type: 'execution.queue-reordered',
            payload: {
              requestId: 'r',
              requestDigest: 'b'.repeat(64),
              expectedRevision: 0,
              executionIds: ['a'],
            },
          },
        ],
        [
          accepted('a'),
          { type: 'execution.finished', payload: { executionId: 'a', status: 'completed' } },
        ],
        [
          accepted('a'),
          { type: 'execution.finished', payload: { executionId: 'a', status: 'cancelled' } },
          { type: 'execution.finished', payload: { executionId: 'a', status: 'cancelled' } },
        ],
      ] as readonly (readonly NewSessionEvent[])[]
    ).map((batch) => [batch]),
  )('rejects invalid phase or queue facts %#', async (batch) => {
    const store = createInMemorySessionEventStore();
    await store.append('session', batch);
    const events = await store.read('session');
    expect(() => projectAgentExecutionQueue(events)).toThrow();
  });
});

describe('queued effective-input invariant', () => {
  it.each([
    undefined,
    { ...input, useProviderDefaults: true },
    { ...input, model: 'other', useProviderDefaults: false },
    {
      ...input,
      userMessage: { role: 'user', content: [{ type: 'text', text: 'changed' }] },
      useProviderDefaults: false,
    },
  ])(
    'rejects a queued acceptance without a matching frozen effective input %#',
    async (runInput) => {
      const store = createInMemorySessionEventStore();
      const event = accepted('a');
      if (event.type !== 'execution.accepted') throw new Error('fixture');
      const { runInput: _runInput, ...payload } = event.payload;
      void _runInput;
      await expect(
        store.append('s', [
          {
            type: 'execution.accepted',
            payload: { ...payload, ...(runInput === undefined ? {} : { runInput }) },
          } as NewSessionEvent,
        ]),
      ).rejects.toMatchObject({ code: 'session-store-invalid-input' });
    },
  );
});
