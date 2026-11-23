import { randomUUID } from 'node:crypto';
import {
  createProjectInputSchema,
  projectFolderPathSchema,
  projectIdSchema,
  projectNameSchema,
  projectSessionIdSchema,
  type CreateProjectInput,
  type Project,
  type ProjectSessionRef,
} from './types.js';
import {
  nextProjectFolderRevision,
  WorkspaceStoreError,
  type ProjectStore,
  type WorkspaceStoreErrorCode,
} from './store.js';

const closedMessage = 'Workspace Project Store is closed';
const invalidInputMessage = 'Workspace Project Store input is invalid';
const projectNotFoundMessage = 'Project does not exist';
const duplicateSessionMessage = 'Session is already attached to this Project';

function clone<T>(value: T): T {
  return structuredClone(value);
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

function sortByCreatedAt<T extends { readonly createdAt: string }>(values: readonly T[]): T[] {
  return [...values].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/**
 * Creates an isolated in-memory Project Store for tests and local composition.
 */
export function createInMemoryProjectStore(): ProjectStore {
  const projects = new Map<string, Project>();
  const sessionRefs = new Map<string, ProjectSessionRef[]>();
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
      const project: Project = {
        id,
        name: parsed.data.name,
        folderName: parsed.data.folderName,
        folderPath: parsed.data.folderPath,
        folderRevision: 0,
        createdAt: now,
        updatedAt: now,
      };
      projects.set(id, project);
      sessionRefs.set(id, []);
      return clone(project);
    },

    async listProjects(): Promise<readonly Project[]> {
      requireOpen(closed);
      return sortByCreatedAt([...projects.values()]).map(clone);
    },

    async getProject(projectIdInput: string): Promise<Project | undefined> {
      requireOpen(closed);
      validateIds(projectIdInput);
      const project = projects.get(projectIdInput);
      return project === undefined ? undefined : clone(project);
    },

    async updateProjectFolder(
      projectIdInput: string,
      folderPathInput: string | undefined,
    ): Promise<Project> {
      requireOpen(closed);
      validateIds(projectIdInput);
      if (!projectFolderPathSchema.optional().safeParse(folderPathInput).success) {
        throw invalidInput();
      }
      const project = projects.get(projectIdInput);
      if (project === undefined) {
        throw projectNotFound();
      }
      const updated: Project = {
        ...project,
        folderPath: folderPathInput,
        folderRevision: nextProjectFolderRevision(project.folderRevision),
        updatedAt: new Date().toISOString(),
      };
      projects.set(projectIdInput, updated);
      return clone(updated);
    },

    async renameProject(projectIdInput: string, nameInput: string): Promise<Project> {
      requireOpen(closed);
      validateIds(projectIdInput);
      if (!projectNameSchema.safeParse(nameInput).success) {
        throw invalidInput();
      }
      const project = projects.get(projectIdInput);
      if (project === undefined) {
        throw projectNotFound();
      }
      const updated: Project = {
        ...project,
        name: nameInput,
        updatedAt: new Date().toISOString(),
      };
      projects.set(projectIdInput, updated);
      return clone(updated);
    },

    async attachSession(
      projectIdInput: string,
      sessionIdInput: string,
    ): Promise<ProjectSessionRef> {
      requireOpen(closed);
      validateIds(projectIdInput, sessionIdInput);
      if (!projects.has(projectIdInput)) {
        throw projectNotFound();
      }

      const existing = sessionRefs.get(projectIdInput) ?? [];
      if (existing.some((ref) => ref.sessionId === sessionIdInput)) {
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
      sessionRefs.set(projectIdInput, [...existing, relation]);
      return clone(relation);
    },

    async listSessionRefs(projectIdInput: string): Promise<readonly ProjectSessionRef[]> {
      requireOpen(closed);
      validateIds(projectIdInput);
      if (!projects.has(projectIdInput)) {
        throw projectNotFound();
      }

      return sortByCreatedAt(sessionRefs.get(projectIdInput) ?? []).map(clone);
    },

    async close(): Promise<void> {
      closed = true;
      projects.clear();
      sessionRefs.clear();
    },
  };
}

export type { WorkspaceStoreErrorCode };
