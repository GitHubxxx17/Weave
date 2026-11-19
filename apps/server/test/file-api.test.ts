import { createRuntime } from '@weave/runtime';
import { createInMemoryProjectStore } from '@weave/workspace';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';

const resources: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(resources.splice(0).map((resource) => resource.close()));
});

async function setup(
  withFolder = true,
): Promise<{ app: ReturnType<typeof createApp>; projectId: string }> {
  const runtime = createRuntime();
  await runtime.start();
  const projectStore = createInMemoryProjectStore();
  resources.push({ close: () => runtime.stop() }, projectStore);

  let folder: string | undefined;
  if (withFolder) {
    folder = await mkdtemp(path.join(tmpdir(), 'weave-file-api-'));
    await writeFile(path.join(folder, 'a.txt'), 'hello\n');
    await mkdir(path.join(folder, 'sub'));
    await writeFile(path.join(folder, 'sub', 'b.ts'), 'const b = 1;\n');
    await writeFile(path.join(folder, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x00]));
    const created = folder;
    resources.push({ close: () => rm(created, { recursive: true, force: true }) });
  }

  const project = await projectStore.createProject({
    name: 'Weave',
    folderName: 'weave',
    ...(folder === undefined ? {} : { folderPath: folder }),
  });
  return { app: createApp(runtime, { projectStore }), projectId: project.id };
}

describe('Project file HTTP API', () => {
  it('lists the project file tree', async () => {
    const { app, projectId } = await setup();
    const response = await app.request(`/projects/${projectId}/tree`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { files: string[]; source: string };
    expect(body.files).toContain('a.txt');
    expect(body.files).toContain('sub/b.ts');
  });

  it('reads a text file', async () => {
    const { app, projectId } = await setup();
    const response = await app.request(`/projects/${projectId}/file?path=a.txt`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      path: 'a.txt',
      content: 'hello\n',
      truncated: false,
    });
  });

  it('returns 404 for a missing file', async () => {
    const { app, projectId } = await setup();
    const response = await app.request(`/projects/${projectId}/file?path=missing.txt`);
    expect(response.status).toBe(404);
  });

  it('rejects a path outside the project folder', async () => {
    const { app, projectId } = await setup();
    const response = await app.request(
      `/projects/${projectId}/file?path=${encodeURIComponent('../escape.txt')}`,
    );
    expect(response.status).toBe(400);
  });

  it('rejects a binary file with 415', async () => {
    const { app, projectId } = await setup();
    const response = await app.request(`/projects/${projectId}/file?path=bin.dat`);
    expect(response.status).toBe(415);
  });

  it('returns 409 when the project has no folder', async () => {
    const { app, projectId } = await setup(false);
    const response = await app.request(`/projects/${projectId}/tree`);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'project-folder-unset' } });
  });

  it('returns 404 for an unknown project', async () => {
    const { app } = await setup();
    const response = await app.request('/projects/missing/tree');
    expect(response.status).toBe(404);
  });
});
