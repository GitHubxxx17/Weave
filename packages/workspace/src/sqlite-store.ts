import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  createProjectInputSchema,
  projectFolderPathSchema,
  projectIdSchema,
  projectNameSchema,
  projectSchema,
  projectSessionIdSchema,
  projectSessionRefSchema,
  type CreateProjectInput,
  type Project,
  type ProjectSessionRef,
} from './types.js';
import {
  nextProjectFolderRevision,
  sqliteProjectStoreOptionsSchema,
  WorkspaceStoreError,
  type ProjectStore,
} from './store.js';

const folderRevisionDefinition = `INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(folder_revision) = 'integer' AND folder_revision BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER})`;

const createTablesSql = `
  CREATE TABLE IF NOT EXISTS projects (
    project_id TEXT NOT NULL PRIMARY KEY,
    name TEXT NOT NULL,
    folder_name TEXT NOT NULL,
    folder_path TEXT,
    folder_revision ${folderRevisionDefinition},
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS project_sessions (
    project_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, session_id),
    FOREIGN KEY (project_id) REFERENCES projects(project_id)
  );

  CREATE INDEX IF NOT EXISTS project_sessions_by_project
    ON project_sessions(project_id, created_at);
`;

const projectColumns =
  'project_id, name, folder_name, folder_path, folder_revision, created_at, updated_at';

const closedMessage = 'Workspace Project Store is closed';
const invalidInputMessage = 'Workspace Project Store input is invalid';
const ioMessage = 'Workspace Project Store database operation failed';
const protocolMessage = 'Workspace Project Store contains invalid persisted data';
const projectNotFoundMessage = 'Project does not exist';
const duplicateSessionMessage = 'Session is already attached to this Project';

interface ProjectRow {
  readonly project_id: unknown;
  readonly name: unknown;
  readonly folder_name: unknown;
  readonly folder_path: unknown;
  readonly folder_revision: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

interface ProjectSessionRow {
  readonly project_id: unknown;
  readonly session_id: unknown;
  readonly created_at: unknown;
}

function requireOpen(closed: boolean): void {
  if (closed) {
    throw new WorkspaceStoreError('workspace-store-closed', closedMessage);
  }
}

function invalidInput(): WorkspaceStoreError {
  return new WorkspaceStoreError('workspace-store-invalid-input', invalidInputMessage);
}

function projectNotFound(): WorkspaceStoreError {
  return new WorkspaceStoreError('workspace-project-not-found', projectNotFoundMessage);
}

function validateIds(projectIdInput: string, sessionIdInput?: string): void {
  if (
    !projectIdSchema.safeParse(projectIdInput).success ||
    (sessionIdInput !== undefined && !projectSessionIdSchema.safeParse(sessionIdInput).success)
  ) {
    throw invalidInput();
  }
}

function parseProject(row: Record<string, unknown>): Project {
  const stored: ProjectRow = {
    project_id: row.project_id,
    name: row.name,
    folder_name: row.folder_name,
    folder_path: row.folder_path,
    folder_revision: row.folder_revision,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };

  try {
    const parsed = projectSchema.parse({
      id: stored.project_id,
      name: stored.name,
      folderName: stored.folder_name,
      ...(stored.folder_path === null ? {} : { folderPath: stored.folder_path }),
      folderRevision:
        typeof stored.folder_revision === 'bigint'
          ? Number(stored.folder_revision)
          : stored.folder_revision,
      createdAt: stored.created_at,
      updatedAt: stored.updated_at,
    });
    return {
      ...parsed,
      folderPath: parsed.folderPath,
    };
  } catch (error) {
    throw new WorkspaceStoreError('workspace-store-protocol', protocolMessage, { cause: error });
  }
}

function readProject(database: DatabaseSync, projectId: string): Project | undefined {
  const statement = database.prepare(`SELECT ${projectColumns} FROM projects WHERE project_id = ?`);
  // Let the Project schema classify unsafe integers before Node's SQLite API rejects them.
  statement.setReadBigInts(true);
  const row = statement.get(projectId);
  return row === undefined ? undefined : parseProject(row);
}

function writeTransaction<T>(database: DatabaseSync, write: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = write();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Preserve the original Store or database error.
    }
    throw error;
  }
}

