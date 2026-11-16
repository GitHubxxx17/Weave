import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  createProjectInputSchema,
  projectIdSchema,
  projectSchema,
  projectSessionIdSchema,
  projectSessionRefSchema,
  type CreateProjectInput,
  type Project,
  type ProjectSessionRef,
} from './types.js';
import {
  sqliteProjectStoreOptionsSchema,
  WorkspaceStoreError,
  type ProjectStore,
} from './store.js';

const createTablesSql = `
  CREATE TABLE IF NOT EXISTS projects (
    project_id TEXT NOT NULL PRIMARY KEY,
    name TEXT NOT NULL,
    folder_name TEXT NOT NULL,
    folder_path TEXT,
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
    created_at: row.created_at,
    updated_at: row.updated_at,
  };

  try {
    const parsed = projectSchema.parse({
      id: stored.project_id,
      name: stored.name,
      folderName: stored.folder_name,
      ...(stored.folder_path === null ? {} : { folderPath: stored.folder_path }),
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

  let database: DatabaseSync;
  try {
    database = new DatabaseSync(optionsResult.data.filename);
    database.exec(createTablesSql);
  } catch (error) {
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
              (project_id, name, folder_name, folder_path, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
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
        createdAt: now,
        updatedAt: now,
      };
    },

    async listProjects(): Promise<readonly Project[]> {
      requireOpen(closed);
      try {
        const rows = database
          .prepare(
            `SELECT project_id, name, folder_name, folder_path, created_at, updated_at
             FROM projects
             ORDER BY created_at ASC, project_id ASC`,
          )
          .all();
        return rows.map((row) => parseProject(row));
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
        const row = database
          .prepare(
            `SELECT project_id, name, folder_name, folder_path, created_at, updated_at
             FROM projects
             WHERE project_id = ?`,
          )
          .get(projectIdInput);
        return row === undefined ? undefined : parseProject(row);
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
             ORDER BY created_at ASC, session_id ASC`,
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
