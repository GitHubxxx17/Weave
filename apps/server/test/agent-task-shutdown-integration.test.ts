import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteSessionEventStore, type SessionEventStore } from '@weave/session';
import { expect, it, vi } from 'vitest';
import { startServer } from '../src/main.js';

it('retains real task writers and SQLite on incomplete shutdown, then retries the same settlement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weave-task-shutdown-'));
  const filename = join(directory, 'state.db');
  const persisted = createSqliteSessionEventStore({ filename });
  let rejectSettlement = true;
  const close = vi.fn(() => persisted.close());
  const store: SessionEventStore = {
    read: (sessionId, options) => persisted.read(sessionId, options),
    append: (sessionId, events) => {
      if (rejectSettlement && events.some((event) => event.type === 'agent.task.settled'))
        return Promise.reject(new Error('Injected settlement write failure'));
      return persisted.append(sessionId, events);
    },
    close,
  };
  let parentCalls = 0;
  const provider = vi.fn<typeof fetch>(async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as {
      messages: { role: string; content: string | { text?: string }[] }[];
    };
    const user = request.messages.find((message) => message.role === 'user');
    const prompt =
      typeof user?.content === 'string'
        ? user.content
        : user?.content.map((part) => part.text ?? '').join('');
    const spawn = prompt === 'Delegate shutdown check' && parentCalls++ === 0;
    const delta = spawn
      ? {
          tool_calls: [
            {
              index: 0,
              id: randomUUID(),
              type: 'function',
              function: {
                name: 'agent_spawn',
                arguments: JSON.stringify({
                  title: 'Shutdown check',
                  prompt: 'Child shutdown check',
                }),
              },
            },
          ],
        }
      : { content: 'Complete' };
    const chunk = (delta: unknown, finish: string | null) => ({
      id: randomUUID(),
      object: 'chat.completion.chunk',
      created: 1,
      model: 'test',
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    return new Response(
      `data: ${JSON.stringify(chunk(delta, null))}\n\ndata: ${JSON.stringify(chunk({}, spawn ? 'tool_calls' : 'stop'))}\n\ndata: [DONE]\n\n`,
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  });
  const server = await startServer(0, {
    databaseFile: filename,
    sessionStoreFactory: () => store,
    pluginsDirectory: false,
    skillsDirectory: false,
    fetch: provider,
    environment: {
      WEAVE_LLM_PROVIDERS: JSON.stringify([
        {
          id: 'test',
          label: 'Test',
          type: 'openai-compatible',
          baseUrl: 'https://fixture.invalid/v1',
          apiKey: 'fixture-only',
          defaultModel: 'test',
        },
      ]),
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const post = (path: string, body: unknown) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  let root = '';
  try {
    const project = (await (
      await post('/projects', { name: 'Shutdown', folderName: 'shutdown' })
    ).json()) as { id: string };
    const session = (await (await post(`/projects/${project.id}/sessions`, {})).json()) as {
      id: string;
    };
    root = session.id;
    const launched = await post(`/sessions/${root}/executions`, {
      requestId: 'parent',
      input: {
        provider: 'test',
        model: 'test',
        permissionMode: 'ask',
        userMessage: {
          role: 'user',
          content: [{ type: 'text', text: 'Delegate shutdown check' }],
        },
      },
    });
    expect(launched.status, await launched.text()).toBe(202);
    await expect
      .poll(async () => {
        const tree = (await (await fetch(`${base}/sessions/${root}/tasks`)).json()) as {
          tasks: { status: string }[];
        };
        return tree.tasks[0]?.status;
      })
      .toBe('blocked');
    const before = await persisted.read(root);
    const accepted = before.find((event) => event.type === 'agent.task.accepted');
    if (accepted?.type !== 'agent.task.accepted') throw new Error('Missing accepted child');
    const child = await persisted.read(accepted.payload.childSessionId);
    expect(child.filter((event) => event.type === 'execution.finished')).toHaveLength(1);
    expect(before.filter((event) => event.type === 'agent.task.settled')).toHaveLength(0);
    await expect(server.stop()).rejects.toThrow('Agent task drain is incomplete');
    expect(close).not.toHaveBeenCalled();
    expect(await persisted.read(accepted.payload.childSessionId)).toEqual(child);
    rejectSettlement = false;
    await server.stop();
    expect(close).toHaveBeenCalledOnce();
    const reopened = createSqliteSessionEventStore({ filename });
    try {
      expect(
        (await reopened.read(root)).filter((event) => event.type === 'agent.task.settled'),
      ).toHaveLength(1);
      expect(await reopened.read(accepted.payload.childSessionId)).toEqual(child);
      expect(provider).toHaveBeenCalledTimes(3);
    } finally {
      await reopened.close();
    }
  } finally {
    rejectSettlement = false;
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
