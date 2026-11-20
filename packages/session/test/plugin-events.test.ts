import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createInMemorySessionEventStore,
  createSqliteSessionEventStore,
  isPluginEventType,
  newSessionEventSchema,
  pluginEventTypePattern,
  projectSession,
  sessionEventSchema,
  type NewSessionEvent,
  type SessionEventStore,
} from '../src/index.js';

const temporaryFiles: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryFiles
      .splice(0)
      .flatMap((filename) => [
        rm(filename, { force: true }),
        rm(`${filename}-wal`, { force: true }),
        rm(`${filename}-shm`, { force: true }),
      ]),
  );
});

function sqliteFilename(): string {
  const filename = join(tmpdir(), `weave-plugin-events-${randomUUID()}.sqlite`);
  temporaryFiles.push(filename);
  return filename;
}

const pluginEvent = (payload: Record<string, unknown> = { sha: 'abc123' }): NewSessionEvent => ({
  type: 'git/commit-captured',
  payload,
});

describe('plugin event type', () => {
  it.each(['git/commit-captured', 'a/b', 'my-plugin/event-1', 'p9/x'])('accepts %s', (type) => {
    expect(pluginEventTypePattern.test(type)).toBe(true);
    expect(isPluginEventType(type)).toBe(true);
  });

  it.each([
    'turn.started',
    'tool-call.created',
    'git',
    'git/',
    '/commit',
    'Git/commit',
    'git/Commit',
    'git/a/b',
    'git/commit captured',
    '',
  ])('rejects %j', (type) => {
    expect(isPluginEventType(type)).toBe(false);
  });

  it('never collides with a core event type', () => {
    for (const type of [
      'session.created',
      'message.created',
      'turn.started',
      'turn.completed',
      'step.started',
      'step.completed',
      'tool-call.created',
      'tool-result.created',
      'workspace.file-snapshot',
    ]) {
      expect(isPluginEventType(type)).toBe(false);
    }
  });
});

describe('plugin events in the schemas', () => {
  it('accepts a plugin event from a caller and keeps its payload', () => {
    expect(newSessionEventSchema.parse(pluginEvent({ sha: 'x', files: [1, 2] }))).toEqual({
      type: 'git/commit-captured',
      payload: { sha: 'x', files: [1, 2] },
    });
  });

  it.each([
    { type: 'git', payload: {} },
    { type: 'git/commit-captured', payload: 'not an object' },
    { type: 'git/commit-captured', payload: [] },
    { type: 'git/commit-captured' },
  ])('rejects a malformed plugin event %j', (event) => {
    expect(newSessionEventSchema.safeParse(event).success).toBe(false);
  });

  it('still holds a core event to its own schema', () => {
    expect(newSessionEventSchema.safeParse({ type: 'turn.started', payload: {} }).success).toBe(
      false,
    );
    expect(
      newSessionEventSchema.safeParse({ type: 'turn.started', payload: { turnId: 't' } }).success,
    ).toBe(true);
  });

  it('reads back a persisted plugin event without knowing the plugin', () => {
    const persisted = {
      eventId: 'event-1',
      sessionId: 'session-1',
      sequence: 2,
      occurredAt: '2026-11-20T00:00:00.000Z',
      type: 'git/commit-captured',
      payload: { sha: 'abc' },
    };

    expect(sessionEventSchema.parse(persisted)).toEqual(persisted);
  });
});

async function exercise(open: () => SessionEventStore | Promise<SessionEventStore>) {
  const store = await open();
  try {
    await store.append('session-1', [{ type: 'session.created', payload: { title: '演示' } }]);
    const written = await store.append('session-1', [
      pluginEvent({ sha: 'abc123' }),
      { type: 'turn.started', payload: { turnId: 'turn-1' } },
    ]);

    expect(written.map((event) => [event.sequence, event.type])).toEqual([
      [2, 'git/commit-captured'],
      [3, 'turn.started'],
    ]);
    expect(await store.read('session-1', { afterSequence: 1 })).toEqual(written);
    return store;
  } catch (error) {
    await store.close();
    throw error;
  }
}

describe('stores', () => {
  it('append and read plugin events in the in-memory store', async () => {
    const store = await exercise(() => createInMemorySessionEventStore());
    await store.close();
  });

  it('append and read plugin events in the SQLite store, across a reopen', async () => {
    const filename = sqliteFilename();
    const store = await exercise(() => createSqliteSessionEventStore({ filename }));
    await store.close();

    const reopened = createSqliteSessionEventStore({ filename });
    try {
      expect((await reopened.read('session-1')).map((event) => event.type)).toEqual([
        'session.created',
        'git/commit-captured',
        'turn.started',
      ]);
    } finally {
      await reopened.close();
    }
  });

  it('keeps assigning the sequence and identity itself for plugin events', async () => {
    const store = createInMemorySessionEventStore();
    await store.append('session-1', [{ type: 'session.created', payload: {} }]);

    const [written] = await store.append('session-1', [
      { ...pluginEvent(), sequence: 99, eventId: 'forged' } as unknown as NewSessionEvent,
    ]);

    expect(written?.sequence).toBe(2);
    expect(written?.eventId).not.toBe('forged');
    await store.close();
  });

  it('refuses a malformed plugin event without writing anything', async () => {
    const store = createInMemorySessionEventStore();
    await store.append('session-1', [{ type: 'session.created', payload: {} }]);

    await expect(
      store.append('session-1', [
        pluginEvent(),
        { type: 'git', payload: {} } as unknown as NewSessionEvent,
      ]),
    ).rejects.toMatchObject({ code: 'session-store-invalid-input' });

    expect(await store.read('session-1')).toHaveLength(1);
    await store.close();
  });
});

describe('Session projection', () => {
  it('skips plugin events, so a Session opens whether or not their plugin is installed', async () => {
    const store = createInMemorySessionEventStore();
    await store.append('session-1', [
      { type: 'session.created', payload: { title: '演示' } },
      pluginEvent(),
      {
        type: 'message.created',
        payload: {
          messageId: 'message-1',
          message: { role: 'user', content: [{ type: 'text', text: '你好' }] },
        },
      },
      pluginEvent({ sha: 'def456' }),
    ]);

    const projection = projectSession(await store.read('session-1'));

    expect(projection.title).toBe('演示');
    expect(projection.messages).toHaveLength(1);
    expect(projection.lastSequence).toBe(4);
    await store.close();
  });
});
