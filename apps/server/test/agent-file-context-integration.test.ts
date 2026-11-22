import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { agentExecutionSnapshotSchema, agentExecutionQueueSnapshotSchema } from '@weave/runtime';
import { startServer } from '../src/main.js';
import { getServerSessionStore } from '../src/runtime.js';
import { createTemporaryDatabaseFile } from './persistence-fixture.js';

it('freezes queued project files through actual Server/SQLite and exposes only metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weave-file-api-'));
  const database = createTemporaryDatabaseFile();
  await writeFile(join(root, 'a.txt'), '\uFEFFunique-before-capture\r\n');
  const calls: { messages: unknown; release: () => void }[] = [];
  const fakeFetch: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { messages: unknown };
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(new DOMException('Cancelled', 'AbortError'));
      const release = () => {
        init?.signal?.removeEventListener('abort', abort);
        resolve();
      };
      init?.signal?.addEventListener('abort', abort, { once: true });
      calls.push({ messages: request.messages, release });
      if (init?.signal?.aborted) abort();
    });
    const chunk = {
      id: randomUUID(),
      object: 'chat.completion.chunk',
      created: 1,
      model: 'file-test',
      choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }],
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
          id: 'file-test',
          label: 'File test',
          type: 'openai-compatible',
          baseUrl: 'https://fixture.invalid/v1',
          apiKey: 'fixture-only',
          defaultModel: 'file-test',
        },
      ]),
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const post = (path: string, value: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
  try {
    const project = (await (
      await post('/projects', { name: 'Files', folderName: 'files', folderPath: root })
    ).json()) as { id: string };
    const session = (await (await post(`/projects/${project.id}/sessions`, {})).json()) as {
      id: string;
    };
    const path = `/sessions/${session.id}/executions`;
    const plain = {
      provider: 'file-test',
      model: 'file-test',
      permissionMode: 'ask',
      userMessage: { role: 'user', content: [{ type: 'text', text: 'active' }] },
    };
    const first = agentExecutionSnapshotSchema.parse(
      await (await post(path, { requestId: 'one', input: plain })).json(),
    );
    await expect.poll(() => calls.length).toBe(1);
    const launch = {
      requestId: 'file',
      input: { ...plain, userMessage: { role: 'user', content: [] }, files: [{ path: 'a.txt' }] },
    };
    const response = await post(path, launch);
    expect(response.status).toBe(202);
    const second = agentExecutionSnapshotSchema.parse(await response.json());
    expect(second.status).toBe('queued');
    expect(second.fileAttachments?.[0]).toMatchObject({
      path: 'a.txt',
      encoding: 'utf-8',
      byteLength: 26,
    });
    expect(JSON.stringify(second)).not.toContain('unique-before-capture');
    const queue = agentExecutionQueueSnapshotSchema.parse(
      await (await fetch(`${base}${path}/queue`)).json(),
    );
    expect(queue.queued[0]?.fileCount).toBe(1);
    expect(JSON.stringify(queue)).not.toContain(root);
    expect(JSON.stringify(queue)).not.toContain('unique-before-capture');
    await writeFile(join(root, 'a.txt'), 'modified-after-acceptance');
    const replay = agentExecutionSnapshotSchema.parse(await (await post(path, launch)).json());
    expect(replay.executionId).toBe(second.executionId);
    expect(replay.fileAttachments).toEqual(second.fileAttachments);
    calls[0]!.release();
    await expect.poll(() => calls.length).toBe(2);
    expect(JSON.stringify(calls[1]!.messages)).toContain('unique-before-capture');
    expect(JSON.stringify(calls[1]!.messages)).not.toContain('modified-after-acceptance');
    calls[1]!.release();
    await expect
      .poll(
        async () =>
          ((await (await fetch(`${base}${path}/queue`)).json()) as { active: unknown }).active,
      )
      .toBeNull();
    const detail = (await (await fetch(`${base}/sessions/${session.id}`)).json()) as {
      messages: { messageId: string; fileAttachments?: unknown }[];
    };
    expect(
      detail.messages.find((message) => message.messageId === second.userMessageId)
        ?.fileAttachments,
    ).toEqual(second.fileAttachments);
    expect(JSON.stringify(detail)).not.toContain('unique-before-capture');
    expect(JSON.stringify(detail)).not.toContain('rootIdentity');
    const events = await getServerSessionStore(server.runtime).read(session.id);
    expect(
      events.filter((event) => event.type === 'turn.started').map((event) => event.payload.turnId),
    ).toEqual([first.turnId, second.turnId]);
    expect(events.filter((event) => event.type === 'execution.accepted')).toHaveLength(2);
    expect(
      events.find(
        (event) =>
          event.type === 'execution.accepted' && event.payload.executionId === second.executionId,
      )?.payload,
    ).toHaveProperty('fileContext.files.0.content', '\uFEFFunique-before-capture\r\n');
    await writeFile(join(root, 'oversize'), Buffer.alloc(65_537, 97));
    await writeFile(join(root, 'invalid'), Buffer.from([0xff]));
    for (const [file, code, status] of [
      ['oversize', 'execution-file-too-large', 413],
      ['invalid', 'execution-file-invalid-utf8', 422],
    ] as const) {
      const rejected = await post(path, {
        requestId: file,
        input: { ...plain, files: [{ path: 'a.txt' }, { path: file }] },
      });
      expect(rejected.status).toBe(status);
      expect(await rejected.json()).toMatchObject({ error: { code } });
    }
    for (const forged of [
      { files: [{ path: 'a.txt', content: 'forged' }] },
      { files: [{ path: 'a.txt' }], fileContext: { content: 'forged' } },
    ]) {
      expect(
        (await post(path, { requestId: randomUUID(), input: { ...plain, ...forged } })).status,
      ).toBe(400);
    }
    // Production disables the entire compatibility endpoint before parsing its input.
    expect(
      (await post('/agent/runs/stream', { sessionId: session.id, ...launch.input })).status,
    ).toBe(409);
    expect(
      (await getServerSessionStore(server.runtime).read(session.id)).filter(
        (event) => event.type === 'execution.accepted',
      ),
    ).toHaveLength(2);
  } finally {
    for (const call of calls) call.release();
    await server.stop();
    await database.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
