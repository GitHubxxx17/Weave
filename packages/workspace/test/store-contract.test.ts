import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createInMemoryProjectStore,
  createSqliteProjectStore,
  type ProjectStore,
  type WorkspaceStoreError,
} from '../src/index.js';

type StoreFactory = () => Promise<{
  store: ProjectStore;
  cleanup: () => Promise<void>;
}>;

const temporaryFiles: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryFiles.splice(0).map((filename) => rm(filename, { force: true })));
});

function createTemporaryFilename(): string {
  const filename = join(tmpdir(), `weave-workspace-${randomUUID()}.sqlite`);
  temporaryFiles.push(filename);
  return filename;
}

function describeProjectStore(name: string, createStore: StoreFactory): void {
  describe(name, () => {
    it('creates and lists projects in creation order', async () => {
      const { store, cleanup } = await createStore();

      try {
        const first = await store.createProject({
          name: 'Weave',
          folderName: 'weave',
          folderPath: '/Users/mi/myProject/weave',
        });
        const second = await store.createProject({
          name: 'Orbit',
          folderName: 'orbit',
        });

        expect(first).toMatchObject({
          name: 'Weave',
          folderName: 'weave',
          folderPath: '/Users/mi/myProject/weave',
        });
        expect(second.folderPath).toBeUndefined();
        expect(first.id).not.toBe(second.id);
        expect(first.createdAt).toBe(first.updatedAt);
        expect((await store.listProjects()).map((project) => project.name)).toEqual([
          'Weave',
          'Orbit',
        ]);
      } finally {
        await cleanup();
      }
    });

    it('attaches a session once and rejects duplicate relations', async () => {
      const { store, cleanup } = await createStore();

      try {
        const project = await store.createProject({ name: 'Weave', folderName: 'weave' });
        const relation = await store.attachSession(project.id, 'session-1');

        expect(relation).toMatchObject({
          projectId: project.id,
          sessionId: 'session-1',
        });
        await expect(store.attachSession(project.id, 'session-1')).rejects.toMatchObject({
          code: 'workspace-session-already-attached',
        });
        expect(await store.listSessionRefs(project.id)).toHaveLength(1);
      } finally {
        await cleanup();
      }
    });

    it('rejects invalid input and operations after close', async () => {
      const { store, cleanup } = await createStore();

      try {
        await expect(store.createProject({ name: '', folderName: 'weave' })).rejects.toMatchObject({
          code: 'workspace-store-invalid-input',
        });
        await expect(
          store.createProject({ name: 'Weave', folderName: 'weave', folderPath: 'relative' }),
        ).rejects.toMatchObject({
          code: 'workspace-store-invalid-input',
        });
        await expect(store.getProject('missing')).resolves.toBeUndefined();
        await expect(store.listSessionRefs('missing')).rejects.toMatchObject({
          code: 'workspace-project-not-found',
        });

        await store.close();
        await expect(store.listProjects()).rejects.toMatchObject({
          code: 'workspace-store-closed',
        });
        await expect(store.close()).resolves.toBeUndefined();
      } finally {
        await cleanup();
      }
    });
  });
}

describeProjectStore('In-Memory Project Store', async () => ({
  store: createInMemoryProjectStore(),
  cleanup: async () => undefined,
}));

describeProjectStore('SQLite Project Store', async () => {
  const filename = createTemporaryFilename();
  const store = createSqliteProjectStore({ filename });
  return {
    store,
    cleanup: async () => {
      await store.close();
    },
  };
});

describe('SQLite Project Store persistence', () => {
  it('restores projects and relations after SQLite reopen', async () => {
    const filename = createTemporaryFilename();
    const first = createSqliteProjectStore({ filename });
    const project = await first.createProject({ name: 'Weave', folderName: 'weave' });
    await first.attachSession(project.id, 'session-1');
    await first.close();

    const reopened = createSqliteProjectStore({ filename });
    expect(await reopened.getProject(project.id)).toMatchObject({
      id: project.id,
      name: 'Weave',
      folderName: 'weave',
    });
    expect(await reopened.listSessionRefs(project.id)).toMatchObject([
      { projectId: project.id, sessionId: 'session-1' },
    ]);
    await reopened.close();
  });

  it('exposes typed workspace errors', async () => {
    const filename = createTemporaryFilename();
    const store = createSqliteProjectStore({ filename });
    const error = await store
      .attachSession('missing', 'session-1')
      .catch((caughtError: unknown) => caughtError as WorkspaceStoreError);

    expect(error).toMatchObject({ code: 'workspace-project-not-found' });
    await store.close();
  });
});
