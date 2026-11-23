import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
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

function createLegacyProjectDatabase(filename: string): void {
  const database = new DatabaseSync(filename);
  try {
    database.exec(`
      PRAGMA user_version = 1;
      CREATE TABLE projects (
        project_id TEXT NOT NULL PRIMARY KEY,
        name TEXT NOT NULL,
        folder_name TEXT NOT NULL,
        folder_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO projects VALUES (
        'project-1', 'Weave Studio', 'weave', '/tmp/weave',
        '2026-11-14T10:00:00.000Z', '2026-11-15T10:00:00.000Z'
      );
      CREATE TABLE project_sessions (
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (project_id, session_id),
        FOREIGN KEY (project_id) REFERENCES projects(project_id)
      );
      INSERT INTO project_sessions VALUES ('project-1', 'session-1', '2026-11-15T10:00:00.000Z');
      CREATE TABLE session_events (
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (session_id, sequence)
      );
      INSERT INTO session_events VALUES (
        'session-1', 1, 'event-1', 'session.created', '2026-11-15T10:00:00.000Z', '{}'
      );
    `);
  } finally {
    database.close();
  }
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
          folderRevision: 0,
        });
        expect(second.folderPath).toBeUndefined();
        expect(second.folderRevision).toBe(0);
        expect(first.id).not.toBe(second.id);
        expect(first.createdAt).toBe(first.updatedAt);
        expect(await store.listProjects()).toEqual([first, second]);
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

    it('sets, changes and clears a Project folder', async () => {
      const { store, cleanup } = await createStore();

      try {
        const project = await store.createProject({ name: 'Weave', folderName: 'weave' });
        expect(project.folderPath).toBeUndefined();

        const withFolder = await store.updateProjectFolder(project.id, '/tmp/weave');
        expect(withFolder).toMatchObject({ folderPath: '/tmp/weave', folderRevision: 1 });
        expect(withFolder.updatedAt >= project.updatedAt).toBe(true);
        expect(await store.getProject(project.id)).toEqual(withFolder);

        const changed = await store.updateProjectFolder(project.id, '/tmp/other');
        expect(changed).toMatchObject({ folderPath: '/tmp/other', folderRevision: 2 });

        const cleared = await store.updateProjectFolder(project.id, undefined);
        expect(cleared).toMatchObject({ folderPath: undefined, folderRevision: 3 });

        await expect(store.updateProjectFolder(project.id, 'relative')).rejects.toMatchObject({
          code: 'workspace-store-invalid-input',
        });
        await expect(store.updateProjectFolder('missing', '/tmp/x')).rejects.toMatchObject({
          code: 'workspace-project-not-found',
        });
        expect(await store.getProject(project.id)).toEqual(cleared);
      } finally {
        await cleanup();
      }
    });

    it('assigns new revisions to repeated and restored folder paths', async () => {
      const { store, cleanup } = await createStore();

      try {
        const project = await store.createProject({
          name: 'Weave',
          folderName: 'weave',
          folderPath: '/tmp/weave',
        });

        const repeated = await store.updateProjectFolder(project.id, '/tmp/weave');
        expect(repeated).toMatchObject({ folderPath: '/tmp/weave', folderRevision: 1 });
        const moved = await store.updateProjectFolder(project.id, '/tmp/other');
        expect(moved).toMatchObject({ folderPath: '/tmp/other', folderRevision: 2 });
        const restored = await store.updateProjectFolder(project.id, '/tmp/weave');
        expect(restored).toMatchObject({ folderPath: '/tmp/weave', folderRevision: 3 });
        await store.updateProjectFolder(project.id, undefined);
        expect(await store.updateProjectFolder(project.id, undefined)).toMatchObject({
          folderPath: undefined,
          folderRevision: 5,
        });
      } finally {
        await cleanup();
      }
    });

    it('renames a Project without changing its folder', async () => {
      const { store, cleanup } = await createStore();

      try {
        const project = await store.createProject({
          name: 'Weave',
          folderName: 'weave',
          folderPath: '/tmp/weave',
        });

        await store.updateProjectFolder(project.id, '/tmp/other');
        const renamed = await store.renameProject(project.id, 'Weave Studio');
        expect(renamed).toMatchObject({
          id: project.id,
          name: 'Weave Studio',
          folderName: 'weave',
          folderPath: '/tmp/other',
          folderRevision: 1,
        });
        expect(renamed.updatedAt >= project.updatedAt).toBe(true);
        expect((await store.getProject(project.id))?.name).toBe('Weave Studio');

        await expect(store.renameProject(project.id, '')).rejects.toMatchObject({
          code: 'workspace-store-invalid-input',
        });
        await expect(store.renameProject('missing', 'Other')).rejects.toMatchObject({
          code: 'workspace-project-not-found',
        });
        expect((await store.getProject(project.id))?.name).toBe('Weave Studio');
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
    await first.updateProjectFolder(project.id, '/tmp/weave-persisted');
    await first.close();

    const reopened = createSqliteProjectStore({ filename });
    expect(await reopened.getProject(project.id)).toMatchObject({
      id: project.id,
      name: 'Weave',
      folderName: 'weave',
      folderPath: '/tmp/weave-persisted',
      folderRevision: 1,
    });
    expect(await reopened.listSessionRefs(project.id)).toMatchObject([
      { projectId: project.id, sessionId: 'session-1' },
    ]);
    await reopened.close();
  });

  it('migrates legacy Projects without changing metadata, relations or Session facts', async () => {
    const filename = createTemporaryFilename();
    createLegacyProjectDatabase(filename);

    const store = createSqliteProjectStore({ filename });
    try {
      expect(await store.listProjects()).toEqual([
        {
          id: 'project-1',
          name: 'Weave Studio',
          folderName: 'weave',
          folderPath: '/tmp/weave',
          folderRevision: 0,
          createdAt: '2026-11-14T10:00:00.000Z',
          updatedAt: '2026-11-15T10:00:00.000Z',
        },
      ]);
      expect(await store.listSessionRefs('project-1')).toEqual([
        {
          projectId: 'project-1',
          sessionId: 'session-1',
          createdAt: '2026-11-15T10:00:00.000Z',
        },
      ]);
      await store.updateProjectFolder('project-1', '/tmp/weave');
    } finally {
      await store.close();
    }

    const reopened = createSqliteProjectStore({ filename });
    const reader = new DatabaseSync(filename);
    try {
      expect(await reopened.getProject('project-1')).toMatchObject({ folderRevision: 1 });
      expect(reader.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
      expect(reader.prepare('SELECT * FROM session_events').all()).toEqual([
        {
          session_id: 'session-1',
          sequence: 1,
          event_id: 'event-1',
          type: 'session.created',
          occurred_at: '2026-11-15T10:00:00.000Z',
          payload_json: '{}',
        },
      ]);
    } finally {
      reader.close();
      await reopened.close();
    }
  });

  it('rejects overflow before changing the stored folder, revision or timestamp', async () => {
    const filename = createTemporaryFilename();
    createLegacyProjectDatabase(filename);
    const database = new DatabaseSync(filename);
    try {
      database.exec('ALTER TABLE projects ADD COLUMN folder_revision INTEGER');
      database.prepare('UPDATE projects SET folder_revision = ?').run(Number.MAX_SAFE_INTEGER - 1);
    } finally {
      database.close();
    }

    const store = createSqliteProjectStore({ filename });
    try {
      const limit = await store.updateProjectFolder('project-1', '/tmp/last');
      expect(limit).toMatchObject({
        folderPath: '/tmp/last',
        folderRevision: Number.MAX_SAFE_INTEGER,
      });
      await expect(store.updateProjectFolder('project-1', '/tmp/overflow')).rejects.toMatchObject({
        code: 'workspace-project-folder-revision-overflow',
      });
      expect(await store.getProject('project-1')).toEqual(limit);
    } finally {
      await store.close();
    }
  });

  it.each([null, -1, 1.5, 9007199254740992n])(
    'rejects an invalid stored revision of %s before changing the folder',
    async (revision) => {
      const filename = createTemporaryFilename();
      createLegacyProjectDatabase(filename);
      const database = new DatabaseSync(filename);
      database.exec('ALTER TABLE projects ADD COLUMN folder_revision INTEGER');
      database.prepare('UPDATE projects SET folder_revision = ?').run(revision);
      const store = createSqliteProjectStore({ filename });
      try {
        await expect(store.getProject('project-1')).rejects.toMatchObject({
          code: 'workspace-store-protocol',
        });
        await expect(store.updateProjectFolder('project-1', '/tmp/other')).rejects.toMatchObject({
          code: 'workspace-store-protocol',
        });
        expect(database.prepare('SELECT folder_path FROM projects').get()).toEqual({
          folder_path: '/tmp/weave',
        });
      } finally {
        database.close();
        await store.close();
      }
    },
  );

  it('assigns distinct revisions to updates from separate SQLite connections', async () => {
    const filename = createTemporaryFilename();
    const first = createSqliteProjectStore({ filename });
    const second = createSqliteProjectStore({ filename });
    try {
      const project = await first.createProject({ name: 'Weave', folderName: 'weave' });
      const [withFolder, changed] = await Promise.all([
        first.updateProjectFolder(project.id, '/tmp/weave'),
        second.updateProjectFolder(project.id, '/tmp/other'),
      ]);
      expect(withFolder).toMatchObject({ folderPath: '/tmp/weave', folderRevision: 1 });
      expect(changed).toMatchObject({ folderPath: '/tmp/other', folderRevision: 2 });
      expect(await first.getProject(project.id)).toEqual(changed);
      expect(await second.getProject(project.id)).toEqual(changed);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
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
