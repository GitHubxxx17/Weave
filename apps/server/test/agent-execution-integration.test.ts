import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSqliteSessionEventStore, projectSession } from '@weave/session';
import { createInMemoryProjectStore } from '@weave/workspace';
import { startServer } from '../src/main.js';
import { createTemporaryDatabaseFile } from './persistence-fixture.js';

const input = {
  userMessage: {
    role: 'user' as const,
    content: [{ type: 'text' as const, text: 'background demo' }],
  },
  provider: 'mock',
  model: 'test',
  permissionMode: 'ask' as const,
};

it('runs through the real composition without observers and replays a lost acceptance once', async () => {
  const database = createTemporaryDatabaseFile();
  const server = await startServer(0, { databaseFile: database.filename, environment: {} });
  const base = `http://127.0.0.1:${server.port}`;
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  try {
    const project = (await (
      await post('/projects', { name: 'Owned', folderName: 'owned' })
    ).json()) as { id: string };
    const session = (await (await post(`/projects/${project.id}/sessions`, {})).json()) as {
      id: string;
    };
    const launch = { requestId: randomUUID(), input };
    const accepted = await post(`/sessions/${session.id}/executions`, launch);
    expect(accepted.status).toBe(202);
    const receipt = (await accepted.json()) as {
      executionId: string;
      turnId: string;
      status: string;
    };
    let terminal: { status: string; durableThroughSequence?: number } = receipt;
    await expect
      .poll(async () => {
        terminal = (await (
          await fetch(`${base}/sessions/${session.id}/executions/${receipt.executionId}`)
        ).json()) as typeof terminal;
        return terminal.status;
      })
      .toBe('completed');
    expect(terminal.durableThroughSequence).toBeGreaterThan(1);
    const replay = await post(`/sessions/${session.id}/executions`, launch);
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({
      executionId: receipt.executionId,
      status: 'completed',
    });
    const detail = (await (await fetch(`${base}/sessions/${session.id}`)).json()) as {
      turns: { turnId: string }[];
      messages: { role: string }[];
      lastSequence: number;
    };
    expect(detail.turns.map((turn) => turn.turnId)).toEqual([receipt.turnId]);
    expect(detail.messages.filter((message) => message.role === 'user')).toHaveLength(1);
    expect(detail.messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
    expect(detail.lastSequence).toBeGreaterThanOrEqual(terminal.durableThroughSequence!);
    expect((await post('/agent/runs/stream', { sessionId: session.id, ...input })).status).toBe(
      409,
    );
  } finally {
    await server.stop();
    await database.cleanup();
  }
});

describe('startup execution recovery', () => {
  it('settles accepted but unstarted input in SQLite without producing a Turn', async () => {
    const database = createTemporaryDatabaseFile();
    const store = createSqliteSessionEventStore({ filename: database.filename });
    const projects = createInMemoryProjectStore();
    const project = await projects.createProject({ name: 'recover', folderName: 'recover' });
    await projects.attachSession(project.id, 'recover-session');
    await store.append('recover-session', [
      { type: 'session.created', payload: {} },
      {
        type: 'execution.accepted',
        payload: {
          executionId: 'old-execution',
          requestId: 'old-request',
          requestDigest: 'a'.repeat(64),
          turnId: 'unstarted-turn',
          userMessageId: 'unstarted-user',
          input,
        },
      },
    ]);
    await store.close();
    const server = await startServer(0, {
      databaseFile: database.filename,
      projectStore: projects,
      environment: {},
    });
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/sessions/recover-session/executions/old-execution`,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        status: 'interrupted',
        error: { code: 'server-restarted' },
        durableThroughSequence: 3,
      });
      // A second read of the actual SQLite log verifies no model/Turn was started.
      const observer = createSqliteSessionEventStore({ filename: database.filename });
      try {
        expect(projectSession(await observer.read('recover-session')).turns).toEqual([]);
      } finally {
        await observer.close();
      }
    } finally {
      await server.stop();
      await database.cleanup();
    }
  });
});

it('interrupts queued SQLite intents on restart without creating conversation Turns', async () => {
  const database = createTemporaryDatabaseFile();
  const store = createSqliteSessionEventStore({ filename: database.filename });
  const projects = createInMemoryProjectStore();
  const project = await projects.createProject({
    name: 'Queued recovery',
    folderName: 'queued-recovery',
  });
  await projects.attachSession(project.id, 'queued-session');
  await store.append('queued-session', [
    { type: 'session.created', payload: {} },
    ...['first', 'second'].map((id) => ({
      type: 'execution.accepted' as const,
      payload: {
        executionId: id,
        requestId: `request-${id}`,
        requestDigest: 'a'.repeat(64),
        turnId: `turn-${id}`,
        userMessageId: `user-${id}`,
        input,
        dispatch: 'queued' as const,
        runInput: { ...input, useProviderDefaults: false },
      },
    })),
  ]);
  await store.close();
  const server = await startServer(0, {
    databaseFile: database.filename,
    projectStore: projects,
    environment: {},
  });
  try {
    const base = `http://127.0.0.1:${server.port}/sessions/queued-session`;
    const queue = await (await fetch(`${base}/executions/queue`)).json();
    expect(queue).toMatchObject({ active: null, queued: [], scheduler: 'ready' });
    const executions = (await (await fetch(`${base}/executions`)).json()) as { status: string }[];
    expect(executions.map((item) => item.status)).toEqual(['interrupted', 'interrupted']);
    const observer = createSqliteSessionEventStore({ filename: database.filename });
    try {
      const events = await observer.read('queued-session');
      expect(projectSession(events).turns).toEqual([]);
      expect(events.filter((event) => event.type === 'execution.claimed')).toEqual([]);
      expect(events.filter((event) => event.type === 'execution.finished')).toHaveLength(2);
    } finally {
      await observer.close();
    }
  } finally {
    await server.stop();
    await database.cleanup();
  }
});
