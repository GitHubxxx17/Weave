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

async function createWorkspaceApp() {
  const runtime = createRuntime();
  await runtime.start();
  const projectStore = createInMemoryProjectStore();
  const sessionStore = createInMemorySessionEventStore();
  const sessionService = createSessionService({ projectStore, sessionStore });
  resources.push({ close: () => runtime.stop() }, projectStore, sessionStore);
  return { app: createApp(runtime, { projectStore, sessionService }), projectStore };
}

describe('Project HTTP API', () => {
  it('creates a Project and a Session, then lists both', async () => {
    const { app } = await createWorkspaceApp();

    const projectResponse = await app.request('/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Weave', folderName: 'weave' }),
    });
    expect(projectResponse.status).toBe(201);
    const project = (await projectResponse.json()) as { id: string };

    const sessionResponse = await app.request(`/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '第一个会话' }),
    });
    expect(sessionResponse.status).toBe(201);

    const listResponse = await app.request('/projects');
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toMatchObject({
      projects: [
        {
          name: 'Weave',
          sessions: [{ title: '第一个会话' }],
        },
      ],
      warnings: [],
    });
  });

  it('validates Project input and unknown Project routes', async () => {
    const { app } = await createWorkspaceApp();

    const invalidResponse = await app.request('/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '', folderName: 'weave' }),
    });
    expect(invalidResponse.status).toBe(400);
    expect(await invalidResponse.json()).toMatchObject({
      error: { code: 'workspace-store-invalid-input' },
    });

    const missingResponse = await app.request('/projects/missing/sessions');
    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.json()).toMatchObject({
      error: { code: 'workspace-project-not-found' },
    });
  });
});
