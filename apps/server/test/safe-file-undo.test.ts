import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createInMemoryProjectStore } from '@weave/workspace';
import { createApp } from '../src/app.js';
import { createSessionService } from '../src/session-service.js';
import { createServerRuntime, getServerSessionStore } from '../src/runtime.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture() {
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
  await store.append(session.id, [
    { type: 'turn.started', payload: { turnId: 't' } },
    {
      type: 'workspace.file-snapshot',
      payload: { path: 'a', existedBefore: true, previousContent: 'before' },
    },
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