function migrateProjectSchema(database: DatabaseSync): void {
  writeTransaction(database, () => {
    database.exec(createTablesSql);
    // The shared database's user_version belongs to the Session store.
    const columns = database.prepare('PRAGMA table_info(projects)').all();
    if (!columns.some((column) => column.name === 'folder_revision')) {
      database.exec(`ALTER TABLE projects ADD COLUMN folder_revision ${folderRevisionDefinition}`);
    }
  });
}

function parseSessionRef(row: Record<string, unknown>): ProjectSessionRef {
  const stored: ProjectSessionRow = {
    project_id: row.project_id,
    session_id: row.session_id,
    created_at: row.created_at,
  };

  try {
    return projectSessionRefSchema.parse({
      projectId: stored.project_id,
      sessionId: stored.session_id,
      createdAt: stored.created_at,
    });
  } catch (error) {
    throw new WorkspaceStoreError('workspace-store-protocol', protocolMessage, { cause: error });
  }
}

/**
 * Creates a file-backed Project Store using Node's built-in SQLite API.
 */
export function createSqliteProjectStore(options: { readonly filename: string }): ProjectStore {
  const optionsResult = sqliteProjectStoreOptionsSchema.safeParse(options);
  if (!optionsResult.success) {
    throw invalidInput();
  }

  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(optionsResult.data.filename, { timeout: 5000 });
    migrateProjectSchema(database);
  } catch (error) {
    try {
      database?.close();
    } catch {
      // Preserve the original initialization error.
    }
    throw new WorkspaceStoreError('workspace-store-io', ioMessage, { cause: error });
  }

  let closed = false;

  return {
    async createProject(input: CreateProjectInput): Promise<Project> {
      requireOpen(closed);
      const parsed = createProjectInputSchema.safeParse(input);
      if (!parsed.success) {
        throw invalidInput();
      }

      const id = randomUUID();
      const now = new Date().toISOString();
      try {
        database
          .prepare(
            `INSERT INTO projects
              (${projectColumns})
             VALUES (?, ?, ?, ?, 0, ?, ?)`,
          )
          .run(
            id,
            parsed.data.name,
            parsed.data.folderName,
            parsed.data.folderPath ?? null,
            now,
            now,
          );
      } catch (error) {
        throw new WorkspaceStoreError('workspace-store-io', ioMessage, { cause: error });
      }

      return {
        id,
        name: parsed.data.name,
        folderName: parsed.data.folderName,
        folderPath: parsed.data.folderPath,
        folderRevision: 0,
        createdAt: now,
        updatedAt: now,
      };
    },

    async listProjects(): Promise<readonly Project[]> {
      requireOpen(closed);
      try {
        const statement = database.prepare(
          `SELECT ${projectColumns} FROM projects ORDER BY created_at ASC, rowid ASC`,
        );
        statement.setReadBigInts(true);
        return statement.all().map(parseProject);
      } catch (error) {
        if (error instanceof WorkspaceStoreError) {
          throw error;
        }
        throw new WorkspaceStoreError('workspace-store-io', ioMessage, { cause: error });
      }
    },

    async getProject(projectIdInput: string): Promise<Project | undefined> {
      requireOpen(closed);
      validateIds(projectIdInput);
      try {
        return readProject(database, projectIdInput);
      } catch (error) {
        if (error instanceof WorkspaceStoreError) {
          throw error;
        }
        throw new WorkspaceStoreError('workspace-store-io', ioMessage, { cause: error });
      }
    },

    async updateProjectFolder(
      projectIdInput: string,
      folderPathInput: string | undefined,
    ): Promise<Project> {
      requireOpen(closed);
      validateIds(projectIdInput);
      const parsed = projectFolderPathSchema.optional().safeParse(folderPathInput);
      if (!parsed.success) {
        throw invalidInput();
      }
      try {
        const connection = database;
        return writeTransaction(connection, () => {
          const project = readProject(connection, projectIdInput);
          if (project === undefined) {
            throw projectNotFound();
          }
          const folderRevision = nextProjectFolderRevision(project.folderRevision);
          const updatedAt = new Date().toISOString();
          const result = connection
            .prepare(
              `UPDATE projects SET folder_path = ?, folder_revision = ?, updated_at = ?
               WHERE project_id = ?`,
            )
            .run(parsed.data ?? null, folderRevision, updatedAt, projectIdInput);
          if (result.changes === 0) {
            throw projectNotFound();
          }
          return { ...project, folderPath: parsed.data, folderRevision, updatedAt };
        });
      } catch (error) {
        if (error instanceof WorkspaceStoreError) {
          throw error;
        }
        throw new WorkspaceStoreError('workspace-store-io', ioMessage, { cause: error });
      }
    },

    async renameProject(projectIdInput: string, nameInput: string): Promise<Project> {
      requireOpen(closed);
      validateIds(projectIdInput);
      if (!projectNameSchema.safeParse(nameInput).success) {
        throw invalidInput();
      }
      try {
        const result = database
          .prepare('UPDATE projects SET name = ?, updated_at = ? WHERE project_id = ?')
          .run(nameInput, new Date().toISOString(), projectIdInput);
        if (result.changes === 0) {
          throw projectNotFound();
        }
        const project = readProject(database, projectIdInput);
        if (project === undefined) {
          throw projectNotFound();
        }
        return project;
      } catch (error) {
        if (error instanceof WorkspaceStoreError) {
          throw error;
        }
        throw new WorkspaceStoreError('workspace-store-io', ioMessage, { cause: error });
      }
    },

    async attachSession(
      projectIdInput: string,
      sessionIdInput: string,
    ): Promise<ProjectSessionRef> {
      requireOpen(closed);
      validateIds(projectIdInput, sessionIdInput);

      let transactionStarted = false;
      try {
        database.exec('BEGIN IMMEDIATE');
        transactionStarted = true;

        const projectRow = database
          .prepare('SELECT project_id FROM projects WHERE project_id = ?')
          .get(projectIdInput);
        if (projectRow === undefined) {
          throw projectNotFound();
        }

        const existing = database
          .prepare(
            `SELECT project_id, session_id, created_at
             FROM project_sessions
             WHERE project_id = ? AND session_id = ?`,
          )
          .get(projectIdInput, sessionIdInput);
        if (existing !== undefined) {
          throw new WorkspaceStoreError(
            'workspace-session-already-attached',
            duplicateSessionMessage,
          );
        }

        const relation: ProjectSessionRef = {
          projectId: projectIdInput,
          sessionId: sessionIdInput,
          createdAt: new Date().toISOString(),
        };
        database
          .prepare(
            `INSERT INTO project_sessions (project_id, session_id, created_at)
             VALUES (?, ?, ?)`,
          )
          .run(relation.projectId, relation.sessionId, relation.createdAt);
        database.exec('COMMIT');
        transactionStarted = false;
        return relation;
      } catch (error) {
        if (transactionStarted) {
          try {
            database.exec('ROLLBACK');
          } catch {
            // Preserve the original Store or database error.
          }
        }
        if (error instanceof WorkspaceStoreError) {
          throw error;
        }
        throw new WorkspaceStoreError('workspace-store-io', ioMessage, { cause: error });
      }
    },

    async listSessionRefs(projectIdInput: string): Promise<readonly ProjectSessionRef[]> {
      requireOpen(closed);
      validateIds(projectIdInput);
      try {
        const projectRow = database
          .prepare('SELECT project_id FROM projects WHERE project_id = ?')
          .get(projectIdInput);
        if (projectRow === undefined) {
          throw projectNotFound();
        }

        const rows = database
          .prepare(
            `SELECT project_id, session_id, created_at
             FROM project_sessions
             WHERE project_id = ?
             ORDER BY created_at ASC, rowid ASC`,
          )
          .all(projectIdInput);
        return rows.map((row) => parseSessionRef(row));
      } catch (error) {
        if (error instanceof WorkspaceStoreError) {
          throw error;
        }
        throw new WorkspaceStoreError('workspace-store-io', ioMessage, { cause: error });
      }
    },

    async close(): Promise<void> {
      if (closed) {
        return;
      }

      closed = true;
      try {
        database.close();
      } catch (error) {
        throw new WorkspaceStoreError('workspace-store-io', ioMessage, { cause: error });
      }
    },
  };
}

export { z };
