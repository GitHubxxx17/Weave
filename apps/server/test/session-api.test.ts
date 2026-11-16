import { createRuntime } from '@weave/runtime';
import { createInMemorySessionEventStore } from '@weave/session';
import { createInMemoryProjectStore } from '@weave/workspace';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createSessionService } from '../src/session-service.js';

const resources: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(resources.splice(0).map((resource) => resource.close()));
});

async function createSessionApp() {
  const runtime = createRuntime();
  await runtime.start();
  const projectStore = createInMemoryProjectStore();
  const sessionStore = createInMemorySessionEventStore();
  const sessionService = createSessionService({ projectStore, sessionStore });
  const project = await projectStore.createProject({ name: 'Weave', folderName: 'weave' });
  const session = await sessionService.create(project.id, '原始标题');
  resources.push({ close: () => runtime.stop() }, projectStore, sessionStore);
  return { app: createApp(runtime, { projectStore, sessionService }), session };
}

describe('Session HTTP API', () => {
  it('renames, archives, restores, and tombstones a Session', async () => {
    const { app, session } = await createSessionApp();

    const renameResponse = await app.request(`/sessions/${session.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '修改后的标题' }),
    });
    expect(renameResponse.status).toBe(200);
    expect(await renameResponse.json()).toMatchObject({ title: '修改后的标题' });

    expect((await app.request(`/sessions/${session.id}/archive`, { method: 'POST' })).status).toBe(
      200,
    );
    expect((await app.request(`/sessions/${session.id}/restore`, { method: 'POST' })).status).toBe(
      200,
    );

    const deleteResponse = await app.request(`/sessions/${session.id}`, { method: 'DELETE' });
    expect(deleteResponse.status).toBe(200);
    expect(await deleteResponse.json()).toMatchObject({ deletedAt: expect.any(String) });

    const repeatDeleteResponse = await app.request(`/sessions/${session.id}`, {
      method: 'DELETE',
    });
    expect(repeatDeleteResponse.status).toBe(200);
    expect((await repeatDeleteResponse.json()).deletedAt).toEqual(expect.any(String));

    const restoreResponse = await app.request(`/sessions/${session.id}/restore`, {
      method: 'POST',
    });
    expect(restoreResponse.status).toBe(410);
    expect(await restoreResponse.json()).toMatchObject({
      error: { code: 'session-deleted' },
    });
  });

  it('returns 404 for an unknown Session and 400 for an invalid title', async () => {
    const { app } = await createSessionApp();

    const missingResponse = await app.request('/sessions/missing');
    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.json()).toMatchObject({
      error: { code: 'session-not-found' },
    });

    const invalidResponse = await app.request('/sessions/missing', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '' }),
    });
    expect(invalidResponse.status).toBe(400);
    expect(await invalidResponse.json()).toMatchObject({
      error: { code: 'workspace-store-invalid-input' },
    });
  });
});
