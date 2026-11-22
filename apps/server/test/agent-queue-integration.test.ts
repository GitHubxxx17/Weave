import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { agentExecutionQueueSnapshotSchema, agentExecutionSnapshotSchema } from '@weave/runtime';
import { getServerSessionStore } from '../src/runtime.js';
import { startServer } from '../src/main.js';
import { createTemporaryDatabaseFile } from './persistence-fixture.js';

async function fixture() {
  const database = createTemporaryDatabaseFile();
  const calls: { text: string; temperature: unknown; maxTokens: unknown; release: () => void }[] =
    [];
  const fakeFetch: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as {
      messages: { role: string; content: unknown }[];
      temperature?: number;
      max_tokens?: number;
    };
    const last = request.messages.filter((message) => message.role === 'user').at(-1);
    const text = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content);
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(new DOMException('Cancelled', 'AbortError'));
      const release = () => {
        init?.signal?.removeEventListener('abort', abort);
        resolve();
      };
      init?.signal?.addEventListener('abort', abort, { once: true });
      calls.push({
        text,
        temperature: request.temperature,
        maxTokens: request.max_tokens,
        release,
      });
      if (init?.signal?.aborted) abort();
    });
    const chunk = {
      id: randomUUID(),
      object: 'chat.completion.chunk',
      created: 1,
      model: 'queue-test',
      choices: [{ index: 0, delta: { content: `reply:${text}` }, finish_reason: null }],
    };
    return new Response(
      `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  };
  const server = await startServer(0, {
    databaseFile: database.filename,
    pluginsDirectory: false,
    fetch: fakeFetch,
    environment: {
      WEAVE_LLM_PROVIDERS: JSON.stringify([
        {
          id: 'queue-test',
          label: 'Queue test',
          type: 'openai-compatible',
          baseUrl: 'https://fixture.invalid/v1',
          apiKey: 'fixture-only',
          defaultModel: 'queue-test',
          temperature: 0.3,
          maxTokens: 1024,
        },
      ]),
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const post = async (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const project = (await (
    await post('/projects', { name: 'Queue', folderName: 'queue' })
  ).json()) as { id: string };
  const session = (await (await post(`/projects/${project.id}/sessions`, {})).json()) as {
    id: string;
  };
  const path = `/sessions/${session.id}/executions`;
  const launch = async (text: string) => {
    const response = await post(path, {
      requestId: randomUUID(),
      input: {
        provider: 'queue-test',
        model: 'queue-test',
        permissionMode: 'ask',
        userMessage: { role: 'user', content: [{ type: 'text', text }] },
      },
    });
    expect(response.status).toBe(202);
    return agentExecutionSnapshotSchema.parse(await response.json());
  };
  const queue = async () =>
    agentExecutionQueueSnapshotSchema.parse(await (await fetch(`${base}${path}/queue`)).json());
  return {
    server,
    calls,
    post,
    launch,
    queue,
    path,
    session,
    base,
    async close() {
      await server.stop();
      await database.cleanup();
    },
  };
}

it('executes reordered immutable queue entries through real HTTP and SQLite without observers', async () => {
  const f = await fixture();
  try {
    const first = await f.launch('one');
    await expect.poll(() => f.calls.length).toBe(1);
    const second = await f.launch('two');
    const third = await f.launch('three');
    const fourth = await f.launch('four');
    expect(second.status).toBe('queued');
    expect(f.calls.map((call) => call.text)).toEqual(['one']);
    let state = await f.queue();
    expect(state.queued.map((entry) => entry.executionId)).toEqual([
      second.executionId,
      third.executionId,
      fourth.executionId,
    ]);
    const reorder = {
      requestId: 'reorder-once',
      expectedRevision: state.revision,
      executionIds: [fourth.executionId, third.executionId, second.executionId],
    };
    expect((await f.post(`${f.path}/queue/reorder`, reorder)).status).toBe(200);
    state = await f.queue();
    const cancel = { requestId: 'cancel-once', expectedRevision: state.revision };
    expect((await f.post(`${f.path}/${third.executionId}/cancel-queued`, cancel)).status).toBe(200);
    // A lost control response can be replayed after a later control changed revision.
    expect((await f.post(`${f.path}/queue/reorder`, reorder)).status).toBe(200);
    expect((await f.post(`${f.path}/${third.executionId}/cancel-queued`, cancel)).status).toBe(200);
    expect((await f.queue()).queued.map((entry) => entry.executionId)).toEqual([
      fourth.executionId,
      second.executionId,
    ]);
    expect(
      (
        await f.post(`${f.path}/${second.executionId}/cancel-queued`, {
          requestId: 'stale',
          expectedRevision: reorder.expectedRevision,
        })
      ).status,
    ).toBe(409);
    expect((await f.post(`${f.path}/${second.executionId}/cancel`, {})).status).toBe(409);
    f.calls[0]!.release();
    await expect.poll(() => f.calls.length).toBe(2);
    expect(f.calls[1]!.text).toBe('four');
    f.calls[1]!.release();
    await expect.poll(() => f.calls.length).toBe(3);
    expect(f.calls[2]!.text).toBe('two');
    f.calls[2]!.release();
    await expect.poll(async () => (await f.queue()).active).toBeNull();
    const events = await getServerSessionStore(f.server.runtime).read(f.session.id);
    expect(
      events.filter((event) => event.type === 'turn.started').map((event) => event.payload.turnId),
    ).toEqual([first.turnId, fourth.turnId, second.turnId]);
    expect(
      events.filter(
        (event) => event.type === 'message.created' && event.payload.message.role === 'user',
      ),
    ).toHaveLength(3);
    expect(
      events.filter(
        (event) => event.type === 'message.created' && event.payload.message.role === 'assistant',
      ),
    ).toHaveLength(3);
    const frozen = events.filter((event) => event.type === 'execution.accepted');
    expect(frozen).toHaveLength(4);
    for (const event of frozen)
      expect(event.payload.runInput).toMatchObject({
        temperature: 0.3,
        maxTokens: 1024,
        useProviderDefaults: false,
      });
    expect(f.calls.every((call) => call.temperature === 0.3 && call.maxTokens === 1024)).toBe(true);
  } finally {
    await f.close();
  }
}, 15000);

it('stops the exact current execution and advances queued work only after durable cancellation', async () => {
  const f = await fixture();
  try {
    const first = await f.launch('stop-current');
    await expect.poll(() => f.calls.length).toBe(1);
    const second = await f.launch('keep-next');
    expect((await f.post(`${f.path}/${first.executionId}/cancel`, {})).status).toBe(202);
    await expect.poll(() => f.calls.length).toBe(2);
    expect(f.calls[1]!.text).toBe('keep-next');
    expect((await f.post(`${f.path}/${first.executionId}/cancel`, {})).status).toBe(202);
    expect((await f.queue()).active?.executionId).toBe(second.executionId);
    const events = await getServerSessionStore(f.server.runtime).read(f.session.id);
    const terminal = events.find(
      (event) =>
        event.type === 'execution.finished' && event.payload.executionId === first.executionId,
    );
    const claim = events.find(
      (event) =>
        event.type === 'execution.claimed' && event.payload.executionId === second.executionId,
    );
    expect(terminal).toMatchObject({ payload: { status: 'cancelled' } });
    expect(claim!.sequence).toBeGreaterThan(terminal!.sequence);
    f.calls[1]!.release();
    await expect.poll(async () => (await f.queue()).active).toBeNull();
  } finally {
    await f.close();
  }
}, 15000);
