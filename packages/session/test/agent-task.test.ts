import { describe, expect, it } from 'vitest';
import {
  createInMemorySessionEventStore,
  createSessionProjectionCache,
  newSessionEventSchema,
  projectSession,
  type NewSessionEvent,
} from '../src/index.js';

const parentSessionId = 'root';
const taskId = '00000000-0000-4000-8000-000000000001';
const childSessionId = '00000000-0000-4000-8000-000000000002';
const childExecutionId = '00000000-0000-4000-8000-000000000003';
const childTurnId = '00000000-0000-4000-8000-000000000004';
const childUserMessageId = '00000000-0000-4000-8000-000000000005';
const digest = 'a'.repeat(64);
const accepted = {
  version: 1,
  taskId,
  rootSessionId: parentSessionId,
  parentSessionId,
  parentExecutionId: 'execution',
  parentTurnId: 'turn',
  parentToolCallId: 'call',
  childSessionId,
  childExecutionId,
  childTurnId,
  childUserMessageId,
  depth: 1,
  requestId: `agent-task:${taskId}`,
  requestDigest: digest,
  title: 'Review',
  prompt: 'private task instruction',
  access: 'read-only',
  settings: { provider: 'mock', model: 'model', permissionMode: 'ask', useProviderDefaults: false },
  tools: [],
  project: { projectId: 'project', folderRevision: 0 },
};
const origin = {
  version: 1,
  taskId,
  rootSessionId: parentSessionId,
  parentSessionId,
  childSessionId,
  childExecutionId,
  childTurnId,
  childUserMessageId,
  parentAcceptedSequence: 2,
  parentAcceptedDigest: digest,
  admissionClass: 'agent-task-once',
};
const accept = { type: 'agent.task.accepted', payload: accepted };
const dispatched = {
  type: 'agent.task.dispatched',
  payload: {
    version: 1,
    taskId,
    childExecutionAcceptedSequence: 3,
    childExecutionAcceptedDigest: digest,
  },
};
const cancel = {
  type: 'agent.task.cancel-requested',
  payload: { version: 1, taskId, operationId: 'host-operation', reason: 'parent-stop' },
};
const settled = {
  type: 'agent.task.settled',
  payload: {
    version: 1,
    taskId,
    settlement: {
      phase: 'execution',
      status: 'completed',
      executionStatus: 'completed',
      childExecutionId,
      childTerminalSequence: 5,
      resultKind: 'none',
      preview: '',
      previewTruncated: false,
    },
  },
};
const preparationSettled = {
  type: 'agent.task.settled',
  payload: {
    version: 1,
    taskId,
    settlement: {
      phase: 'preparation',
      status: 'failed',
      reason: 'preparation-failed',
      evidence: { stage: 'accepted', parentAcceptedSequence: 2 },
      resultKind: 'none',
    },
  },
};
const created: NewSessionEvent = { type: 'session.created', payload: {} };

describe('Agent task Session facts', () => {
  it('projects the same bounded task summary incrementally, including exact replay', async () => {
    const store = createInMemorySessionEventStore();
    const cache = createSessionProjectionCache(store);
    await store.append(parentSessionId, [created]);
    expect(await cache.project(parentSessionId)).toEqual(
      projectSession(await store.read(parentSessionId)),
    );
    expect((await cache.project(parentSessionId))?.agentTasks).toBeUndefined();

    for (const fact of [accept, dispatched, cancel, settled, settled]) {
      await store.append(parentSessionId, [newSessionEventSchema.parse(fact)]);
      expect(await cache.project(parentSessionId)).toEqual(
        projectSession(await store.read(parentSessionId)),
      );
    }
    const projection = await cache.project(parentSessionId);
    expect(projection?.messages).toEqual([]);
    expect(projection?.agentTasks).toMatchObject({
      tasks: [
        {
          taskId,
          acceptedSequence: 2,
          dispatched: { sequence: 3 },
          cancellation: { sequence: 4, reason: 'parent-stop' },
          settled: { sequence: 5, settlement: { status: 'completed' } },
        },
      ],
    });
    expect(JSON.stringify(projection)).not.toContain(accepted.prompt);
    expect(await store.read(childSessionId)).toEqual([]);
  });

  it.each(
    [
      [dispatched],
      [settled],
      [cancel],
      [accept, settled],
      [accept, { type: 'agent.task.accepted', payload: { ...accepted, title: 'other' } }],
      [
        accept,
        {
          type: 'agent.task.accepted',
          payload: {
            ...accepted,
            taskId: '00000000-0000-4000-8000-000000000006',
            requestId: 'agent-task:00000000-0000-4000-8000-000000000006',
            parentToolCallId: 'other-call',
          },
        },
      ],
      [accept, preparationSettled, dispatched],
      [accept, preparationSettled, cancel],
      [accept, dispatched, preparationSettled],
      [
        accept,
        dispatched,
        {
          ...settled,
          payload: {
            ...settled.payload,
            settlement: {
              ...settled.payload.settlement,
              childExecutionId: '00000000-0000-4000-8000-000000000006',
            },
          },
        },
      ],
      [accept, cancel, { ...cancel, payload: { ...cancel.payload, reason: 'shutdown' } }],
      [
        accept,
        dispatched,
        { ...dispatched, payload: { ...dispatched.payload, childExecutionAcceptedSequence: 4 } },
      ],
    ].map((facts) => ({ facts })),
  )('rejects inconsistent local facts %#', async ({ facts }) => {
    const store = createInMemorySessionEventStore();
    const parsed = facts.map((fact) => newSessionEventSchema.safeParse(fact));
    expect(parsed.every((item) => item.success)).toBe(true);
    await store.append(parentSessionId, [
      created,
      ...facts.map((fact) => newSessionEventSchema.parse(fact)),
    ]);
    const events = await store.read(parentSessionId);
    expect(() => projectSession(events)).toThrow(/task/i);
  });

  it('requires origin as the second child fact and forbids duplicate origin', async () => {
    const store = createInMemorySessionEventStore();
    const fact = newSessionEventSchema.parse({ type: 'agent.task.origin', payload: origin });
    await store.append(childSessionId, [created, fact]);
    expect(projectSession(await store.read(childSessionId)).agentTasks?.origin).toMatchObject({
      ...origin,
      sequence: 2,
    });
    await store.append(childSessionId, [fact]);
    const events = await store.read(childSessionId);
    expect(() => projectSession(events)).toThrow(/origin/i);

    const otherStore = createInMemorySessionEventStore();
    await otherStore.append(childSessionId, [
      created,
      { type: 'session.renamed', payload: { title: 'rename' } },
      fact,
    ]);
    const lateOrigin = await otherStore.read(childSessionId);
    expect(() => projectSession(lateOrigin)).toThrow(/origin/i);
  });

  it('keeps task facts versioned, strict and outside the plugin namespace', () => {
    expect(newSessionEventSchema.safeParse(accept).success).toBe(true);
    expect(
      newSessionEventSchema.safeParse({ ...accept, payload: { ...accepted, version: 2 } }).success,
    ).toBe(false);
    expect(
      newSessionEventSchema.safeParse({ ...accept, payload: { ...accepted, token: 'secret' } })
        .success,
    ).toBe(false);
    expect(
      newSessionEventSchema.safeParse({
        ...accept,
        payload: {
          ...accepted,
          settings: {
            ...accepted.settings,
            client: { endpoint: 'secret' },
          },
        },
      }).success,
    ).toBe(false);
  });
});
