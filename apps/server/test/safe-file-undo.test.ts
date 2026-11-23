import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createInMemoryProjectStore } from '@weave/workspace';
import { createWorkspaceFileTools, createWorkspacePolicy } from '@weave/runtime';
import { createApp } from '../src/app.js';
import { createSessionService } from '../src/session-service.js';
import { createServerRuntime, getServerSessionStore } from '../src/runtime.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture(captured = false) {
  const root = await mkdtemp(join(tmpdir(), 'undo-http-'));
  cleanups.push(() => rm(root, { force: true, recursive: true }));
  await writeFile(join(root, 'a'), 'after');
  const runtime = createServerRuntime();
  await runtime.start();
  cleanups.push(() => runtime.stop());
  const projects = createInMemoryProjectStore();
  cleanups.push(() => projects.close());
  const project = await projects.createProject({ name: 'p', folderName: 'p', folderPath: root });
  const foreign = await projects.createProject({
    name: 'foreign',
    folderName: 'foreign',
    folderPath: root,
  });
  const store = getServerSessionStore(runtime);
  const sessions = createSessionService({ projectStore: projects, sessionStore: store });
  const session = await sessions.create(project.id);
  await store.append(session.id, [{ type: 'turn.started', payload: { turnId: 't' } }]);
  if (captured) {
    await writeFile(join(root, 'a'), 'before');
    const tools = createWorkspaceFileTools({
      workspace: createWorkspacePolicy({ root }),
      onFileWriteIntent: async ({ sessionId, ...payload }) => {
        await store.append(sessionId!, [{ type: 'workspace.file-write-intent', payload }]);
      },
      onFileSnapshot: async ({ sessionId, ...payload }) => {
        await store.append(sessionId!, [{ type: 'workspace.file-snapshot', payload }]);
      },
      onFileWriteOutcome: async ({ sessionId, ...payload }) => {
        await store.append(sessionId!, [{ type: 'workspace.file-write', payload }]);
      },
    });
    await tools.writeFile.execute(
      { path: 'a', content: 'after', overwrite: true },
      { sessionId: session.id, turnId: 't', toolCallId: 'c', signal: new AbortController().signal },
    );
  } else {
    await store.append(session.id, [
      {
        type: 'workspace.file-snapshot',
        payload: { path: 'a', existedBefore: true, previousContent: 'before' },
      },
    ]);
  }
  await store.append(session.id, [
    { type: 'turn.completed', payload: { turnId: 't', status: 'completed' } },
  ]);
  const app = createApp(runtime, { projectStore: projects, sessionService: sessions });
  return {
    root,
    app,
    project,
    foreign,
    session,
    store,
    path: `/projects/${project.id}/sessions/${session.id}`,
  };
}
it('rejects an undo fenced by an HTTP same-path update during durable admission', async () => {
  const f = await fixture(true);
  const append = f.store.append.bind(f.store);
  let undoStarted!: () => void;
  let resume!: () => void;
  const entered = new Promise<void>((resolve) => {
    undoStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  f.store.append = async (sessionId, writes) => {
    const events = await append(sessionId, writes);
    if (writes[0]?.type === 'workspace.undo-started') {
      undoStarted();
      await gate;
    }
    return events;
  };
  const undo = f.app.request(`${f.path}/undo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Host: 'localhost' },
    body: JSON.stringify({ turnId: 't', operationId: 'op', requestId: 'req' }),
  });
  await Promise.race([
    entered,
    undo.then(() => {
      throw new Error('Undo finished before persistence barrier');
    }),
  ]);
  try {
    const reset = await f.app.request(`/projects/${f.project.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderPath: f.root }),
    });
    expect(reset.status).toBe(200);
  } finally {
    resume();
  }
  expect((await undo).status).toBe(409);
  expect(await readFile(join(f.root, 'a'), 'utf8')).toBe('after');
  expect(
    (await f.store.read(f.session.id)).some(({ type }) => type === 'workspace.undo-file'),
  ).toBe(false);
});
it('rejects a Session attached to another Project even if both use the same folder', async () => {
  const f = await fixture();
  const response = await f.app.request(`/projects/${f.foreign.id}/sessions/${f.session.id}/undo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Host: 'localhost' },
    body: JSON.stringify({ turnId: 't', operationId: 'op', requestId: 'req' }),
  });
  expect(response.status).toBe(404);
  expect(await readFile(join(f.root, 'a'), 'utf8')).toBe('after');
});
it('reviews legacy snapshots as unavailable and never overwrites them', async () => {
  const f = await fixture();
  const review = await f.app.request(`${f.path}/file-undo?turnId=t`, {
    headers: { Host: 'localhost' },
  });
  expect(review.status).toBe(200);
  expect(await review.json()).toMatchObject({
    files: [{ path: 'a', unavailableReason: 'legacy-snapshot' }],
  });
  const response = await f.app.request(`${f.path}/undo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Host: 'localhost' },
    body: JSON.stringify({ turnId: 't', operationId: 'op', requestId: 'req' }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ results: [{ path: 'a', status: 'unavailable' }] });
  expect(await readFile(join(f.root, 'a'), 'utf8')).toBe('after');
});
it('rejects incomplete request identities and running Sessions', async () => {
  const f = await fixture();
  const send = (body: unknown) =>
    f.app.request(`${f.path}/undo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Host: 'localhost' },
      body: JSON.stringify(body),
    });
  expect((await send({ turnId: 't' })).status).toBe(400);
  await f.store.append(f.session.id, [{ type: 'turn.started', payload: { turnId: 'next' } }]);
  expect((await send({ turnId: 't', operationId: 'op', requestId: 'req' })).status).toBe(409);
});

it('guards local review and undo before CORS and bounds streamed JSON', async () => {
  const f = await fixture();
  const target = `${f.path}/undo`;
  const request = (headers: Record<string, string>, body = '{}') =>
    f.app.request(target, { method: 'POST', headers, body });
  expect((await request({ 'content-type': 'text/plain', Host: 'localhost' })).status).toBe(415);
  expect((await request({ 'content-type': 'application/json', Host: 'evil.test' })).status).toBe(
    403,
  );
  expect(
    (
      await request({
        'content-type': 'application/json',
        Host: 'localhost',
        Origin: 'https://evil.test',
      })
    ).status,
  ).toBe(403);
  expect(
    (await request({ 'content-type': 'application/json', Host: 'localhost' }, ' '.repeat(4097)))
      .status,
  ).toBe(413);
  expect(
    (await f.app.request(`${f.path}/file-undo?turnId=t`, { headers: { Host: 'evil.test' } }))
      .status,
  ).toBe(403);
  expect(
    (
      await f.app.request(target, {
        method: 'OPTIONS',
        headers: { Host: 'evil.test', Origin: 'https://evil.test' },
      })
    ).status,
  ).toBe(403);
});
