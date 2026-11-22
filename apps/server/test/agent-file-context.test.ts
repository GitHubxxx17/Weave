import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryProjectStore, type ProjectStore } from '@weave/workspace';
import { createFileContextCapture } from '../src/agent-file-context.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'weave-server-capture-'));
  roots.push(root);
  await writeFile(join(root, 'a.txt'), 'unique-server-capture');
  const projects = createInMemoryProjectStore();
  const project = await projects.createProject({
    name: 'Project',
    folderName: 'project',
    folderPath: root,
  });
  await projects.attachSession(project.id, 's');
  return { root, projects, project };
}
const options = () => ({ signal: new AbortController().signal });

describe('trusted project file capture composition', () => {
  it('captures under the one owning project and returns exact text plus internal provenance', async () => {
    const f = await setup();
    const result = await createFileContextCapture(f.projects)('s', [{ path: 'a.txt' }], options());
    expect(result.projectId).toBe(f.project.id);
    expect(result.files[0]).toMatchObject({
      path: 'a.txt',
      content: 'unique-server-capture',
      byteLength: 21,
    });
    expect(result.rootIdentity).toMatch(/^[0-9a-f]{64}$/);
    await f.projects.close();
  });

  it('rejects unattached, ambiguous and missing-folder relations before reading files', async () => {
    const f = await setup();
    const base = createFileContextCapture(f.projects);
    await expect(base('foreign', [{ path: 'a.txt' }], options())).rejects.toMatchObject({
      code: 'execution-file-unavailable',
    });
    const noFolder = await f.projects.createProject({ name: 'No folder', folderName: 'none' });
    await f.projects.attachSession(noFolder.id, 'no-folder');
    await expect(base('no-folder', [{ path: 'a.txt' }], options())).rejects.toMatchObject({
      code: 'execution-file-unavailable',
    });
    const ambiguous: ProjectStore = {
      ...f.projects,
      listProjects: async () => [f.project, { ...f.project, id: 'alias' }],
      listSessionRefs: async () => [
        { projectId: f.project.id, sessionId: 's', createdAt: f.project.createdAt },
      ],
    };
    await expect(
      createFileContextCapture(ambiguous)('s', [{ path: 'a.txt' }], options()),
    ).rejects.toMatchObject({ code: 'execution-file-unavailable' });
    await f.projects.close();
  });

  it.each(['folder', 'relation'] as const)(
    'rejects %s changes observed after capture and returns no host path',
    async (change) => {
      const f = await setup();
      let reads = 0;
      const projects: ProjectStore = {
        ...f.projects,
        listProjects: async () => {
          reads++;
          return [
            {
              ...f.project,
              ...(change === 'folder' && reads > 1 ? { folderPath: join(f.root, 'changed') } : {}),
            },
          ];
        },
        listSessionRefs: async (id) =>
          reads > 1 && change === 'relation' ? [] : f.projects.listSessionRefs(id),
      };
      const error = await createFileContextCapture(projects)(
        's',
        [{ path: 'a.txt' }],
        options(),
      ).catch((value: unknown) => value);
      expect(error).toMatchObject({ code: 'execution-file-changed' });
      expect(String(error)).not.toContain(f.root);
      await f.projects.close();
    },
  );

  it('maps broken authoritative metadata to a safe failure', async () => {
    const f = await setup();
    const projects = {
      ...f.projects,
      listProjects: vi.fn().mockRejectedValue(new Error(`${f.root}/raw`)),
    };
    const error = await createFileContextCapture(projects)(
      's',
      [{ path: 'a.txt' }],
      options(),
    ).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'execution-file-capture-failed' });
    expect(String(error)).not.toContain(f.root);
    await f.projects.close();
  });
});
